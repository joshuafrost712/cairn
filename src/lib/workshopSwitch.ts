/**
 * Where a workshop switch should land the user.
 *
 * Switching workshop while standing on a detail page is the one case that reads
 * as a broken app: `/admin/participants/<id>` names a row that belongs to the
 * workshop being left, so after the switch it resolves to nothing and the page
 * renders its not-found state. The user's mental model is "I changed hats", and
 * what they get is an error.
 *
 * So a detail route falls back to its own group's index, and everything else
 * stays put. Deliberately a pure string function rather than logic inside the
 * switcher: it is a routing rule with a dozen cases and it wants a table of
 * inputs, not a rendered component.
 *
 * The rule is keyed on ROUTE SHAPE, not on whether the id happens to exist in
 * the target workshop. Keeping a detail page open because the same id is also
 * valid in the other workshop would be a coincidence to build on, and ids here
 * are uuids, so it never happens.
 */

/**
 * Routes whose last segment names a row scoped to one workshop, and where a
 * switch should land instead.
 *
 * `/admin/setup/:section` is deliberately absent: a section name (`participants`,
 * `calendar`) is a page within setup, not a row, and it is equally valid in the
 * workshop being switched to. Sending an admin from the Calendar section of Bali
 * to the Setup index of the Crash Course would lose their place for no reason.
 */
const DETAIL_ROUTES: { prefix: string; index: string }[] = [
  // The capture flow. Home rather than a list: a half-typed capture belongs to
  // the workshop it was started in, and the evaluator has just said they are
  // working somewhere else.
  { prefix: '/capture/', index: '/' },
  { prefix: '/reports/', index: '/reports' },
  { prefix: '/outgoing/', index: '/outgoing' },
  { prefix: '/admin/events/', index: '/admin/events' },
  { prefix: '/admin/participants/', index: '/admin/participants' },
  { prefix: '/admin/evaluators/', index: '/admin/evaluators' },
]

/**
 * The path to navigate to after switching workshop, or null to stay where we are.
 *
 * Null rather than "the same path" so the caller can skip the navigation
 * entirely: navigating to the current path would remount the page and throw away
 * scroll position and any in-progress filter, which is the same cost the detail
 * redirect exists to avoid.
 */
export function switchDestination(pathname: string): string | null {
  const match = DETAIL_ROUTES.find((r) => pathname.startsWith(r.prefix))
  // A trailing segment is required. `/reports/` with nothing after it is already
  // the index by another name, and redirecting it would be a no-op that costs a
  // remount.
  if (!match || pathname.length <= match.prefix.length) return null
  return match.index
}
