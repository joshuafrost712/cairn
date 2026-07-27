import type { Ksa } from '../../lib/types'
import { LEVEL_WORD, designationFill } from './viz'
import type { Designation } from './viz'

const LEVELS: Designation[] = [0, 1, 2, 3]

/**
 * The scale legend. Mandatory wherever the ramp appears: an ordinal encoding
 * without its key is a decoration.
 *
 * When a single KSA is in scope its own authored evidence-level descriptors are
 * used, because "emerging" means something specific per KSA and the generic
 * word is a fallback, not the truth.
 */
export function Legend({
  ksa,
  showConflict = true,
  showEmpty = true,
}: {
  ksa?: Ksa
  showConflict?: boolean
  showEmpty?: boolean
}) {
  const label = (d: Designation): string => {
    const authored = ksa?.evidence_levels?.[String(d) as '0' | '1' | '2' | '3']
    return authored ? `${d} ${authored}` : `${d} ${LEVEL_WORD[d]}`
  }

  return (
    <div className="legend">
      {LEVELS.map((d) => (
        <span className="legend__item" key={d}>
          <span className="legend__swatch" style={{ background: designationFill(d) }} />
          {label(d)}
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
            data-d="2"
            data-conflict="true"
            style={{ width: 18, minWidth: 18, height: 18 }}
            aria-hidden="true"
          />
          conflicting evidence
        </span>
      )}
    </div>
  )
}
