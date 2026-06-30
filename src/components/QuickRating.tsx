import { useState } from 'react'
import type { EvidenceLevels } from '../lib/types'

const LEVELS = [0, 1, 2, 3] as const
type Level = (typeof LEVELS)[number]

/**
 * Optional per-KSA quick read. The evaluator can tap a 0–3 (or leave it unset).
 * The selected level's anchor shows inline, and "All levels" reveals the full
 * 0–3 rubric (folding in the old RubricPanel). Buttons use
 * onMouseDown + preventDefault so tapping never blurs the active textarea —
 * dictation inserts text word-by-word at the cursor, and stealing focus breaks it.
 */
export function QuickRating({
  levels,
  value,
  onChange,
}: {
  levels: EvidenceLevels | null
  value: Level | undefined
  onChange: (next: Level | undefined) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const anchor = (n: Level) => levels?.[String(n) as '0' | '1' | '2' | '3']

  return (
    <div className="quick-rating">
      <div className="row" style={{ gap: '0.35rem' }}>
        <span className="small muted">Quick read (optional):</span>
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
            clear
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
          {showAll ? 'Hide levels' : 'All levels'}
        </button>
      </div>
      {value !== undefined && anchor(value) && (
        <p className="small muted rating-anchor">
          <span className="rubric-level">{value}:</span> {anchor(value)}
        </p>
      )}
      {showAll && (
        <div className="rubric-panel" role="region" aria-label="Evidence levels">
          {levels ? (
            <ul>
              {([3, 2, 1, 0] as const)
                .filter((n) => anchor(n))
                .map((n) => (
                  <li key={n}>
                    <span className="rubric-level">{n}:</span> {anchor(n)}
                  </li>
                ))}
            </ul>
          ) : (
            <span className="muted">No rubric content yet (pending authoring).</span>
          )}
        </div>
      )}
    </div>
  )
}
