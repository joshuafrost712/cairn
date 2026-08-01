import { Link } from 'react-router-dom'
import { Copy } from '../../components/Copy'
import { Reveal } from './Reveal'

/**
 * The last card. Somebody who scrolled this far should not have to scroll back up
 * to find the way in.
 */
export function Closing({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="wel-close">
      <Reveal className="wel-close__card">
        <Copy id="welcome.close.title" as="h2" className="wel-close__title" />
        <Copy id="welcome.close.body" as="p" className="wel-close__body" />
        <div className="wel-hero__actions wel-hero__actions--centered">
          {signedIn ? (
            <Link className="wel-btn wel-btn--primary" to="/">
              <Copy id="welcome.hero.cta-app" />
            </Link>
          ) : (
            <Link className="wel-btn wel-btn--primary" to="/signin">
              <Copy id="welcome.close.cta" />
            </Link>
          )}
        </div>
      </Reveal>
    </section>
  )
}
