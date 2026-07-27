import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import type { Activity, EvaluationRecord, SyncStatus } from '../lib/types'

const statusLabel = (s: SyncStatus): string => c(`myeval.status.${s}`)

export function MyEvaluations() {
  const evals = useLiveQuery(
    () => db.evaluations.orderBy('updated_at').reverse().toArray(),
    [],
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
      {(evals ?? []).map((e) => (
        <Link key={e.client_id} to={`/capture/${e.client_id}`} className="activity-item">
          <span>
            <strong>{titleFor(e.activity_id)}</strong>
            <br />
            <span className="muted small">
              {e.participant_scope.map((s) => s.name).join(', ') || c('myeval.no-one-tagged')} ·{' '}
              {new Date(e.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </span>
          <span className={`pill ${e.sync_status}`}>{statusLabel(e.sync_status)}</span>
        </Link>
      ))}
    </>
  )
}
