import { findChromeNode } from '../lib/content/chrome'

/**
 * A trace row's `detail`, as a sentence (tl-13). Pure.
 *
 * `detail` holds whichever the outcome carried: a chrome node id (every `refused` and
 * every `operator_action`, which is EVERY row in the two human-in-the-loop modes) or a
 * message from a server. Printed raw, the common case put `setup.ai.op.scenario-prompt`
 * on screen in the app's default mode — the exact failure the content layer's `c()`
 * fallback is prone to, and visible in this spec's own first screenshot.
 *
 * A dotted lowercase token is treated as an id and resolved; anything else is prose
 * from somewhere this app does not control, and is printed as it arrived so a real
 * error message is never quietly swallowed by a lookup miss. An id with no node falls
 * back to itself rather than to nothing, because a visible id is at least searchable.
 *
 * Its own module rather than a helper inside AiSection.tsx: a component file that also
 * exports a function breaks fast refresh, and this is worth a test of its own.
 */
export function describeDetail(detail: string): string {
  const looksLikeId = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(detail)
  if (!looksLikeId) return detail.slice(0, 160)
  return findChromeNode(detail)?.label ?? detail
}
