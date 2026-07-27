import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * A side or bottom sheet for drill-down detail.
 *
 * Deliberately not a modal in the blocking sense: you open it from a heatmap
 * cell to read the evidence and close it to carry on scanning, so it stays
 * dismissible by scrim, by Escape, and by its own close button.
 */
export function Drawer({
  open,
  onClose,
  title,
  side = 'right',
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  side?: 'right' | 'bottom'
  children: ReactNode
  footer?: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-wrap">
      <button className="drawer-scrim" aria-label="Close" onClick={onClose} />
      <div
        className={`drawer drawer--${side}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="row">
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
        {footer}
      </div>
    </div>
  )
}
