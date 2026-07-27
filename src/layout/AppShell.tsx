import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { SyncStatusBar } from '../components/SyncStatusBar'
import { c } from '../lib/content/chrome'
import { MobileNav } from './MobileNav'
import { Nav } from './Nav'

/**
 * The app frame.
 *
 * `mode` is a property of the PAGE, not of the user's role. /reports and
 * /observations are worked by evaluators and by the chief, and both want the
 * full screen on a Mac and a single column on a phone; inferring width from role
 * would get that wrong in both directions. The capture flow stays narrow because
 * it is a one-thing-at-a-time task, not because of who is doing it.
 *
 * Narrow pages get no sidebar, but they DO get the same hamburger drawer. The
 * nav has to be reachable from every page or the phone user is stranded: before
 * this, the only route out of Home was a row of links glued to the bottom of the
 * page, and that row is what the drawer replaces.
 */
export function AppShell({ mode }: { mode: 'narrow' | 'wide' }) {
  const { identity, signOut } = useAuth()
  const loc = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const onHome = loc.pathname === '/'
  const wide = mode === 'wide'

  return (
    <div className={`shell shell--${mode}`}>
      <header className="shell__header">
        <div className="shell__headerbar">
          <button
            className="ghost shell__menu-btn"
            aria-label={c('nav.aria.open-menu')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <div>
            <Link className="shell__brand" to="/">
              Throughline
            </Link>{' '}
            {!onHome && (
              <Link className="small" to="/">
                {c('nav.home')}
              </Link>
            )}
            <div className="shell__sub">{c('app.tagline')}</div>
          </div>
          <span className="spacer" />
          <div className="shell__identity">
            <SyncStatusBar />
            {identity && (
              <div className="small">
                {identity.name} <span className="muted">({identity.role})</span>{' '}
                <button className="ghost small" onClick={signOut}>
                  {c('nav.sign-out')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {wide && (
        <div className="shell__nav">
          <Nav />
        </div>
      )}

      <main className="shell__main">
        <div className="shell__content">
          <Outlet />
        </div>
      </main>

      <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  )
}
