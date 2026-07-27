import { fillFor, rampStep } from './viz'

/**
 * A single horizontal bar for one value on the 0-3 scale.
 *
 * The value label sits OUTSIDE the bar end, in ink, never inside and never
 * coloured: a numeral on a fill has to fight the fill for contrast at exactly
 * the sizes where it matters least.
 */
export function BarRow({
  value,
  max = 3,
  emphasizeRisk = false,
  ariaLabel,
  showValue = true,
}: {
  value: number | null
  max?: number
  emphasizeRisk?: boolean
  ariaLabel: string
  showValue?: boolean
}) {
  if (value === null) {
    return (
      <div className="barrow">
        <div className="barrow__track" />
        {showValue && <span className="barrow__value muted">—</span>}
      </div>
    )
  }

  const pct = Math.max(0, Math.min(1, value / max)) * 100

  return (
    <div className="barrow" role="img" aria-label={`${ariaLabel}: ${value.toFixed(1)} of ${max}`}>
      <div className="barrow__track">
        <div
          className="barrow__fill"
          style={{ width: `${pct}%`, background: fillFor(rampStep(value), emphasizeRisk) }}
        />
      </div>
      {showValue && <span className="barrow__value">{value.toFixed(1)}</span>}
    </div>
  )
}
