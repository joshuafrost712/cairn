// Which activity you are probably here for, and what to do with the rest.
//
// Pure, no IO, no React, so both rules can be tested directly. They used to live
// inside EvaluatorHome, which meant the only way to check "what happens on day 4
// of a workshop" was to load the app on day 4.

import type { Activity } from './types'

/**
 * Pick the activity nearest to now: prefer the one currently running, else the
 * most recently finished, else the next upcoming. Returns its id or null.
 *
 * Moved here verbatim from EvaluatorHome. The "most recently finished" branch is
 * the important one: evaluators write up a session in the minutes after it ends,
 * so the honest default just after a session is the one that just finished, not
 * the one about to start.
 */
export function suggestActivity(activities: Activity[], now: number): string | null {
  if (activities.length === 0) return null
  const withTimes = activities.filter((a) => a.start_time)
  // currently running
  const running = withTimes.find((a) => {
    const s = a.start_time ? Date.parse(a.start_time) : NaN
    const e = a.end_time ? Date.parse(a.end_time) : NaN
    return !Number.isNaN(s) && now >= s && (Number.isNaN(e) || now <= e)
  })
  if (running) return running.id
  // most recently finished
  const finished = withTimes
    .filter((a) => a.end_time && Date.parse(a.end_time) <= now)
    .sort((x, y) => Date.parse(y.end_time!) - Date.parse(x.end_time!))
  if (finished[0]) return finished[0].id
  // next upcoming
  const upcoming = withTimes
    .filter((a) => a.start_time && Date.parse(a.start_time) > now)
    .sort((x, y) => Date.parse(x.start_time!) - Date.parse(y.start_time!))
  return upcoming[0]?.id ?? activities[0].id
}

export interface DayGroup {
  /** The `Activity.day` value, or null for the unscheduled bucket. */
  day: string | null
  activities: Activity[]
}

export interface GroupedSchedule {
  /** The day the evaluator is being shown open. Null when nothing is dated. */
  focusDay: string | null
  /** Activities on the focus day, in schedule order. */
  focus: Activity[]
  /** Dated days before the focus day, ascending. */
  earlier: DayGroup[]
  /** Dated days after the focus day, ascending. */
  later: DayGroup[]
  /** Activities with no `day` at all. Authoring is often incomplete. */
  unscheduled: Activity[]
}

/**
 * Split the schedule into what to show open and what to fold away.
 *
 * The focus day is DERIVED from the suggestion, not computed from the clock a
 * second time. If the two disagreed by even a boundary case, the "suggested"
 * activity could end up inside a collapsed section, which is worse than the flat
 * list this replaces: the one thing you came for would be the one thing hidden.
 *
 * `activities` is expected in `sort_order`, and that order is preserved inside
 * every bucket. Day buckets themselves sort by the `day` string, which is an ISO
 * date and therefore sorts correctly as text.
 */
export function groupActivitiesByDay(
  activities: Activity[],
  suggestedId: string | null,
): GroupedSchedule {
  const dated = activities.filter((a) => a.day != null)
  const unscheduled = activities.filter((a) => a.day == null)

  const suggested = suggestedId ? activities.find((a) => a.id === suggestedId) : undefined
  // Fall back to the earliest dated day, so a workshop whose suggestion landed on
  // an undated activity still opens on something rather than on nothing.
  const focusDay =
    suggested?.day ?? [...new Set(dated.map((a) => a.day as string))].sort()[0] ?? null

  const byDay = new Map<string, Activity[]>()
  for (const a of dated) {
    const key = a.day as string
    const list = byDay.get(key) ?? []
    list.push(a)
    byDay.set(key, list)
  }

  const groups = (predicate: (day: string) => boolean): DayGroup[] =>
    [...byDay.keys()]
      .filter(predicate)
      .sort()
      .map((day) => ({ day, activities: byDay.get(day)! }))

  return {
    focusDay,
    focus: focusDay ? byDay.get(focusDay) ?? [] : [],
    earlier: focusDay ? groups((d) => d < focusDay) : [],
    later: focusDay ? groups((d) => d > focusDay) : [],
    unscheduled,
  }
}

/** Count of activities in a set of day groups, for a disclosure's summary line. */
export function countIn(groups: DayGroup[]): number {
  return groups.reduce((n, g) => n + g.activities.length, 0)
}

/** "Wed 4 Feb" from an ISO date, falling back to the raw string if unparseable. */
export function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}
