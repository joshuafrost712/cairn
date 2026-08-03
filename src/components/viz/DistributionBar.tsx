import type { Distribution } from '../../reports/analytics'
import { useScale } from '../../hooks/useScale'
import { isLowTrigger, type Scale } from '../../lib/scale'
import { designationFill, designationInk, isDeemphasized, levelWord, shouldLabelSegment } from './viz'

/**
 * The designation distribution as one bar.
 *
 * CSS flex rather than SVG: each segment is `flex-grow: count`, so proportions
 * are the browser's problem and the bar reflows fluidly inside a table cell for
 * free. The 2px gap between fills sits on the card colour, which is what keeps
 * two adjacent steps of the same hue readable as two steps.
 *
 * `dist` is indexed by POSITION on the scale, not by designation value (tl-09).
 * The two were the same thing while every scale was 0-3 and are not on a 1-5
 * scale, so the value a segment stands for comes from `scale.points[i]`.
 */
export function DistributionBar({
  dist,
  scale: given,
  height = 20,
  emphasizeRisk = false,
  labelThreshold = 0.12,
  ariaLabel,
}: {
  dist: Distribution
  /** For the surfaces showing a workshop that is not the active one. */
  scale?: Scale
  height?: number
  emphasizeRisk?: boolean
  labelThreshold?: number
  ariaLabel: string
}) {
  const active = useScale()
  const scale = given ?? active
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

  const valueAt = (i: number): number | null => scale.points[i]?.value ?? null

  const readout = dist
    .map((n, i) => {
      const v = valueAt(i)
      return n > 0 && v !== null ? `${n} ${levelWord(scale, v)}` : null
    })
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
      {dist.map((count, i) => {
        const v = valueAt(i)
        if (count === 0 || v === null) return null
        return (
          <div
            key={v}
            className="distbar__seg"
            data-d={v}
            data-trigger={isLowTrigger(scale, v) || undefined}
            data-deemph={isDeemphasized(v, scale, emphasizeRisk) || undefined}
            style={
              {
                flexGrow: count,
                '--fill': designationFill(v, scale),
                '--ink-on': designationInk(v, scale),
              } as React.CSSProperties
            }
          >
            {shouldLabelSegment(count, total, labelThreshold) ? count : ''}
          </div>
        )
      })}
    </div>
  )
}
