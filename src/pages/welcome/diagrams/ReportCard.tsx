import { m } from 'motion/react'
import type { Variants } from 'motion/react'
import { RAMP, RAMP_INK, type Designation } from './ramp'

/**
 * A participant's compiled report, drawn the way the product draws it.
 *
 * The designation cells fill from the real `--d0`..`--d3` ramp and always render
 * the numeral, so somebody who signs in after watching the tour recognises the
 * screen. An `empty` card is the Scene A endpoint: the same outline with nothing
 * in it, which is the only honest picture of a workshop that evaluated on memory.
 */
export interface ReportCardProps {
  x: number
  y: number
  w?: number
  /** One cell per skill area. Empty array renders the outline with no cells. */
  cells?: Designation[]
  /** Outline only, dashed, muted: "there was no evidence to compile." */
  empty?: boolean
  /** Per-cell variants, applied to each cell in order so they can fill in sequence. */
  cellVariants?: Variants
  cellTransition?: (i: number) => Record<string, unknown>
  variants?: Variants
}

const CELL = 22
const GAP = 5

export function ReportCard({
  x,
  y,
  w = 116,
  cells = [],
  empty = false,
  cellVariants,
  cellTransition,
  variants,
}: ReportCardProps) {
  const h = 62
  return (
    <m.g variants={variants}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill={empty ? 'none' : 'var(--card)'}
        stroke={empty ? 'var(--line-strong)' : 'var(--line)'}
        strokeWidth={1}
        strokeDasharray={empty ? '3 3' : undefined}
      />
      {/* The name row. A bar, not text: a diagram that spells out a participant's
          name is inventing a person, and at this scale it would be unreadable
          anyway. */}
      <rect
        x={x + 10}
        y={y + 12}
        width={44}
        height={4}
        rx={2}
        fill={empty ? 'var(--line-strong)' : 'var(--muted)'}
        opacity={empty ? 1 : 0.6}
      />
      {cells.map((value, i) => (
        <m.g key={i} variants={cellVariants} transition={cellTransition?.(i)}>
          <rect
            x={x + 10 + i * (CELL + GAP)}
            y={y + 26}
            width={CELL}
            height={CELL}
            rx={4}
            fill={RAMP[value]}
          />
          <text
            x={x + 10 + i * (CELL + GAP) + CELL / 2}
            y={y + 26 + CELL / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={12}
            fontWeight={600}
            fill={RAMP_INK[value]}
          >
            {value}
          </text>
        </m.g>
      ))}
    </m.g>
  )
}