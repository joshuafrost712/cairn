// Keyboard movement through the document pane.
//
// Pure so the awkward cases (first row, last row, an empty document, a document
// of nothing but headings) are testable without a DOM.
//
// One decision worth stating: movement crosses EVERY segment, not just the
// editable ones. You want to select a heading to read the evidence under it, and
// a cursor that skipped rows would make the document feel like it had holes.

import type { DocSegment } from '../reports/segments'

export type NavKey = 'up' | 'down' | 'home' | 'end'

/**
 * The next selection after a movement key.
 *
 * Returns the current id at the ends rather than wrapping. Wrapping in a
 * document is disorienting: pressing down at the bottom should feel like a wall,
 * not teleport you to the greeting.
 */
export function nextSegmentId(
  segments: DocSegment[],
  currentId: string | null,
  key: NavKey,
): string | null {
  if (segments.length === 0) return null
  if (key === 'home') return segments[0].id
  if (key === 'end') return segments[segments.length - 1].id

  const i = currentId === null ? -1 : segments.findIndex((s) => s.id === currentId)

  // Nothing selected yet, or the selection points at a segment that no longer
  // exists after a regeneration: start at the top for down, bottom for up.
  if (i === -1) return key === 'down' ? segments[0].id : segments[segments.length - 1].id

  const next = key === 'down' ? i + 1 : i - 1
  if (next < 0 || next >= segments.length) return currentId
  return segments[next].id
}

/** Whether a segment can be edited given both its own flag and the draft's state. */
export function canEditSegment(seg: DocSegment | undefined, draftEditable: boolean): boolean {
  return Boolean(seg?.editable) && draftEditable
}
