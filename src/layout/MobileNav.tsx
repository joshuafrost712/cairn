import { useEffect, useRef } from 'react'
import { c } from '../lib/content/chrome'
import { Nav } from './Nav'

/**
 * The navigation drawer below the sidebar breakpoint.
 *
 * Structurally the same shape as the dev-feedback drawer (scrim plus a fixed
 * panel, Escape to close), but with its own classes: the `.dfb-` styles are
 * deliberately self-contained so the widget works in a host app with no design
 * system, and borrowing them here would couple the app's chrome to a dev tool.
 */
export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Move focus into the drawer so the next Tab lands inside it rather than
    // continuing through the page behind the scrim.
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-wrap drawer-wrap--nav">
      <button className="drawer-scrim" aria-label={c('nav.aria.close-menu')} onClick={onClose} />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={c('nav.aria.main')}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="row">
          <strong>{c('nav.menu')}</strong>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            {c('nav.close')}
          </button>
        </div>
        <Nav onNavigate={onClose} />
      </div>
    </div>
  )
}
