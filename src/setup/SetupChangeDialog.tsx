import { useEffect, useRef, useState } from 'react'
import { c } from '../lib/content/chrome'
import type { SetupChange, SetupImpact, SetupSeverity } from './impact'

/**
 * The one dialog. It renders whatever the classifier returned and knows nothing
 * about which form opened it.
 *
 * That is the point: per-form warning prose is how a section ships with a warning
 * that is subtly wrong, or with none at all. Here there is one place where an
 * impact becomes a sentence, and one place to review the wording of all of them.
 *
 * Blocking, unlike src/components/data/Drawer.tsx. A drawer is dismissible because
 * you open it to read something; this interrupts a save that is about to change
 * work other people have done, so scrim-click and Escape CANCEL rather than
 * quietly proceeding, and there is no path where dismissing it commits.
 */
export function SetupChangeDialog({
  change,
  impact,
  busy,
  onCancel,
  onConfirm,
}: {
  change: SetupChange
  impact: SetupImpact
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  // A destructive change requires the entity's name typed back. Compared with the
  // whitespace trimmed and the case folded: the point is to make the person read
  // WHICH thing they are deleting, not to test their typing.
  const nameMatches = typed.trim().toLowerCase() === change.label.trim().toLowerCase()
  const canCommit = !busy && (!impact.requiresTypedName || nameMatches)

  return (
    <div className="setup-modal" role="presentation">
      <button className="setup-modal__scrim" aria-label={c('setup.dialog.cancel')} onClick={() => !busy && onCancel()} />
      <div
        className={`setup-modal__panel setup-modal__panel--${impact.severity}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-dialog-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 id="setup-dialog-title" style={{ margin: 0 }}>
            {c(impact.headlineId)}
          </h2>
          <SeverityPill severity={impact.severity} />
        </div>

        <p className="small muted" style={{ marginTop: 'var(--s-1)' }}>
          {c('setup.dialog.subject', 'label', { label: change.label })}
        </p>

        <ul className="setup-modal__consequences">
          {impact.consequences.map((consequence, i) => (
            <li key={`${consequence.id}-${i}`}>{c(consequence.id, 'label', consequence.tokens)}</li>
          ))}
        </ul>

        {impact.severity !== 'affects_future' && (
          <p className="small muted">{c('setup.dialog.local-scope')}</p>
        )}

        {impact.requiresTypedName && (
          <div className="form-col">
            <label htmlFor="setup-confirm-name" className="small">
              {c('setup.dialog.type-name', 'label', { label: change.label })}
            </label>
            <input
              id="setup-confirm-name"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={change.label}
            />
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--s-3)' }}>
          <button className="ghost" disabled={busy} onClick={onCancel}>
            {c('setup.dialog.cancel')}
          </button>
          <button
            className={impact.severity === 'destructive' ? 'danger' : ''}
            disabled={!canCommit}
            onClick={onConfirm}
          >
            {c(
              impact.severity === 'destructive'
                ? 'setup.dialog.commit-destructive'
                : 'setup.dialog.commit',
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

const PILL_CLASS: Record<SetupSeverity, string> = {
  safe: 'ok',
  affects_future: 'local',
  invalidates_evidence: 'queued',
  destructive: 'error',
}

/** Chrome ids stay kebab-case even though the severity union is snake_case. */
const SEVERITY_ID: Record<SetupSeverity, string> = {
  safe: 'setup.severity.safe',
  affects_future: 'setup.severity.affects-future',
  invalidates_evidence: 'setup.severity.invalidates-evidence',
  destructive: 'setup.severity.destructive',
}

export function SeverityPill({ severity }: { severity: SetupSeverity }) {
  return <span className={`pill ${PILL_CLASS[severity]}`}>{c(SEVERITY_ID[severity])}</span>
}
