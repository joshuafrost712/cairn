import type { ReactNode } from 'react'
import { m, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { c } from '../../lib/content/chrome'
import { ObsChip } from './diagrams/ObsChip'
import { SceneSection } from './SceneSection'

/**
 * Scene C: the verification gate. People decide.
 *
 * The load-bearing detail is the middle row. Two of the three rows collect their
 * agreeing checks, their gate segment retracts, and the note crosses as confirmed.
 * The middle row gets a disagreement instead: it stays behind the gate wearing a
 * warn-coloured flag, with "a person resolves this" beside it. A tour where
 * everything sails through would be advertising a rubber stamp, and the app's
 * actual claim is the opposite one, that disagreement is surfaced and worked out
 * by people rather than averaged away.
 *
 * Warn is the only status colour on this page, used the way tokens.css requires:
 * on a flag, next to a label, never as a step in the ramp.
 *
 * The gate retracts by animating the bar's `height` rather than `scaleY`. An SVG
 * scale needs a transform origin, and getting that wrong on a rect inside a
 * viewBox fails in the direction nobody notices in review: the bar shrinks toward
 * its middle and the gate never appears to open.
 */

const ROWS = [
  { label: 'welcome.scene-c.rubric-1', y: 84, agreed: true },
  { label: 'welcome.scene-c.rubric-2', y: 158, agreed: false },
  { label: 'welcome.scene-c.rubric-3', y: 232, agreed: true },
]

const GATE_X = 247
const GATE_H = 58
const GATE_STUB = 9
const CHIP_START = 120
const CHIP_END = 300

const retract = (delay: number): Variants => ({
  hidden: { height: GATE_H },
  shown: { height: GATE_STUB, transition: { duration: 0.4, delay, ease: [0.2, 0, 0, 1] } },
})

const cross = (delay: number): Variants => ({
  hidden: { x: 0 },
  shown: { x: CHIP_END - CHIP_START, transition: { duration: 0.55, delay, ease: [0.2, 0, 0, 1] } },
})

const markIn = (delay: number): Variants => ({
  hidden: { opacity: 0, scale: 0.5 },
  shown: { opacity: 1, scale: 1, transition: { duration: 0.28, delay } },
})

/** An evaluator's agreement. */
function AgreeCheck({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M ${x - 5} ${y} L ${x - 1} ${y + 4} L ${x + 5} ${y - 5}`}
      fill="none"
      stroke="var(--d2)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

/** An evaluator who saw it differently. */
function DisagreeMark({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M ${x - 4} ${y - 4} L ${x + 4} ${y + 4} M ${x + 4} ${y - 4} L ${x - 4} ${y + 4}`}
      fill="none"
      stroke="var(--warn)"
      strokeWidth={2}
      strokeLinecap="round"
    />
  )
}

/** The pennant that says a human still owes this note a decision. */
function Flag({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <line x1={x} y1={y - 9} x2={x} y2={y + 8} stroke="var(--warn)" strokeWidth={1.5} />
      <path d={`M ${x} ${y - 9} L ${x + 10} ${y - 5} L ${x} ${y - 1} Z`} fill="var(--warn)" />
    </g>
  )
}

export function SceneC() {
  const animated = !(useReducedMotion() ?? false)

  const rows: ReactNode = ROWS.map((row, i) => {
    const checksAt = 0.2 + i * 0.5
    const clears = row.agreed
    return (
      <g key={row.label}>
        {/* The rubric row the note is being read against. */}
        <text x={14} y={row.y} dominantBaseline="central" fontSize={12} fill="var(--ink)">
          {c(row.label)}
        </text>
        <line
          x1={14}
          y1={row.y + 30}
          x2={406}
          y2={row.y + 30}
          stroke="var(--line)"
          strokeWidth={1}
        />

        {/* The gate segment. Open on a row that cleared, shut on the one that did not. */}
        <m.rect
          x={GATE_X}
          y={row.y - 29}
          width={2.5}
          height={animated || !clears ? GATE_H : GATE_STUB}
          fill={clears ? 'var(--line-strong)' : 'var(--warn)'}
          variants={animated && clears ? retract(checksAt + 0.55) : undefined}
        />

        {/* Static end state puts a cleared note past the gate; animated walks it there. */}
        <ObsChip
          x={animated || !clears ? CHIP_START : CHIP_END}
          y={row.y - 10}
          tone={clears ? 'confirmed' : 'flagged'}
          variants={animated && clears ? cross(checksAt + 0.75) : undefined}
        />

        {/* Who looked at it: two agreeing evaluators clear the threshold, an agree
            and a disagree do not. */}
        {animated ? (
          <>
            <m.g variants={markIn(checksAt)}>
              <AgreeCheck x={186} y={row.y} />
            </m.g>
            <m.g variants={markIn(checksAt + 0.22)}>
              {clears ? <AgreeCheck x={210} y={row.y} /> : <DisagreeMark x={210} y={row.y} />}
            </m.g>
          </>
        ) : (
          <>
            <AgreeCheck x={186} y={row.y} />
            {clears ? <AgreeCheck x={210} y={row.y} /> : <DisagreeMark x={210} y={row.y} />}
          </>
        )}

        {!clears && (
          <>
            <Flag x={172} y={row.y} />
            <text
              x={262}
              y={row.y}
              dominantBaseline="central"
              fontSize={11.5}
              fill="var(--warn)"
            >
              {c('welcome.scene-c.flag')}
            </text>
          </>
        )}
      </g>
    )
  })

  const figure = (
    <>
      <text x={330} y={28} textAnchor="middle" fontSize={12} fill="var(--muted)">
        {c('welcome.scene-c.gate')}
      </text>
      {rows}
    </>
  )

  return (
    <SceneSection
      base="welcome.scene-c"
      figure={
        animated ? (
          <m.g initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
            {figure}
          </m.g>
        ) : (
          <g>{figure}</g>
        )
      }
      figureAlt="welcome.scene-c.figure-alt"
    />
  )
}
