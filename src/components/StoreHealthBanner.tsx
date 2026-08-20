import { useSyncExternalStore } from 'react'
import { getDbFault, subscribeDbFault } from '../db/local'
import { getReferenceStalled, subscribeReferenceStalled } from '../db/reference'
import { c } from '../lib/content/chrome'

/**
 * Says out loud that the on-device store is not answering (2026-08-20).
 *
 * The incident this comes from: every list in the app went empty on one device
 * and stayed empty for two days, while the server held all of the work. Nothing on
 * screen said anything was wrong, because nothing was wrong in the way the UI knows
 * how to render. Pages read Dexie through `useLiveQuery` with an empty default, so
 * "the database never opened" and "you have captured nothing" produce the same
 * screen, and they are opposites.
 *
 * Three states, each with a different action for the person reading it:
 *
 *   blocked  — another tab holds an older version of the database, so `open()`
 *              waits forever rather than failing. Closing the other tab fixes it,
 *              and there is no way to guess that.
 *   failed   — the database could not be opened at all. Nothing on this device is
 *              readable, so nothing on screen can be trusted as complete.
 *   stalled  — the store is fine, but a queued setup edit is holding back the
 *              refresh, so the roster and questions on screen may be behind the
 *              server. Work still saves.
 *
 * Deliberately not a modal and deliberately not a blocker. A stalled cache is
 * still a working capture device, and an evaluator mid-observation should be told,
 * not interrupted.
 */
export function StoreHealthBanner() {
  const fault = useSyncExternalStore(subscribeDbFault, getDbFault, () => null)
  const stalled = useSyncExternalStore(
    subscribeReferenceStalled,
    getReferenceStalled,
    () => 0,
  )

  if (fault?.kind === 'blocked') {
    return (
      <div className="banner warn" role="status">
        {c('store.blocked')}
      </div>
    )
  }

  if (fault?.kind === 'failed') {
    return (
      <div className="banner error" role="alert">
        {c('store.failed')}{' '}
        <span className="muted small">
          ({fault.name}: {fault.message})
        </span>
      </div>
    )
  }

  if (stalled > 0) {
    return (
      <div className="banner warn" role="status">
        {c('store.stalled', 'label', { count: stalled })}
      </div>
    )
  }

  return null
}
