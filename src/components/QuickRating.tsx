import { useState } from 'react'
import { c } from '../lib/content/chrome'
import type { EvidenceLevels } from '../lib/types'

const LEVELS = [0, 1, 2, 3] as const
type Level = (typeof LEVELS)[number]

/**
 * Optional per-KSA quick read. The evaluator can tap a 0–3 (or leave it unset).
 * The selected level's anchor shows inline, and "All levels" reveals the full
 * 0–3 rubric (folding in the old RubricPanel). Buttons use
 * onMouseDown + preventDefault so tapping never blurs the active textarea —
 * dictation inserts text word-by-word at the cursor, and stealing focus breaks it.
 *
 * The evidence anchors are authored reference data, not chrome, so they carry
 * `data-dfb-source="ref"`: editing one files a proposal against the `ksa` row
 * rather than patching a file. `ksaId` exists only to address them.
 */
export function QuickRating({
  ksaId,
  levels,
  value,
  onChange,
}: {
  ksaId: string
  levels: EvidenceLevels | null
  value: Level | undefined
  onChange: (next: Level | undefined) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const anchor = (n: Level) => levels?.[String(n) as '0' | '1' | '2' | '3']

  /** Attributes addressing one evidence anchor back to its `ksa` row. */
  const anchorAttrs = (n: Level) => ({
    'data-dfb-node': ksaId,
    'data-dfb-field': `evidence_levels.${n}`,
    'data-dfb-source': 'ref',
    'data-dfb-table': 'ksa',
  })

  return (
    <div className="quick-rating">
      <div className="row" style={{ gap: '0.35rem' }}>
        <span className="small muted" data-dfb-node="rating.quick-read" data-dfb-field="label" data-dfb-source="chrome">
          {c('rating.quick-read')}
        </span>
        {LEVELS.map((n) => (
          <button
            key={n}
            type="button"
            className={`rating-chip ${value === n ? 'primary' : ''}`}
            aria-pressed={value === n}
            title={anchor(n) ?? undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value === n ? undefined : n)}
          >
            {n}
          </button>
        ))}
        {value !== undefined && (
          <button
            type="button"
            className="ghost small muted"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(undefined)}
          >
            {c('rating.clear')}
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="rubric-toggle"
          aria-expanded={showAll}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? c('rating.hide-levels') : c('rating.all-levels')}
        </button>
      </div>
      {value !== undefined && anchor(value) && (
        <p className="small muted rating-anchor">
          <span className="rubric-level">{value}:</span>{' '}
          <span {...anchorAttrs(value)}>{anchor(value)}</span>
        </p>
      )}
      {showAll && (
        <div className="rubric-panel" role="region" aria-label={c('rating.levels-region')}>
          {levels ? (
            <ul>
              {([3, 2, 1, 0] as const)
                .filter((n) => anchor(n))
                .map((n) => (
                  <li key={n}>
                    <span className="rubric-level">{n}:</span>{' '}
                    <span {...anchorAttrs(n)}>{anchor(n)}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <span className="muted" data-dfb-node="rating.no-rubric" data-dfb-field="label" data-dfb-source="chrome">
              {c('rating.no-rubric')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
