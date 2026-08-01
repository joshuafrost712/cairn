import type { Ksa } from '../../lib/types'
import { useScale } from '../../hooks/useScale'
import { designationFill, levelWord } from './viz'
import type { Scale } from '../../lib/scale'

/**
 * The scale legend. Mandatory wherever the ramp appears: an ordinal encoding
 * without its key is a decoration.
 *
 * When a single KSA is in scope its own authored evidence-level descriptors are
 * used, because "emerging" means something specific per KSA and the workshop's
 * generic word for the point is a fallback, not the truth.
 *
 * The legend has a second job since tl-09: it is the only place a reader is told
 * WHICH points warrant a follow-up conversation. That is a per-workshop choice
 * and cannot be inferred from the ramp, so the trigger points are named in words
 * as well as carrying the underline the chips and cells carry.
 */
export function Legend({
  ksa,
  scale: given,
  showConflict = true,
  showEmpty = true,
}: {
  ksa?: Ksa
  /** For the surfaces showing a workshop that is not the active one. */
  scale?: Scale
  showConflict?: boolean
  showEmpty?: boolean
}) {
  const active = useScale()
  const scale = given ?? active

  const label = (d: number): string => {
    const authored = ksa?.evidence_levels?.[String(d)]
    return authored ? `${d} ${authored}` : `${d} ${levelWord(scale, d)}`
  }

  const triggers = scale.points.filter((p) => p.is_low_trigger)

  return (
    <div className="legend">
      {scale.points.map((p) => (
        <span className="legend__item" key={p.value}>
          <span
            className="legend__swatch"
            data-trigger={p.is_low_trigger || undefined}
            style={{ background: designationFill(p.value, scale) }}
          />
          {label(p.value)}
        </span>
      ))}
      {showEmpty && (
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: 'var(--d-empty)' }} />· no evidence
          yet
        </span>
      )}
      {showConflict && (
        <span className="legend__item">
          <span
            className="chip-d"
            data-d={scale.points[Math.max(0, scale.points.length - 2)].value}
            data-conflict="true"
            style={{ width: 18, minWidth: 18, height: 18 }}
            aria-hidden="true"
          />
          conflicting evidence
        </span>
      )}
      {triggers.length > 0 && (
        <span className="legend__item legend__item--note">
          <span className="legend__swatch legend__swatch--rule" aria-hidden="true" />
          {triggers.map((p) => p.value).join(', ')} {triggers.length === 1 ? 'calls' : 'call'} for a
          follow-up conversation
        </span>
      )}
    </div>
  )
}
