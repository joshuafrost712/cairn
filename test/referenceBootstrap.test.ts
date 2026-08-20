import { describe, it, expect } from 'vitest'
import { shouldSkipReferencePull } from '../src/db/reference'
import { isSetAside, MAX_PUSH_ATTEMPTS } from '../src/db/referenceWrite'
import { findChromeNode } from '../src/lib/content/chrome'
import type { ReferenceOutboxEntry } from '../src/lib/types'

/**
 * The 2026-08-20 lockout, as arithmetic.
 *
 * One device served empty lists for two days while the server held every row.
 * The cause was a rule that is correct in the case it was written for and fatal
 * in the case nobody tested: `loadReferenceData()` skips its destructive pull
 * whenever the reference outbox has a pending entry, in order to protect unsynced
 * local authoring. With an EMPTY cache there is no authoring to protect, and
 * skipping is unrecoverable rather than merely conservative, because every pull in
 * `syncNow()` iterates `db.workshops` and therefore does nothing at all once that
 * table is empty.
 *
 * These are the two halves: the guard still guards, and the bootstrap still boots.
 */
describe('shouldSkipReferencePull', () => {
  it('pulls when nothing is queued', () => {
    expect(shouldSkipReferencePull({ pending: 0, cachedWorkshops: 2 })).toBe(false)
  })

  it('skips the destructive pull while local authoring is queued', () => {
    // The case the guard exists for: a Scenario Builder edit not yet pushed would
    // be erased by a clear-then-overwrite from the server.
    expect(shouldSkipReferencePull({ pending: 1, cachedWorkshops: 2 })).toBe(true)
  })

  it('pulls anyway when the cache is empty, even with entries queued', () => {
    // The regression. An empty cache holds no authoring to lose, and refusing here
    // is what made the empty state permanent.
    expect(shouldSkipReferencePull({ pending: 3, cachedWorkshops: 0 })).toBe(false)
  })

  it('treats a zero cache and zero pending as an ordinary first load', () => {
    expect(shouldSkipReferencePull({ pending: 0, cachedWorkshops: 0 })).toBe(false)
  })
})

/**
 * The other exit from the same trap, which already existed and must keep working:
 * an entry that can never succeed stops counting as pending, so it cannot hold the
 * refresh shut on a device whose cache is otherwise fine.
 */
describe('set-aside outbox entries', () => {
  const entry = (over: Partial<ReferenceOutboxEntry> = {}): ReferenceOutboxEntry => ({
    id: 'workshop:ws-1',
    table: 'workshop',
    op: 'upsert',
    rowKey: 'ws-1',
    payload: {},
    at: '2026-08-20T04:24:59.000Z',
    ...over,
  })

  it('keeps an ordinary queued entry pending', () => {
    expect(isSetAside(entry())).toBe(false)
  })

  it('sets aside an entry the backend refused outright', () => {
    expect(isSetAside(entry({ rejected: true }))).toBe(true)
  })

  it('sets aside an entry that has failed too many round trips', () => {
    expect(isSetAside(entry({ attempts: MAX_PUSH_ATTEMPTS }))).toBe(true)
    expect(isSetAside(entry({ attempts: MAX_PUSH_ATTEMPTS - 1 }))).toBe(false)
  })
})

/**
 * The banner is the difference between a fault and an empty screen, so its copy
 * has to resolve. `c()` falls back to the raw id, which would print
 * "store.blocked" at the top of the app.
 */
describe('store health copy', () => {
  it('resolves every store-health string through chrome.json', () => {
    for (const id of ['store.blocked', 'store.failed', 'store.stalled']) {
      expect(findChromeNode(id)?.label, id).toBeTypeOf('string')
    }
  })

  it('gives the stalled message a count token to fill', () => {
    expect(findChromeNode('store.stalled')?.label).toContain('{count}')
  })
})
