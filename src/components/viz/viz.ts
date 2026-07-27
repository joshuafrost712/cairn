/**
 * The colour rules for the 0-3 designation scale, in one place.
 *
 * Pure helpers only, so they are unit-testable and the components stay pure
 * functions of their props. Everything returns a CSS custom-property reference
 * rather than a literal colour, so the ramp can be re-stepped for dark mode
 * without touching a single component.
 */

export type Designation = 0 | 1 | 2 | 3

/** Ink is chosen by fill luminance: 0 and 1 take dark ink, 2 and 3 take white. */
export function designationInk(d: Designation): string {
  return d <= 1 ? 'var(--d0-ink)' : 'var(--d2-ink)'
}

export function designationFill(d: Designation): string {
  return `var(--d${d})`
}

export const EMPTY_FILL = 'var(--d-empty)'
export const DEEMPH_FILL = 'var(--deemph)'

/**
 * The fill for a value, honouring the at-risk emphasis toggle.
 *
 * Emphasis mode is the honest answer to "low scores recede in a light-to-dark
 * ramp": rather than adding a second, contradictory palette, it drops everything
 * above the at-risk line to grey so the weak tail is what remains coloured.
 */
export function fillFor(d: Designation | null, emphasizeRisk = false, atRiskMax = 1): string {
  if (d === null) return EMPTY_FILL
  if (emphasizeRisk && d > atRiskMax) return DEEMPH_FILL
  return designationFill(d)
}

/** True when emphasis mode should grey this value out. Drives `data-deemph`. */
export function isDeemphasized(d: Designation | null, emphasizeRisk = false, atRiskMax = 1): boolean {
  return emphasizeRisk && d !== null && d > atRiskMax
}

/**
 * Snap a mean onto the ramp for a bar fill. Never used for text: the printed
 * number is always the real mean, and rounding it for display would be a lie.
 */
export function rampStep(value: number): Designation {
  return Math.max(0, Math.min(3, Math.round(value))) as Designation
}

/**
 * Whether a distribution segment is wide enough to carry its count inline.
 *
 * A proportional gate, not a measurement: a segment holding one of forty
 * observations cannot fit a legible numeral, and a clipped digit is worse than
 * no digit. Every count is in the tooltip and in the table regardless, so
 * skipping the inline label never hides a value.
 */
export function shouldLabelSegment(count: number, total: number, threshold = 0.12): boolean {
  if (count === 0 || total === 0) return false
  return count / total >= threshold
}

/** The four designation labels, for legends and aria text. */
export const LEVEL_WORD: Record<Designation, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}
