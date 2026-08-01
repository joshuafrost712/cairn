import { Link } from 'react-router-dom'
import { m, useReducedMotion } from 'motion/react'
import { Copy } from '../../components/Copy'
import { Mark } from '../../components/Mark'

/**
 * The first screen. It has about four seconds to say what this is.
 *
 * The claim is drawn from `docs/ai-transparency.md`'s short version, because that
 * document is the one place the app's promise has already been written carefully
 * and read by the people it is about. Restating it in fresh marketing words here
 * would be how the two drift apart.
 *
 * No webfont, which is a decision rather than an omission: the app is an
 * offline-first PWA whose precache every workshop phone downloads, and a display
 * face would cost more than it buys on a page that has to load on a hotel
 * connection. The hero leans on the system stack at a heavier weight with tighter
 * letter-spacing instead.
 *
 * The primary call to action changes with who is reading. A signed-in visitor
 * revisiting the tour is offered the way back into the app, not a second sign-in.
 */
export function Hero({ signedIn }: { signedIn: boolean }) {
  const reduce = useReducedMotion()
  const rise = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 20 },
        animate: { opacity: 1, y: 0 },
      }

  return (
    <header className="wel-hero">
      {/* The drifting backdrop is CSS only (see welcome.css) so it costs nothing
          and stops entirely under prefers-reduced-motion. */}
      <div className="wel-hero__backdrop" aria-hidden="true">
        <span className="wel-blob wel-blob--1" />
        <span className="wel-blob wel-blob--2" />
        <span className="wel-blob wel-blob--3" />
      </div>

      <div className="wel-hero__inner">
        <m.div className="wel-hero__brand" {...rise} transition={{ duration: 0.5 }}>
          <Mark size={44} />
          <Copy id="welcome.hero.title" as="h1" className="wel-hero__title" />
        </m.div>

        <m.p
          className="wel-hero__claim"
          {...rise}
          transition={{ duration: 0.5, delay: reduce ? 0 : 0.12 }}
        >
          <Copy id="welcome.hero.claim" />
        </m.p>

        <m.p
          className="wel-hero__body"
          {...rise}
          transition={{ duration: 0.5, delay: reduce ? 0 : 0.22 }}
        >
          <Copy id="welcome.hero.body" />
        </m.p>

        <m.div
          className="wel-hero__actions"
          {...rise}
          transition={{ duration: 0.5, delay: reduce ? 0 : 0.32 }}
        >
          {signedIn ? (
            <Link className="wel-btn wel-btn--primary" to="/">
              <Copy id="welcome.hero.cta-app" />
            </Link>
          ) : (
            <Link className="wel-btn wel-btn--primary" to="/signin">
              <Copy id="welcome.hero.cta-signin" />
            </Link>
          )}
          <a className="wel-btn wel-btn--ghost" href="#tour">
            <Copy id="welcome.hero.cta-tour" />
          </a>
        </m.div>
      </div>
    </header>
  )
}
