import type { DesignationStats } from '../../reports/analytics'
import { useScale } from '../../hooks/useScale'
import { designationFill, designationInk, isDeemphasized, levelWord } from '../viz/viz'
import { isLowTrigger, maxValue } from '../../lib/scale'

/**
 * One value on the workshop's scale. The numeral is always rendered; the fill is
 * redundant. A null value shows a middle dot on the empty surface, never a zero.
 *
 * The scale comes from the hook rather than a prop because this chip is rendered
 * from a dozen places, several of them deep inside table cells, and a prop
 * threaded through all of them is a prop one of them will forget — with the
 * failure being a chip labelled by the wrong workshop's words, which looks
 * entirely normal.
 */
export function DesignationChip({
  value,
  conflict = false,
  emphasizeRisk = false,
  title,
}: {
  value: number | null
  conflict?: boolean
  emphasizeRisk?: boolean
  title?: string
}) {
  const scale = useScale()
  const label =
    value === null
      ? 'no evidence yet'
      : `${value} of ${maxValue(scale)}, ${levelWord(scale, value)}`
  return (
    <span
      className="chip-d"
      data-d={value === null ? 'none' : value}
      data-conflict={conflict || undefined}
      data-trigger={(value !== null && isLowTrigger(scale, value)) || undefined}
      data-deemph={isDeemphasized(value, scale, emphasizeRisk) || undefined}
      style={
        value === null
          ? undefined
          : ({
              '--fill': designationFill(value, scale),
              '--ink-on': designationInk(value, scale),
            } as React.CSSProperties)
      }
      title={title ?? (conflict ? `${label} (evaluators conflicted)` : label)}
      aria-label={label}
    >
      {value === null ? '·' : value}
    </span>
  )
}

/**
 * A mean with its n, obeying the small-n rule in one place so no caller has to
 * remember it: below three values there is no printable mean, only the count.
 */
export function MeanWithN({ stats, label }: { stats: DesignationStats; label?: string }) {
  if (stats.n === 0) {
    return (
      <span className="muted" title={label ? `${label}: no evidence yet` : undefined}>
        —
      </span>
    )
  }
  return (
    <span>
      {stats.reportableMean !== null ? (
        stats.reportableMean.toFixed(1)
      ) : (
        <span className="muted" title="Too few observations for a meaningful average">
          —
        </span>
      )}{' '}
      <span className={`n-badge${stats.lowN ? ' n-badge--low' : ''}`}>n={stats.n}</span>
    </span>
  )
}
