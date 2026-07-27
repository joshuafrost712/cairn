import { useState } from 'react'
import { c, chromeNodesByPrefix } from '../lib/content/chrome'

/**
 * Dictation-safe glossary of the shared vocabulary (MTT, CLAT, ANE, …). Collapsed
 * by default; the toggle uses onMouseDown + preventDefault so opening it never
 * blurs an active textarea mid-dictation.
 *
 * Terms come from the chrome content layer (`glossary.term.*`, in file order), so a
 * definition can be fixed in place rather than in code.
 */
export function Glossary() {
  const [open, setOpen] = useState(false)
  const terms = chromeNodesByPrefix('glossary.term.')
  return (
    <div>
      <button
        type="button"
        className="rubric-toggle"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? c('glossary.hide') : c('glossary.show')}
      </button>
      {open && (
        <div className="rubric-panel" role="region" aria-label={c('glossary.region')}>
          <ul>
            {terms.map((g) => (
              <li key={g.id}>
                <strong data-dfb-node={g.id} data-dfb-field="label" data-dfb-source="chrome">
                  {g.label}:
                </strong>{' '}
                <span data-dfb-node={g.id} data-dfb-field="guidance" data-dfb-source="chrome">
                  {g.guidance}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
