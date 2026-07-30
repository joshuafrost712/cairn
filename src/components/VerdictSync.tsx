import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { isSupabaseConfigured } from '../lib/supabase'
import { pushVerdicts, pushObservations, pullObservations, pullVerdicts } from '../db/sync'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import type { VerificationVerdict } from '../lib/types'

// Verdict sync, evaluator-facing. Since tl-04 this shows STATE rather than
// offering a mechanism: verdicts and observations move through the backend on the
// app's own 30-second loop, so there is nothing here an evaluator has to operate
// and nothing about a repo or a token for them to read. The button is a "now,
// please", not a requirement.
//
// The GitHub path this component used to carry is the no-backend fallback and
// lives on /admin/routing. It is deliberately not reachable from this screen.
export function VerdictSync({ evaluatorEmail }: { evaluatorEmail: string }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const mine = (v: VerificationVerdict) =>
    v.evaluator_email.trim().toLowerCase() === evaluatorEmail.trim().toLowerCase()

  const waiting = useLiveQuery(
    async () => (await db.verifications.toArray()).filter((v) => mine(v) && v.sync_status !== 'synced').length,
    [evaluatorEmail],
    0,
  )
  const failed = useLiveQuery(
    async () =>
      (await db.verifications.toArray()).filter((v) => mine(v) && v.sync_status === 'error'),
    [evaluatorEmail],
    [] as VerificationVerdict[],
  )
  const withdrawing = useLiveQuery(() => db.verdictTombstones.count(), [], 0)

  // A verdict whose observation has not arrived yet is real work that is not
  // displayable, and the spec asks for it to be tolerated rather than dropped.
  // Tolerated silently would be indistinguishable from lost, so it is counted.
  const orphaned = useLiveQuery(
    async () => {
      const ids = new Set(await db.observations.toCollection().primaryKeys())
      return (await db.verifications.toArray()).filter((v) => !ids.has(v.observation_id)).length
    },
    [],
    0,
  )

  const run = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const up = await pushVerdicts()
      await pushObservations()
      const workshops = await db.workshops.toArray()
      let pulled = 0
      let verdicts = 0
      for (const w of workshops) {
        pulled += (await pullObservations(w.id)).pulled
        verdicts += (await pullVerdicts(w.id)).pulled
      }
      setMsg(c('verdictsync.result', 'label', { sent: up.pushed, observations: pulled, verdicts }))
    } catch (err) {
      setMsg(`${c('verdictsync.failed')} ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="card">
        <Copy id="verdictsync.title" as="strong" />
        <Copy id="verdictsync.local-only" as="p" className="small muted" />
      </div>
    )
  }

  const pending = (waiting ?? 0) + (withdrawing ?? 0)

  return (
    <div className="card">
      <div className="row">
        <Copy id="verdictsync.title" as="strong" />
        <span className="spacer" />
        <span className={`pill ${pending === 0 ? 'synced' : 'queued'}`}>
          {pending === 0 ? c('verdictsync.all-shared') : c('verdictsync.pending', 'label', { n: pending })}
        </span>
      </div>
      <Copy id="verdictsync.intro" as="p" className="small muted" />

      {(orphaned ?? 0) > 0 && (
        <Copy id="verdictsync.orphaned" tokens={{ n: orphaned ?? 0 }} className="small muted" as="p" />
      )}

      {(failed ?? []).length > 0 && (
        <div className="banner warn">
          <Copy id="verdictsync.error-lead" tokens={{ n: (failed ?? []).length }} />{' '}
          <span className="mono small">{(failed ?? [])[0]?.sync_error}</span>
        </div>
      )}

      <button className="ghost small" disabled={busy} onClick={() => void run()}>
        {busy ? c('verdictsync.syncing') : c('verdictsync.now')}
      </button>

      {msg && <div className="banner">{msg}</div>}
    </div>
  )
}
