import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { myCaptures } from '../db/evaluations'
import { useAuth } from '../auth/AuthContext'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import type { Activity, EvaluationRecord, SyncStatus } from '../lib/types'

const statusLabel = (s: SyncStatus): string => c(`myeval.status.${s}`)

export function MyEvaluations() {
  const { identity } = useAuth()
  const email = identity?.email ?? null
  // Filtered to the signed-in evaluator since tl-03: an administrator's device now
  // also holds every colleague's submitted capture, pulled down so it can be
  // routed. See myCaptures.
  const evals = useLiveQuery(
    async () => myCaptures(await db.evaluations.orderBy('updated_at').reverse().toArray(), email),
    [email],
    [] as EvaluationRecord[],
  )
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const titleFor = (id: string | null) =>
    activities?.find((a) => a.id === id)?.title ?? c('capture.activity-fallback')

  return (
    <>
      <div className="card">
        <Copy id="myeval.title" as="h1" />
        <Copy id="myeval.intro" as="p" className="muted small" />
      </div>
      {(evals ?? []).length === 0 && <Copy id="myeval.empty" as="div" className="banner info" />}
      {/* Headlined by the person, not by the session, since the Bali report. The
          session title on top meant the row of the capture you had just submitted
          read as "the session you are in", so an evaluator wanting the next person
          opened it and typed over work that was already filed. The person's name is
          what tells you which of two rows for one session you are looking at.

          The state pill is separate from the sync pill because they are different
          claims. "synced" says the server has it; "submitted" says the evaluator
          finished it. A row can be synced and unsubmitted. */}
      {(evals ?? []).map((e) => (
        <Link key={e.client_id} to={`/capture/${e.client_id}`} className="activity-item">
          <span>
            <strong>{e.participant_scope.map((s) => s.name).join(', ') || c('myeval.no-one-tagged')}</strong>
            <br />
            <span className="muted small">
              {titleFor(e.activity_id)} ·{' '}
              {new Date(e.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </span>
          <span className="row" style={{ gap: '0.35rem' }}>
            <span className={`pill ${e.attestation ? 'submitted' : 'unsubmitted'}`}>
              {c(e.attestation ? 'myeval.state.submitted' : 'myeval.state.unsubmitted')}
            </span>
            <span className={`pill ${e.sync_status}`}>{statusLabel(e.sync_status)}</span>
          </span>
        </Link>
      ))}
    </>
  )
}
