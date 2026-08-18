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
 *
 * IT IS FIXED TO A CORNER, AND THAT IS A CORRECTNESS RULE RATHER THAN A TASTE.
 * This element's text changes on every keystroke of a capture: `saveAnswers`
 * flips the row from `synced` back to `queued` and pushes, `pushOutbox` sets it
 * to `synced` again, and the live query below sees both. So the pending count
 * and the "Send now" button appear and vanish several times a second while
 * somebody types. While this lived in `.shell__identity` — a flex child of the
 * sticky, content-height header — each of those flips changed the header's
 * height and shoved the whole page up and down, on the app's most-used screen.
 * Anything whose content updates per keystroke must be OUT of the document flow.
 * Do not move it back into the header, and do not give it a width transition.
 */
export function SyncStatusBadge() {
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

  // No `role="status"` and no `aria-live`, deliberately. A polite live region on
  // an element that rewrites itself per keystroke would read a fresh sentence
  // for every letter typed — worse for a screen-reader user than the layout
  // shift was for a sighted one. The stranded block below keeps `role="alert"`
  // because that state is a property of the BUILD and announces once; and
  // /sync-health remains the readable, unhurried account of the same numbers.
  return (
    <div className={`syncbadge${stranded ? ' syncbadge--stranded' : ''}`}>
      <div className="syncbadge__line">
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
        <div className="banner warn syncbadge__alert" role="alert">
          <Copy id="sync.stranded" />
        </div>
      )}
    </div>
  )
}
