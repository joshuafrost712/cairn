import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { syncNow } from '../db/sync'
import { isSupabaseConfigured } from '../lib/supabase'
import { summarizePending } from '../reports/syncHealth'
import { c } from '../lib/content/chrome'
import { Copy } from './Copy'
import { useOnline } from './useOnline'

/**
 * What this device is still holding, said plainly (tl-18).
 *
 * The old version counted pending evaluations only and rendered "local-only" in
 * muted grey when the build had no backend compiled into it. Both halves of that
 * were the bug: an installed PWA built without the Supabase variables could not
 * send anything at all, and its entire account of the situation was two grey
 * words next to a green dot. Months of phone evaluations never counted, and
 * nothing on the screen was wrong enough to notice.
 *
 * So: all three queues, the age of the oldest item, and a real warning when the
 * app cannot send. No backend vocabulary — an evaluator is told their work has
 * not been sent, not that a Supabase push failed (tl-03's copy rule).
 */
export function SyncStatusBar() {
  const online = useOnline()
  const pending = useLiveQuery(
    async () => {
      const [evaluations, observations, verdicts] = await Promise.all([
        db.evaluations.where('sync_status').anyOf('local', 'queued', 'error').toArray(),
        db.observations.where('sync_status').anyOf('local', 'queued', 'error').toArray(),
        db.verifications.where('sync_status').anyOf('local', 'queued', 'error').toArray(),
      ])
      return summarizePending({ evaluations, observations, verdicts }, isSupabaseConfigured, Date.now())
    },
    [],
    null,
  )

  const total = pending?.total ?? 0
  const stranded = pending?.stranded ?? false

  return (
    <>
      <div className="row small">
        <span className={`offline-dot ${online ? 'on' : 'off'}`} aria-hidden />
        <span className="muted">{online ? c('sync.online') : c('sync.offline')}</span>
        {total > 0 && (
          <>
            <span className={stranded ? '' : 'muted'}>
              ·{' '}
              {pending?.oldestAge
                ? c('sync.pending-with-age', 'label', { count: total, age: pending.oldestAge })
                : c('sync.pending', 'label', { count: total })}
            </span>
            {online && isSupabaseConfigured && (
              <Copy as="button" id="sync.send-now" className="ghost small" onClick={() => void syncNow()} />
            )}
          </>
        )}
      </div>
      {stranded && (
        <div className="banner warn" role="alert">
          <Copy id="sync.stranded" />
        </div>
      )}
    </>
  )
}
