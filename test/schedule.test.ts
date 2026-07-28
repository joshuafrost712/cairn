import { describe, expect, it } from 'vitest'
import { countIn, groupActivitiesByDay, suggestActivity } from '../src/lib/schedule'
import { activity } from './factories'

const at = (day: string, from: string, to: string) => ({
  day,
  start_time: `${day}T${from}:00.000Z`,
  end_time: `${day}T${to}:00.000Z`,
})

// A three-day workshop, two sessions a day, in sort_order.
const schedule = [
  activity({ id: 'd1a', title: 'Day 1 morning', sort_order: 0, ...at('2026-08-24', '09:00', '11:00') }),
  activity({ id: 'd1b', title: 'Day 1 afternoon', sort_order: 1, ...at('2026-08-24', '14:00', '16:00') }),
  activity({ id: 'd2a', title: 'Day 2 morning', sort_order: 2, ...at('2026-08-25', '09:00', '11:00') }),
  activity({ id: 'd2b', title: 'Day 2 afternoon', sort_order: 3, ...at('2026-08-25', '14:00', '16:00') }),
  activity({ id: 'd3a', title: 'Day 3 morning', sort_order: 4, ...at('2026-08-26', '09:00', '11:00') }),
]

const ms = (iso: string) => Date.parse(iso)

describe('suggestActivity', () => {
  it('prefers the session running right now', () => {
    expect(suggestActivity(schedule, ms('2026-08-25T10:00:00.000Z'))).toBe('d2a')
  })

  // Evaluators write up a session in the minutes after it ends, so just-finished
  // beats about-to-start. This is the branch that decides the focus day at lunch.
  it('falls back to the session that just finished, not the next one', () => {
    expect(suggestActivity(schedule, ms('2026-08-25T12:00:00.000Z'))).toBe('d2a')
  })

  it('looks forward before the workshop has started', () => {
    expect(suggestActivity(schedule, ms('2026-08-20T08:00:00.000Z'))).toBe('d1a')
  })

  it('stays on the last session after the workshop ends', () => {
    expect(suggestActivity(schedule, ms('2026-09-01T08:00:00.000Z'))).toBe('d3a')
  })

  it('is null with nothing to suggest', () => {
    expect(suggestActivity([], ms('2026-08-25T10:00:00.000Z'))).toBeNull()
  })
})

describe('groupActivitiesByDay', () => {
  it('opens the suggestion’s day and folds the rest either side of it', () => {
    const g = groupActivitiesByDay(schedule, 'd2a')
    expect(g.focusDay).toBe('2026-08-25')
    expect(g.focus.map((a) => a.id)).toEqual(['d2a', 'd2b'])
    expect(g.earlier.map((d) => d.day)).toEqual(['2026-08-24'])
    expect(g.later.map((d) => d.day)).toEqual(['2026-08-26'])
    expect(g.unscheduled).toEqual([])
  })

  // The whole reason focusDay is derived from the suggestion rather than computed
  // from the clock a second time: the suggested activity must never be the one
  // hidden inside a collapsed section.
  it('always keeps the suggested activity in the open section', () => {
    for (const id of ['d1a', 'd1b', 'd2a', 'd2b', 'd3a']) {
      const g = groupActivitiesByDay(schedule, id)
      expect(g.focus.map((a) => a.id)).toContain(id)
    }
  })

  it('leads with the first day when the suggestion is undated', () => {
    const mixed = [...schedule, activity({ id: 'x', title: 'TBD', day: null, sort_order: 9 })]
    const g = groupActivitiesByDay(mixed, 'x')
    expect(g.focusDay).toBe('2026-08-24')
    expect(g.unscheduled.map((a) => a.id)).toEqual(['x'])
    expect(g.focus.map((a) => a.id)).toEqual(['d1a', 'd1b'])
  })

  it('has no focus day at all when nothing is dated', () => {
    const undated = [
      activity({ id: 'u1', day: null, sort_order: 0 }),
      activity({ id: 'u2', day: null, sort_order: 1 }),
    ]
    const g = groupActivitiesByDay(undated, 'u1')
    expect(g.focusDay).toBeNull()
    expect(g.focus).toEqual([])
    expect(g.earlier).toEqual([])
    expect(g.later).toEqual([])
    expect(g.unscheduled.map((a) => a.id)).toEqual(['u1', 'u2'])
  })

  it('preserves sort_order inside a day', () => {
    const reversed = [
      activity({ id: 'late', day: '2026-08-24', sort_order: 1 }),
      activity({ id: 'early', day: '2026-08-24', sort_order: 0 }),
    ]
    // The caller hands these over already sorted; the grouping must not reorder.
    const g = groupActivitiesByDay([reversed[1], reversed[0]], 'early')
    expect(g.focus.map((a) => a.id)).toEqual(['early', 'late'])
  })

  it('handles an empty schedule', () => {
    const g = groupActivitiesByDay([], null)
    expect(g).toEqual({ focusDay: null, focus: [], earlier: [], later: [], unscheduled: [] })
  })
})

describe('countIn', () => {
  it('totals the activities across day groups', () => {
    const g = groupActivitiesByDay(schedule, 'd2a')
    expect(countIn(g.earlier)).toBe(2)
    expect(countIn(g.later)).toBe(1)
    expect(countIn([])).toBe(0)
  })
})
