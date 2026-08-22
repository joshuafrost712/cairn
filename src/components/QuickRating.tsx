import { useState } from 'react'
import { c } from '../lib/content/chrome'
import { useScale } from '../hooks/useScale'
import type { EvidenceLevels } from '../lib/types'

/**
 * Optional per-KSA quick read. The evaluator can tap one of the workshop's scale
 * points (or leave it unset). The selected point's anchor shows inline, and
 * "All levels" reveals the full rubric (folding in the old RubricPanel). Buttons
 * use onMouseDown + preventDefault so tapping never blurs the active textarea —
 * dictation inserts text word-by-word at the cursor, and stealing focus breaks it.
 *
 * The chips come from the workshop's scale since tl-09, not from a hardcoded
 * 0-3. Two consequences worth knowing. The chip's LABEL is the point's own
 * number, so a 1-5 workshop's evaluator taps a 1, not a 0 — the number they say
 * out loud is the number on the button. And a chip on a low-trigger point
 * carries the same underline the dashboard chips do, because "this one starts a
 * follow-up conversation" is exactly the thing an evaluator should know before
 * tapping it, and on a six-point scale it cannot be guessed.
 *
 * The evidence anchors are authored reference data, not chrome, so they carry
 * `data-dfb-source="ref"`: editing one files a proposal against the `ksa` row
 * rather than patching a file. `ksaId` exists only to address them.
 */
export function QuickRating({
  ksaId,
  levels,
  value,
  disabled = false,
  onChange,
}: {
  ksaId: string
  levels: EvidenceLevels | null
  value: number | undefined
  /**
   * Set on a submitted capture. The chips and the clear button go dead; "All
   * levels" stays live, because reading the rubric back is not editing.
   */
  disabled?: boolean
  onChange: (next: number | undefined) => void
}) {
  const scale = useScale()
  const [showAll, setShowAll] = useState(false)
  const anchor = (n: number) => levels?.[String(n)]

  /** Attributes addressing one evidence anchor back to its `ksa` row. */
  const anchorAttrs = (n: number) => ({
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
        {scale.points.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`rating-chip ${value === p.value ? 'primary' : ''}`}
            data-trigger={p.is_low_trigger || undefined}
            aria-pressed={value === p.value}
            disabled={disabled}
            title={anchor(p.value) ?? p.description ?? p.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value === p.value ? undefined : p.value)}
          >
            {p.value}
          </button>
        ))}
        {value !== undefined && !disabled && (
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
              {/* Top point first, as it always was: an evaluator reads down from
                  what good looks like. Descriptors for points the scale no
                  longer has are NOT shown, and are not deleted either — see
                  EvidenceLevels in lib/types.ts. */}
              {[...scale.points]
                .reverse()
                .filter((p) => anchor(p.value))
                .map((p) => (
                  <li key={p.value}>
                    <span className="rubric-level" data-trigger={p.is_low_trigger || undefined}>
                      {p.value}:
                    </span>{' '}
                    <span {...anchorAttrs(p.value)}>{anchor(p.value)}</span>
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
