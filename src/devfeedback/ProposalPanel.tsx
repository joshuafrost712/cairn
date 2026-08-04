import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { isFeedbackEnabled } from './enabled'
import { fdb, resolveProposal, type ContentProposal } from './db'
import { applyProposal } from './applyProposal'
import { refFieldLabel } from './refField'

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
      // One apply path, shared with the Setup templates section (tl-16). The staleness
      // check, the offline-first write, the outbox drain and the git log all live in
      // applyProposal.ts; this handler is the dev-mode surface over it. Keeping a second
      // copy here is what would have let one of the two lose a fix.
      const outcome = await applyProposal(p)
      if (outcome.code === 'missing') {
        setNotice(`That ${p.table} record is no longer on this device. Nothing applied.`)
        return
      }
      if (outcome.code === 'stale') {
        setNotice(
          'This text changed since the proposal was made, so it was not applied. Reject it and redo the edit against the current wording.',
        )
        return
      }
      if (outcome.code === 'invalid') {
        setNotice(
          `This build will not accept that text (${outcome.problem?.code ?? 'refused'}). Reject it and redo the edit.`,
        )
        return
      }

      // Report what actually happened rather than "queued for sync": the push ends in a
      // fire-and-forget whose only failure signal is a console warning, and a stuck entry
      // matters more here than usual — loadReferenceData() skips its pull entirely while
      // anything is pending, so a permanently failing push freezes ALL reference updates
      // on this device until it clears.
      const sync = outcome.syncFailed
        ? ' Not synced yet; it stays queued and retries.'
        : (outcome.stillPending ?? 0) > 0
          ? ` ${outcome.stillPending} change(s) still waiting to sync.`
          : ' Synced.'
      setNotice(
        (outcome.logged
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
