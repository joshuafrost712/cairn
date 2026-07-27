import type { DesignationStats } from '../../reports/analytics'
import { LEVEL_WORD, isDeemphasized } from '../viz/viz'
import type { Designation } from '../viz/viz'

/**
 * One 0-3 value. The numeral is always rendered; the fill is redundant.
 * A null value shows a middle dot on the empty surface, never a zero.
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
  const label =
    value === null ? 'no evidence yet' : `${value} of 3, ${LEVEL_WORD[value as Designation]}`
  return (
    <span
      className="chip-d"
      data-d={value === null ? 'none' : value}
      data-conflict={conflict || undefined}
      data-deemph={isDeemphasized(value as Designation | null, emphasizeRisk) || undefined}
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
