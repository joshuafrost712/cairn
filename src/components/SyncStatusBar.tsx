import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { pushOutbox } from '../db/sync'
import { isSupabaseConfigured } from '../lib/supabase'
import { useOnline } from './useOnline'

/** Compact status: online state + how many captures are waiting to sync. */
export function SyncStatusBar() {
  const online = useOnline()
  const pending = useLiveQuery(
    () => db.evaluations.where('sync_status').anyOf('local', 'queued', 'error').count(),
    [],
    0,
  )

  return (
    <div className="row small">
      <span className={`offline-dot ${online ? 'on' : 'off'}`} aria-hidden />
      <span className="muted">{online ? 'Online' : 'Offline'}</span>
      {!isSupabaseConfigured && <span className="muted">· local-only</span>}
      {pending > 0 && (
        <>
          <span className="muted">· {pending} to sync</span>
          {online && isSupabaseConfigured && (
            <button className="ghost small" onClick={() => void pushOutbox()}>
              Sync now
            </button>
          )}
        </>
      )}
    </div>
  )
}
