/**
 * The colour rules for the designation ramp, in one place.
 *
 * Pure helpers only, so they are unit-testable and the components stay pure
 * functions of their props. Everything returns a CSS custom-property reference
 * rather than a literal colour, so the ramp can be re-stepped for dark mode
 * without touching a single component.
 *
 * SCALE-DRIVEN SINCE tl-09. There were four named colours and four named words;
 * there are now five authored ramps, one per legal scale size (two to six
 * points), and the word comes from the workshop's own label for the point. A
 * value is coloured by its POSITION on its workshop's scale rather than by the
 * number itself, which is the only thing that works when one deployment holds a
 * 0-3 workshop and a 1-5 one: on both, the bottom point must read as the bottom.
 *
 * The four-point ramp is byte-for-byte the ramp this app has always used, so
 * nothing about an existing workshop's heatmap moves.
 *
 * The ramps are sequential — one hue, monotone lightness — because the scale is
 * ordinal: reordering the points would change the meaning. Every step was
 * contrast-checked against the ink it is paired with and clears 4.5:1; the two
 * that landed in the band where neither black nor white does were nudged lighter
 * until they cleared it, which is why the 3- and 5-point ramps are not exactly
 * even divisions of the endpoints.
 *
 * AND THE NUMERAL IS ALWAYS RENDERED. Colour is a redundant channel here, never
 * the only one, which is also what makes the plain table view a faithful twin.
 */

import { indexOfValue, isLowTrigger, labelFor, rampIndexForMean, scaleSize, type Scale } from '../../lib/scale'

/**
 * A point on a workshop's scale. `number` since tl-09, where it was `0|1|2|3`.
 *
 * The alias is kept rather than replaced with a bare `number` so the places that
 * mean "a designation" still say so, and so the widening is greppable.
 */
export type Designation = number

/**
 * The fill for a value, as a token reference.
 *
 * Falls back to the empty fill for a value the scale does not define, rather than
 * clamping it onto the nearest point: a designation nobody can label is a data
 * error, and painting it as though it were a real score would hide it.
 */
export function designationFill(d: Designation, scale: Scale): string {
  const i = indexOfValue(scale, d)
  if (i < 0) return EMPTY_FILL
  return `var(--d-${scaleSize(scale)}-${i})`
}

/** Ink is chosen per step at authoring time, so it is a token lookup, not a rule. */
export function designationInk(d: Designation, scale: Scale): string {
  const i = indexOfValue(scale, d)
  if (i < 0) return 'var(--d-empty-ink)'
  return `var(--d-${scaleSize(scale)}-${i}-ink)`
}

export const EMPTY_FILL = 'var(--d-empty)'
export const DEEMPH_FILL = 'var(--deemph)'

/**
 * The fill for a value, honouring the at-risk emphasis toggle.
 *
 * Emphasis mode is the honest answer to "low scores recede in a light-to-dark
 * ramp": rather than adding a second, contradictory palette, it drops everything
 * that is NOT at risk to grey so the weak tail is what remains coloured.
 *
 * At risk means the workshop marked the point a low trigger (tl-09), not `d <= 1`.
 * The dashboard's idea of trouble and the app's idea of trouble stay the same
 * idea, which is what they were before — the idea is just no longer a literal.
 */
export function fillFor(d: Designation | null, scale: Scale, emphasizeRisk = false): string {
  if (d === null) return EMPTY_FILL
  if (emphasizeRisk && !isLowTrigger(scale, d)) return DEEMPH_FILL
  return designationFill(d, scale)
}

/** True when emphasis mode should grey this value out. Drives `data-deemph`. */
export function isDeemphasized(
  d: Designation | null,
  scale: Scale,
  emphasizeRisk = false,
): boolean {
  return emphasizeRisk && d !== null && !isLowTrigger(scale, d)
}

/**
 * Snap a mean onto the ramp for a bar fill. Never used for text: the printed
 * number is always the real mean, and rounding it for display would be a lie.
 */
export function rampStep(value: number, scale: Scale): Designation {
  return scale.points[rampIndexForMean(value, scale)].value
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

/**
 * The word for a designation, from the workshop's own scale.
 *
 * Replaces the four-entry `LEVEL_WORD` constant. An organization that calls its
 * middle point "Meets expectations" now sees that in the legend, the tooltip and
 * the aria text, rather than "competent" — which was the OBT track's word and was
 * never anybody else's.
 */
export function levelWord(scale: Scale, d: Designation | null | undefined): string {
  return labelFor(scale, d)
}
