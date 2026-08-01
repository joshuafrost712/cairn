/**
 * The wordmark's stacked-bars mark, inline.
 *
 * The same geometry as `public/favicon.svg`, drawn here rather than loaded as an
 * image so it takes the page's own tokens and stays crisp at any size. If one
 * changes, change the other: they are the same mark and a drift between them is
 * the kind of thing nobody notices until the installed icon and the header
 * disagree.
 *
 * Three bars, bottom-heavy, in the designation ramp: observations stacking into a
 * record. The accent tick rising off the top bar is the ratification.
 */
export function Mark({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="app-mark"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={5} y={33} width={36} height={9} rx={4.5} fill="var(--d3)" />
      <rect x={8} y={21} width={28} height={9} rx={4.5} fill="var(--d2)" />
      <rect x={11} y={9} width={14} height={9} rx={4.5} fill="var(--d1)" />
      <path
        d="M 29 14 L 33 18 L 42 6"
        fill="none"
        stroke="var(--accent)"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
