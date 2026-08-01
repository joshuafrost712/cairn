import { LazyMotion } from 'motion/react'
import { useAuth } from '../auth/AuthContext'
import { Hero } from './welcome/Hero'
import { SceneA } from './welcome/SceneA'
import { SceneB } from './welcome/SceneB'
import { SceneC } from './welcome/SceneC'
import { SceneD } from './welcome/SceneD'
import { SceneE } from './welcome/SceneE'
import { Trust } from './welcome/Trust'
import { Closing } from './welcome/Closing'
import '../styles/welcome.css'

/**
 * The public landing and the tour.
 *
 * Reachable signed out at `/welcome`, which is also the pitch link Joshua sends
 * people, and still reachable signed in so the tour can be shown in a meeting from
 * an account that is already logged in.
 *
 * Everything expensive is confined to this chunk. `React.lazy` splits the page,
 * the CSS import above rides along in the same split, `LazyMotion` defers the
 * animation bundle to a further fetch, and `strict` makes `motion.div` throw so no
 * component in here can quietly reach for the eager import and drag the library
 * back into the shell every evaluator downloads. `test/welcomeChunk.test.ts`
 * asserts the other half of that: no motion import anywhere outside
 * `src/pages/welcome/`.
 *
 * Scene order is the argument, not a layout: the problem (A), then what replaces
 * it (B, C, D), then the two side by side (E), then what the technology is allowed
 * to do (trust), then the way in.
 */
const loadFeatures = () => import('./welcome/motionFeatures').then((m) => m.default)

export function Welcome() {
  const { identity } = useAuth()
  const signedIn = identity != null

  return (
    <LazyMotion features={loadFeatures} strict>
      <div className="wel">
        <Hero signedIn={signedIn} />
        <SceneA />
        <SceneB />
        <SceneC />
        <SceneD />
        <SceneE />
        <Trust />
        <Closing signedIn={signedIn} />
      </div>
    </LazyMotion>
  )
}