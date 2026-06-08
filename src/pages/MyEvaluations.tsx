import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import type { Activity, EvaluationRecord, SyncStatus } from '../lib/types'

const statusLabel: Record<SyncStatus, string> = {
  local: 'draft',
  queued: 'to sync',
  synced: 'synced',
  error: 'sync error',
}

export function MyEvaluations() {
  const evals = useLiveQuery(
    () => db.evaluations.orderBy('updated_at').reverse().toArray(),
    [],
    [] as EvaluationRecord[],
  )
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const titleFor = (id: string | null) =>
    activities?.find((a) => a.id === id)?.title ?? 'Activity'

  return (
    <main>
      <div className="card">
        <h1>My evaluations</h1>
        <p className="muted small">Everything captured on this device. Tap one to edit or correct it.</p>
      </div>
      {(evals ?? []).length === 0 && (
        <div className="banner info">No evaluations yet. Start one from the home screen.</div>
      )}
      {(evals ?? []).map((e) => (
        <Link key={e.client_id} to={`/capture/${e.client_id}`} className="activity-item">
          <span>
            <strong>{titleFor(e.activity_id)}</strong>
            <br />
            <span className="muted small">
              {e.participant_scope.map((s) => s.name).join(', ') || 'No one tagged'} ·{' '}
              {new Date(e.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </span>
          <span className={`pill ${e.sync_status}`}>{statusLabel[e.sync_status]}</span>
        </Link>
      ))}
    </main>
  )
}
