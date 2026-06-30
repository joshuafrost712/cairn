import { useState } from 'react'
import { GLOSSARY } from '../lib/ruleset'

/**
 * Dictation-safe glossary of the shared vocabulary (MTT, CLAT, ANE, …). Collapsed
 * by default; the toggle uses onMouseDown + preventDefault so opening it never
 * blurs an active textarea mid-dictation.
 */
export function Glossary() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        className="rubric-toggle"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide terms' : 'Terms'}
      </button>
      {open && (
        <div className="rubric-panel" role="region" aria-label="Glossary of terms">
          <ul>
            {GLOSSARY.map((g) => (
              <li key={g.term}>
                <strong>{g.term}:</strong> {g.def}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
