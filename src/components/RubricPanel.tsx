import { useState } from 'react'
import type { EvidenceLevels } from '../lib/types'

/**
 * Collapsible rubric shown ABOVE the input (never an overlay). The toggle uses
 * onMouseDown + preventDefault so tapping it does NOT blur the active text field —
 * this is the brief's flagged UX risk: dictation inserts text word-by-word at the
 * cursor, and stealing focus would break that. The evaluator can reveal the
 * evidence levels while still dictating into the field below.
 */
export function RubricPanel({ levels }: { levels: EvidenceLevels | null }) {
  const [open, setOpen] = useState(false)
  const order: Array<'3' | '2' | '1' | '0'> = ['3', '2', '1', '0']

  return (
    <div>
      <button
        type="button"
        className="rubric-toggle"
        aria-expanded={open}
        // Prevent focus theft from the active textarea.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide evidence levels' : 'Show evidence levels'}
      </button>
      {open && (
        <div className="rubric-panel" role="region" aria-label="Evidence levels">
          {levels ? (
            <ul>
              {order
                .filter((k) => levels[k])
                .map((k) => (
                  <li key={k}>
                    <span className="rubric-level">{k}:</span> {levels[k]}
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
