/**
 * The designation ramp, as SVG-usable token references.
 *
 * The tour's report card fills its cells from the SAME four steps the product's
 * heatmap uses, and always renders the numeral on top, because a tour drawn in
 * invented colours teaches the wrong thing about the screen it is advertising.
 * Ink is picked by fill luminance, exactly as tokens.css documents it: 0 and 1
 * take dark ink, 2 and 3 take white.
 *
 * Kept in a .ts file rather than beside the components: react-refresh's
 * only-export-components rule objects to a .tsx module exporting constants.
 */
export const RAMP = ['var(--d0)', 'var(--d1)', 'var(--d2)', 'var(--d3)'] as const
export const RAMP_INK = [
  'var(--d0-ink)',
  'var(--d1-ink)',
  'var(--d2-ink)',
  'var(--d3-ink)',
] as const

/** A designation a tour diagram displays. Ordinal, 0 through 3. */
export type Designation = 0 | 1 | 2 | 3