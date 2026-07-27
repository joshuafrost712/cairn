import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { pushReferenceOutbox, upsertActivity, upsertKsa, upsertWorkshop } from '../db/referenceWrite'
import type { Activity, Ksa, Workshop } from '../lib/types'
import { isFeedbackEnabled } from './enabled'
import { fdb, resolveProposal, type ContentProposal } from './db'
import { logAppliedEdit } from './applyEdit'
import { loadRefRow, readRefField, refFieldLabel, writeRefField } from './refField'

/**
 * Review and approve proposed wording changes to reference copy.
 *
 * Reference text is read live from Supabase by every evaluator's device, so an
 * edit made while a session is running would reword a question underneath someone
 * mid-capture. Proposals are the staging step, and this is where they are applied.
 *
 * Applying goes through db/referenceWrite.ts rather than calling Supabase
 * directly. Those helpers write the Dexie cache and queue the backend upsert in
 * `referenceOutbox`, which loadReferenceData() drains BEFORE its destructive pull
 * and which blocks that overwrite while anything is pending. Writing to Supabase
 * from here would work online and silently lose the edit offline.
 *
 * Dev-gated, like the rest of src/devfeedback: it renders nothing for evaluators.
 */
export function ProposalPanel() {
  const enabled = isFeedbackEnabled()
  const pending = useLiveQuery(
    () => (enabled ? fdb.proposals.where('status').equals('pending').toArray() : []),
    [enabled],
    [] as ContentProposal[],
  )
  // Applied proposals stay listed. On a deployed build reached with ?dev=1 there is
  // no dev server, so the /__content-log git record cannot be written — this list is
  // then the ONLY surviving before/after for a change that is already live for every
  // evaluator. Hiding it would make that edit unrecoverable.
  const applied = useLiveQuery(
    () => (enabled ? fdb.proposals.where('status').equals('applied').reverse().sortBy('resolvedAt') : []),
    [enabled],
    [] as ContentProposal[],
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  if (!enabled) return null

  const apply = async (p: ContentProposal) => {
    setBusy(p.id)
    setNotice('')
    try {
      const row = await loadRefRow(p.table, p.rowId)
      if (!row) {
        setNotice(`That ${p.table} record is no longer on this device. Nothing applied.`)
        return
      }
      // Staleness guard, the same contract the chrome endpoint enforces with a 409:
      // if the stored text moved since the proposal was made, refuse rather than
      // overwrite whatever replaced it.
      const current = readRefField(row, p.field)
      if (current !== p.oldText) {
        setNotice(
          'This text changed since the proposal was made, so it was not applied. Reject it and redo the edit against the current wording.',
        )
        return
      }

      const next = writeRefField(row, p.field, p.newText)
      if (p.table === 'ksa') await upsertKsa(next as Ksa)
      else if (p.table === 'activity') await upsertActivity(next as Activity)
      else await upsertWorkshop(next as Workshop)

      await resolveProposal(p.id, 'applied')

      // Drain the outbox and report what actually happened. upsertKsa ends in a
      // fire-and-forget push whose only failure signal is a console warning, so
      // reporting "queued for sync" unconditionally would repeat the widget's own
      // invariant #1 mistake (never claim success you did not observe). A stuck
      // entry matters more here than usual: loadReferenceData() skips its pull
      // entirely while anything is pending, so a permanently failing push freezes
      // ALL reference updates on this device until it clears.
      let sync = ''
      try {
        const { pending: stillPending } = await pushReferenceOutbox()
        sync = stillPending > 0 ? ` ${stillPending} change(s) still waiting to sync.` : ' Synced.'
      } catch {
        sync = ' Not synced yet; it stays queued and retries.'
      }

      // Best-effort git record; the write above already happened either way.
      const logged = await logAppliedEdit({
        table: p.table,
        rowId: p.rowId,
        field: p.field,
        oldText: p.oldText,
        newText: p.newText,
      })
      setNotice(
        (logged
          ? 'Applied, and recorded in feedback/content-edits/.'
          : 'Applied. No dev server, so it was NOT recorded to file — the before/after is kept below only on this device, and seed.ts needs reconciling by hand.') + sync,
      )
    } catch (err) {
      // Without this the rejection escapes the click handler: the button re-enables,
      // no message appears, and the proposal is left in whatever state the throw
      // interrupted — which allows the same edit to be applied twice.
      setNotice(`Could not apply that change: ${String(err)}. It is still pending; try again.`)
    } finally {
      setBusy(null)
    }
  }

  const reject = async (p: ContentProposal) => {
    setBusy(p.id)
    try {
      await resolveProposal(p.id, 'rejected')
    } catch (err) {
      setNotice(`Could not reject that change: ${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <h2>Proposed wording changes ({pending.length})</h2>
      <p className="small muted">
        Edits made in place against live reference text. Nothing here has changed what evaluators
        see; approving is what applies it and queues it for sync.
      </p>

      {notice && <p className="banner">{notice}</p>}

      {pending.length === 0 ? (
        <p className="muted small">None pending.</p>
      ) : (
        pending.map((p) => (
          <div key={p.id} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
            <div className="small muted">
              {p.table} · {refFieldLabel(p.field)} · {p.locationLabel}
            </div>
            <div className="small" style={{ marginTop: '0.25rem', textDecoration: 'line-through', opacity: 0.7 }}>
              {p.oldText}
            </div>
            <div className="small" style={{ marginTop: '0.25rem', fontWeight: 600 }}>
              {p.newText}
            </div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button className="primary" disabled={busy === p.id} onClick={() => apply(p)}>
                {busy === p.id ? 'Applying…' : 'Approve'}
              </button>
              <button className="ghost" disabled={busy === p.id} onClick={() => reject(p)}>
                Reject
              </button>
            </div>
          </div>
        ))
      )}

      {applied.length > 0 && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary className="small muted">Applied ({applied.length})</summary>
          <p className="small muted">
            Already live. Kept here as the on-device record of what changed, which is the only
            copy when the change was approved without a dev server running.
          </p>
          {applied.map((p) => (
            <div key={p.id} className="small" style={{ marginTop: '0.4rem' }}>
              <span className="muted">
                {p.table} · {refFieldLabel(p.field)} ·{' '}
                {p.resolvedAt ? new Date(p.resolvedAt).toLocaleString() : ''}
              </span>
              <div style={{ textDecoration: 'line-through', opacity: 0.7 }}>{p.oldText}</div>
              <div style={{ fontWeight: 600 }}>{p.newText}</div>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
