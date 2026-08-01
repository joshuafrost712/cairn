import { m } from 'motion/react'
import type { Variants } from 'motion/react'

/**
 * The line an observation travels along.
 *
 * Two modes on purpose. `animated` draws itself with pathLength, which is the one
 * effect that reads as "this note went somewhere" rather than "a line appeared".
 * Static renders the same path already drawn, which is what every reduced-motion
 * branch uses: the path is part of the diagram's meaning, not the decoration on
 * top of it, so it must never be a thing you only see if you allow animation.
 */
export interface FlowPathProps {
  d: string
  animated?: boolean
  variants?: Variants
  transition?: Record<string, unknown>
  strokeWidth?: number
  /** Dashed only where the line means "this went nowhere" (Scene A and E's left lane). */
  dash?: string
  stroke?: string
}

export function FlowPath({
  d,
  animated = false,
  variants,
  transition,
  strokeWidth = 1.5,
  dash,
  stroke = 'var(--line-strong)',
}: FlowPathProps) {
  const shared = {
    d,
    fill: 'none',
    stroke,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeDasharray: dash,
  }
  if (!animated) return <path {...shared} />
  // pathLength and strokeDasharray fight over the same SVG attribute, so an
  // animated path is never also a dashed one. Enforced here rather than left to
  // each scene, because the failure mode is a path that silently never draws.
  return <m.path {...shared} strokeDasharray={undefined} variants={variants} transition={transition} />
}