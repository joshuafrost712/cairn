/**
 * The animation feature bundle, in its own module so `LazyMotion` can fetch it.
 *
 * `domAnimation` carries animations, exit, and the gesture features — including
 * `inView`, which every scene's `whileInView` reveal depends on. `domMax` would
 * add drag, pan, and layout animations; nothing on this page uses them and they
 * are the expensive half of the library, so the smaller bundle is the deliberate
 * choice, not the default.
 *
 * Paired with `LazyMotion strict`, which makes `motion.div` throw so a component
 * cannot silently opt out of the lazy bundle by using the eager import. Every
 * animated element on this page is an `m.*`.
 */
export { domAnimation as default } from 'motion/react'
