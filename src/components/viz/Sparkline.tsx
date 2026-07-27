import { MIN_N_FOR_MEAN } from '../../reports/analytics'

export interface SparkPoint {
  label: string
  /** null = no data that day. The path SPLITS here; it does not interpolate. */
  value: number | null
  n: number
}

/**
 * A trend across days, on the 0-3 domain.
 *
 * Two decisions carry the honesty of this mark. A missing day breaks the path
 * instead of drawing a line across it, so a gap reads as a gap rather than as a
 * smooth trend through data that does not exist. And a point computed from
 * fewer than MIN_N_FOR_MEAN observations renders hollow, so a wobble caused by
 * one person's note is visibly not a cohort movement.
 */
export function Sparkline({
  points,
  domain = [0, 3],
  width = 132,
  height = 30,
  threshold = 1.5,
  ariaLabel,
}: {
  points: SparkPoint[]
  domain?: [number, number]
  width?: number
  height?: number
  /** solid hairline at the at-risk boundary; null to omit */
  threshold?: number | null
  ariaLabel: string
}) {
  const withData = points.filter((p) => p.value !== null)
  if (withData.length === 0) {
    return (
      <span className="muted small" aria-label={`${ariaLabel}: no data`}>
        ·
      </span>
    )
  }

  const [lo, hi] = domain
  const pad = 4
  const w = width - pad * 2
  const h = height - pad * 2
  const stepX = points.length > 1 ? w / (points.length - 1) : 0
  const x = (i: number) => pad + i * stepX
  const y = (v: number) => pad + h - ((v - lo) / (hi - lo)) * h

  // Split into contiguous runs so a null day breaks the line.
  const runs: { i: number; p: SparkPoint }[][] = []
  let current: { i: number; p: SparkPoint }[] = []
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push({ i, p })
    }
  })
  if (current.length) runs.push(current)

  const last = withData[withData.length - 1]
  const lastIndex = points.lastIndexOf(last)
  const readout = points
    .map((p) => `${p.label}: ${p.value === null ? 'no data' : `${p.value.toFixed(1)} (n=${p.n})`}`)
    .join('; ')

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${ariaLabel}. ${readout}`}
    >
      <title>{readout}</title>
      {threshold !== null && (
        <line
          x1={pad}
          x2={width - pad}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="var(--axis)"
          strokeWidth={1}
        />
      )}
      {runs.map((run, ri) =>
        run.length === 1 ? null : (
          <polyline
            key={ri}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={run.map(({ i, p }) => `${x(i)},${y(p.value!)}`).join(' ')}
          />
        ),
      )}
      {/* Low-n points are hollow: one observation is not a trend. */}
      {points.map((p, i) =>
        p.value === null ? null : (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={i === lastIndex ? 4 : 2.5}
            fill={p.n < MIN_N_FOR_MEAN ? 'var(--card)' : 'var(--accent)'}
            stroke="var(--accent)"
            strokeWidth={2}
          />
        ),
      )}
    </svg>
  )
}
