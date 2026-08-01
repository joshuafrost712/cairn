import { Copy } from './Copy'
import { Mark } from './Mark'

/**
 * The one screen that means "wait".
 *
 * Two callers, deliberately the same component. The auth check ("we have not
 * resolved the stored session yet") must never flash the sign-in form or the
 * landing page at somebody who is already signed in, and the Suspense fallback
 * while the tour chunk downloads must not flash a blank page. Both are the same
 * promise to the visitor, so they look identical instead of being two different
 * loading treatments that read as two different problems.
 *
 * Carries no motion import: it lives in the main chunk, and a spinner is not worth
 * pulling an animation library into the bundle every evaluator downloads.
 */
export function Splash() {
  return (
    <main className="app-splash">
      <Mark size={40} />
      <Copy id="welcome.splash" as="p" className="muted small" />
    </main>
  )
}
