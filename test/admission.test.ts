import { describe, it, expect } from 'vitest'
import { describeWindow } from '../src/lib/admission'

/**
 * The sign-up admission queue's client half (tl-11 addendum).
 *
 * The scheduling itself is SQL and is proved in scripts/tl11-rls-tests.sql. What is
 * tested here is the part a person actually reads, and the two failure directions
 * it must never take: telling somebody to wait when they need not, and promising
 * precision the underlying fact does not have.
 */

const NOW = new Date('2026-08-01T09:40:00Z')
const at = (iso: string) => describeWindow(iso, NOW)

describe('describing a window', () => {
  it('reads as open when there is no window at all', () => {
    expect(describeWindow(null, NOW).open).toBe(true)
    expect(describeWindow(undefined, NOW).open).toBe(true)
  })

  it('reads as open once the time has passed', () => {
    expect(at('2026-08-01T09:00:00Z').open).toBe(true)
    expect(at('2026-08-01T09:40:00Z').open).toBe(true)
  })

  /**
   * The direction that matters. An unparseable timestamp costs one attempt if we
   * guess open, and locks an invited person out forever if we guess waiting.
   */
  it('fails open on a timestamp it cannot read', () => {
    expect(describeWindow('not a date', NOW).open).toBe(true)
    expect(describeWindow('', NOW).open).toBe(true)
  })

  it('is coarse on purpose, because the schedule is advisory', () => {
    // The budget is shared with password resets this layer cannot see, so a
    // minute-accurate promise would be precision the fact does not have.
    expect(at('2026-08-01T09:41:00Z').relative).toBe('in a moment')
    expect(at('2026-08-01T10:07:00Z').relative).toBe('in about 25 minutes')
    expect(at('2026-08-01T10:40:00Z').relative).toBe('in about an hour')
    expect(at('2026-08-01T12:40:00Z').relative).toBe('in about 3 hours')
  })

  it('gives a clock time as well as a wait, because two readers need each', () => {
    const soon = at('2026-08-01T11:40:00Z')
    expect(soon.open).toBe(false)
    expect(soon.clock).toMatch(/\d/)
    expect(soon.relative).toContain('hours')
  })

  it('names the day when the window is not today', () => {
    const tomorrow = at('2026-08-02T11:40:00Z')
    expect(tomorrow.clock).toMatch(/on \w+day$/)
    // ...and does not, when it is.
    expect(at('2026-08-01T11:40:00Z').clock).not.toMatch(/on \w+day$/)
  })
})
