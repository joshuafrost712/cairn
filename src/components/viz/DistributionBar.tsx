import type { Distribution } from '../../reports/analytics'
import { LEVEL_WORD, isDeemphasized, shouldLabelSegment } from './viz'
import type { Designation } from './viz'

/**
 * The 0-3 distribution as one bar.
 *
 * CSS flex rather than SVG: each segment is `flex-grow: count`, so proportions
 * are the browser's problem and the bar reflows fluidly inside a table cell for
 * free. The 2px gap between fills sits on the card colour, which is what keeps
 * two adjacent steps of the same hue readable as two steps.
 */
export function DistributionBar({
  dist,
  height = 20,
  emphasizeRisk = false,
  labelThreshold = 0.12,
  ariaLabel,
}: {
  dist: Distribution
  height?: number
  emphasizeRisk?: boolean
  labelThreshold?: number
  ariaLabel: string
}) {
  const total = dist.reduce((a, b) => a + b, 0)

  if (total === 0) {
    return (
      <div
        className="distbar distbar--empty"
        style={{ height }}
        role="img"
        aria-label={`${ariaLabel}: no evidence yet`}
        title="No evidence yet"
      />
    )
  }

  const readout = dist
    .map((n, d) => (n > 0 ? `${n} ${LEVEL_WORD[d as Designation]}` : null))
    .filter(Boolean)
    .join(', ')

  return (
    <div
      className="distbar"
      style={{ height }}
      role="img"
      aria-label={`${ariaLabel}: ${readout}`}
      title={readout}
    >
      {dist.map((count, d) =>
        count === 0 ? null : (
          <div
            key={d}
            className="distbar__seg"
            data-d={d}
            data-deemph={isDeemphasized(d as Designation, emphasizeRisk) || undefined}
            style={{ flexGrow: count }}
          >
            {shouldLabelSegment(count, total, labelThreshold) ? count : ''}
          </div>
        ),
      )}
    </div>
  )
}
