import { useScale } from '../../hooks/useScale'
import { maxValue, minValue } from '../../lib/scale'
import { fillFor, rampStep } from './viz'

/**
 * A single horizontal bar for one value on the workshop's scale.
 *
 * The value label sits OUTSIDE the bar end, in ink, never inside and never
 * coloured: a numeral on a fill has to fight the fill for contrast at exactly
 * the sizes where it matters least.
 *
 * The bar's length is the value's position BETWEEN the scale's endpoints, not
 * `value / max` (tl-09). The old form assumed the scale started at zero, which
 * every scale in the app did; on a 1-5 scale it would have drawn the bottom
 * point — the worst score there is — as a bar a fifth of the way along, reading
 * as though somebody had scored something rather than nothing.
 */
export function BarRow({
  value,
  emphasizeRisk = false,
  ariaLabel,
  showValue = true,
}: {
  value: number | null
  emphasizeRisk?: boolean
  ariaLabel: string
  showValue?: boolean
}) {
  const scale = useScale()
  if (value === null) {
    return (
      <div className="barrow">
        <div className="barrow__track" />
        {showValue && <span className="barrow__value muted">—</span>}
      </div>
    )
  }

  const lo = minValue(scale)
  const hi = maxValue(scale)
  const span = hi - lo || 1
  const pct = Math.max(0, Math.min(1, (value - lo) / span)) * 100

  return (
    <div className="barrow" role="img" aria-label={`${ariaLabel}: ${value.toFixed(1)} of ${hi}`}>
      <div className="barrow__track">
        <div
          className="barrow__fill"
          style={{ width: `${pct}%`, background: fillFor(rampStep(value, scale), scale, emphasizeRisk) }}
        />
      </div>
      {showValue && <span className="barrow__value">{value.toFixed(1)}</span>}
    </div>
  )
}
