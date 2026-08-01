/**
 * Saying when somebody can create their account (tl-11 addendum).
 *
 * Pure, and separate from the RPC that produces the timestamp, because the hard
 * part here is not the arithmetic — it is that two different readers need the same
 * fact phrased two different ways. The person waiting needs a clock time they can
 * act on ("2:00 pm today"); the administrator scanning a directory of twelve rows
 * needs a relative one they can compare ("in about 2 hours"). Giving either of them
 * the other's phrasing is how an honest schedule reads as an evasion.
 *
 * Everything here works in the READER's local time, deliberately. The window is
 * stored in UTC and an administrator in Bali scheduling an evaluator in Dallas must
 * not hand out a time in their own zone; `toLocaleTimeString` with no locale
 * argument is the browser's, which is the only one either of them can act on.
 */

/** A window, as the two audiences need to read it. */
export interface WindowDescription {
  /** True once the window has opened; both strings are then empty. */
  open: boolean
  /** A clock time the person can wait for: "2:00 pm", "9:15 am tomorrow". */
  clock: string
  /** How long from now: "in about 2 hours", "in a few minutes". */
  relative: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Round the wait to something a person can act on.
 *
 * Deliberately coarse. "In 47 minutes" invites somebody to sit and watch a clock
 * for a schedule that is advisory anyway — the budget is shared with password
 * resets this layer cannot see, so a minute-accurate promise would be precision the
 * underlying fact does not have.
 */
function relativeWait(ms: number): string {
  if (ms <= 2 * MINUTE) return 'in a moment'
  if (ms < 55 * MINUTE) {
    const minutes = Math.max(5, Math.round(ms / MINUTE / 5) * 5)
    return `in about ${minutes} minutes`
  }
  const hours = Math.round(ms / HOUR)
  return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function describeWindow(opensAt: string | null | undefined, now: Date): WindowDescription {
  if (!opensAt) return { open: true, clock: '', relative: '' }
  const at = new Date(opensAt)
  // An unparseable timestamp reads as open rather than as an indefinite wait. The
  // cost of being wrong that way is one attempt the rate-limit message explains;
  // the cost of the other way is an invited person told to wait until never.
  if (Number.isNaN(at.getTime())) return { open: true, clock: '', relative: '' }

  const ms = at.getTime() - now.getTime()
  if (ms <= 0) return { open: true, clock: '', relative: '' }

  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const clock = sameDay(at, now)
    ? time
    : `${time} on ${at.toLocaleDateString(undefined, { weekday: 'long' })}`

  return { open: false, clock, relative: relativeWait(ms) }
}
