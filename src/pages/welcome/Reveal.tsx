import type { ReactNode } from 'react'
import { m, useReducedMotion } from 'motion/react'

/**
 * A block that fades and rises into place once, when it is scrolled to.
 *
 * The reduced-motion branch renders a PLAIN div, not the same motion element with
 * a zero duration. That distinction is the whole point: an `initial` opacity of 0
 * that never resolves is the classic way a scroll-reveal page renders as blank,
 * and the safest defence is for the element to have no `initial` at all when
 * animation is not wanted. `scripts/ui-responsive-audit.mjs` asserts computed
 * opacity 1 on every heading under `prefers-reduced-motion` for exactly this.
 */
export interface RevealProps {
  children: ReactNode
  className?: string
  delay?: number
  /** Fraction of the block that must be visible before it reveals. */
  amount?: number
}

export function Reveal({ children, className, delay = 0, amount = 0.4 }: RevealProps) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.5, delay, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </m.div>
  )
}
