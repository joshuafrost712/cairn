import { useState } from 'react'
import type { ReactNode } from 'react'

/**
 * A destructive button that arms itself first.
 *
 * Two strengths, because the two risks are different sizes. A `phrase` demands
 * the exact word typed out and is for anything that touches every table at once
 * (restore, demo reseed): a mis-click there costs a workshop's evidence, and the
 * only reliable guard against a mis-click is making the action impossible to
 * perform by clicking. Without a phrase it is a two-step arm-and-confirm, which
 * is enough for a single roster row.
 *
 * Deliberately not `window.confirm`: that blocks the whole tab, cannot say what
 * exactly is about to happen, and is styled by the browser rather than by us.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  phrase,
  warning,
  disabled,
  onConfirm,
  className = 'ghost small',
}: {
  label: string
  /** Wording on the armed button. Say what will happen, not "OK". */
  confirmLabel: string
  /** When set, the confirm button stays disabled until this is typed exactly. */
  phrase?: string
  warning?: ReactNode
  disabled?: boolean
  onConfirm: () => void | Promise<void>
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const [typed, setTyped] = useState('')

  const reset = () => {
    setArmed(false)
    setTyped('')
  }

  if (!armed) {
    return (
      <button className={className} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    )
  }

  const ready = !phrase || typed.trim() === phrase

  return (
    <div className="confirm">
      {warning && <div className="banner warn">{warning}</div>}
      {phrase && (
        <>
          <label className="small muted" htmlFor={`confirm-${phrase}`}>
            Type <strong>{phrase}</strong> to continue:
          </label>
          <input
            id={`confirm-${phrase}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
      <div className="row">
        <button
          className="danger"
          disabled={disabled || !ready}
          onClick={async () => {
            await onConfirm()
            reset()
          }}
        >
          {confirmLabel}
        </button>
        <button className="ghost" onClick={reset}>
          Cancel
        </button>
      </div>
    </div>
  )
}
