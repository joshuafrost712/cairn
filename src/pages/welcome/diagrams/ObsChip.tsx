import { m } from 'motion/react'
import type { Variants } from 'motion/react'

/**
 * One observation, as a small rounded note.
 *
 * Deliberately textless. A chip is 46 units wide in a viewBox that renders at
 * about 360px on a phone, so any real words inside it would be unreadable; the
 * two rules stand in for writing and the prose beside the diagram carries the
 * meaning. That also keeps the diagram out of the business of inventing sample
 * observation text, which would read as real evidence.
 *
 * Four tones, and only four, because they are the four states the tour narrates:
 *   kept      — captured and held
 *   lost      — the problem scene: never written down, so it has no substance
 *   confirmed — past the verification gate, so it takes the darkest ramp step
 *   flagged   — evaluators disagreed, so a person has to resolve it
 *
 * `lost` is the one place in the app that draws a dashed outline. tokens.css
 * reserves dashes ("hairline: 1px SOLID, never dashed") for exactly this reason:
 * a dash here is not decoration and not a hairline, it means "this is not a real
 * record", which is the single idea Scene A exists to land.
 */
export type ChipTone = 'kept' | 'lost' | 'confirmed' | 'flagged'

export interface ObsChipProps {
  x: number
  y: number
  tone?: ChipTone
  w?: number
  h?: number
  /** Motion variants. Omitted for a static render; see each scene's `static` branch. */
  variants?: Variants
  /** Passed straight through to the motion element, for per-chip transition delays. */
  transition?: Record<string, unknown>
}

interface ToneStyle {
  fill: string
  stroke: string
  dash?: string
  rule: string
  ruleOpacity: number
}

const TONES: Record<ChipTone, ToneStyle> = {
  kept: { fill: 'var(--d0)', stroke: 'var(--d1)', rule: 'var(--d3)', ruleOpacity: 0.45 },
  lost: {
    fill: 'var(--card)',
    stroke: 'var(--line-strong)',
    dash: '3 3',
    rule: 'var(--muted)',
    ruleOpacity: 0.5,
  },
  confirmed: { fill: 'var(--d3)', stroke: 'var(--d3)', rule: '#ffffff', ruleOpacity: 0.6 },
  flagged: { fill: 'var(--wash-warn)', stroke: 'var(--warn)', rule: 'var(--warn)', ruleOpacity: 0.6 },
}

export function ObsChip({
  x,
  y,
  tone = 'kept',
  w = 46,
  h = 20,
  variants,
  transition,
}: ObsChipProps) {
  const t = TONES[tone]
  // The group is the animated unit, so a chip's rules travel with its body and a
  // scene never has to animate four elements in lockstep.
  return (
    <m.g variants={variants} transition={transition}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={5}
        fill={t.fill}
        stroke={t.stroke}
        strokeWidth={1}
        strokeDasharray={t.dash}
      />
      <rect
        x={x + 6}
        y={y + 6}
        width={w - 16}
        height={2}
        rx={1}
        fill={t.rule}
        opacity={t.ruleOpacity}
      />
      <rect
        x={x + 6}
        y={y + 11}
        width={w - 24}
        height={2}
        rx={1}
        fill={t.rule}
        opacity={t.ruleOpacity}
      />
    </m.g>
  )
}