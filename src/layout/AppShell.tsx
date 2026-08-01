import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Mark } from '../components/Mark'
import { SyncStatusBar } from '../components/SyncStatusBar'
import { c } from '../lib/content/chrome'
import { MobileNav } from './MobileNav'
import { Nav } from './Nav'
import { useWorkshopRole } from './roles'

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
  // The role shown here is the one held in the ACTIVE workshop, not a global
  // rank: the same person can be an admin in one workshop and an evaluator in
  // another, and the header has to say which hat they are wearing right now.
  const role = useWorkshopRole()
  const loc = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const onHome = loc.pathname === '/'
  const wide = mode === 'wide'

  // tl-20: re-run the page-enter animation on every navigation, by taking the class
  // off and putting it back with a forced reflow in between. That is the whole
  // trick, and it is deliberately NOT the obvious `key={loc.pathname}` on the
  // wrapper: /reports and /reports/:participantId are the same <Reports/> element,
  // so React Router keeps one instance across participants, and keying the wrapper
  // would remount it on every selection — throwing away the master list's scroll
  // position and the filter bar's state to play a 220ms fade. Animation is not
  // worth losing state for.
  //
  // React never rewrites className here (the prop is a constant string), so a class
  // added by hand survives re-renders.
  const contentRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    el.classList.remove('shell__content--enter')
    void el.offsetWidth // reflow: without it the class comes back in the same frame and nothing restarts
    el.classList.add('shell__content--enter')
  }, [loc.pathname])

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
          {/* The mark, from tl-19, at header size. Same geometry as the installed
              icon and the landing page, so the app a person opens looks like the
              page that talked them into it. Decorative here: the brand text beside
              it already carries the name, so a second accessible label would make
              screen readers say it twice (Mark is aria-hidden). */}
          <Mark size={28} />
          <div>
            <Link className="shell__brand" to="/">
              Honest Eval
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
                {identity.name}{' '}
                {role && <span className="muted">({c(`role.${role}`)})</span>}{' '}
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
        <div className="shell__content" ref={contentRef}>
          <Outlet />
        </div>
      </main>

      <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  )
}
