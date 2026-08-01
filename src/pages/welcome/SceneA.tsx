import { m, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { c } from '../../lib/content/chrome'
import { EvaluatorDot } from './diagrams/EvaluatorDot'
import { ObsChip } from './diagrams/ObsChip'
import { ReportCard } from './diagrams/ReportCard'
import { SceneSection } from './SceneSection'

/**
 * Scene A: the problem. Observations that were never written down.
 *
 * The animation's end state is deliberately EMPTY — the chips fade to nothing,
 * because that is the honest picture of a week evaluated from memory. Which means
 * the reduced-motion branch cannot simply render the end state, the way every
 * other scene does: it would be a blank diagram. So it renders the chips in the
 * `lost` tone instead, dashed and muted, which says the same thing in one still
 * frame. The scene's own caption (the `guidance` field of its body copy) carries
 * the meaning either way.
 */

/** Where each un-recorded note starts, and which way it drifts as it is forgotten. */
const LOST: Array<{ x: number; y: number; dx: number; dy: number }> = [
  { x: 16, y: 98, dx: -10, dy: 22 },
  { x: 18, y: 42, dx: -10, dy: -20 },
  { x: 352, y: 98, dx: 10, dy: 22 },
  { x: 350, y: 42, dx: 10, dy: -20 },
  { x: 140, y: 262, dx: -16, dy: 10 },
  { x: 232, y: 262, dx: 16, dy: 10 },
]

const drift = (dx: number, dy: number, delay: number): Variants => ({
  hidden: { opacity: 0, x: 0, y: 0 },
  shown: {
    opacity: [0, 1, 1, 0],
    x: [0, 0, dx, dx],
    y: [0, 0, dy, dy],
    transition: { duration: 2, delay, times: [0, 0.15, 0.72, 1], ease: 'easeOut' },
  },
})

/**
 * What is left after the notes have gone: the same dashed ghosts the
 * reduced-motion branch renders, faded in where the chips used to be.
 *
 * Without this the animated branch ends on an empty diagram while the
 * reduced-motion branch ends on the ghosts, and the two tell different stories.
 * It also matters for anyone who arrives at this section late or pauses on it in a
 * meeting: "nothing here" and "nothing here, and here is the shape of what was
 * lost" are not the same picture, and only the second one is an argument.
 */
const residue: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.6, delay: 2.15 } },
}

const endState: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.5, delay: 2.5 } },
}

function Participant() {
  return (
    <g>
      <rect
        x={160}
        y={129}
        width={100}
        height={42}
        rx={8}
        fill="var(--card)"
        stroke="var(--line-strong)"
      />
      <text
        x={210}
        y={150}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12}
        fill="var(--ink)"
      >
        {c('welcome.people.participant')}
      </text>
    </g>
  )
}

function Evaluators() {
  return (
    <g>
      <EvaluatorDot x={58} y={72} initials={c('welcome.people.ev-1')} />
      <EvaluatorDot x={362} y={72} initials={c('welcome.people.ev-2')} />
      <EvaluatorDot x={210} y={252} initials={c('welcome.people.ev-3')} />
    </g>
  )
}

/** The end of the week: a label and an outline with nothing in it. */
function EmptyEnd({ animated }: { animated: boolean }) {
  const body = (
    <>
      <text
        x={344}
        y={186}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted)"
      >
        {c('welcome.scene-a.end-label')}
      </text>
      <ReportCard x={286} y={196} empty />
      <text x={344} y={276} textAnchor="middle" fontSize={11} fill="var(--muted)">
        {c('welcome.scene-a.empty')}
      </text>
    </>
  )
  if (!animated) return <g>{body}</g>
  return <m.g variants={endState}>{body}</m.g>
}

export function SceneA() {
  const reduce = useReducedMotion() ?? false

  const figure = reduce ? (
    <g>
      <Participant />
      <Evaluators />
      {LOST.map((p, i) => (
        <ObsChip key={i} x={p.x} y={p.y} tone="lost" />
      ))}
      <EmptyEnd animated={false} />
    </g>
  ) : (
    <m.g initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
      <Participant />
      <Evaluators />
      {LOST.map((p, i) => (
        <ObsChip key={i} x={p.x} y={p.y} tone="kept" variants={drift(p.dx, p.dy, 0.1 + i * 0.18)} />
      ))}
      <m.g variants={residue}>
        {LOST.map((p, i) => (
          <ObsChip key={i} x={p.x} y={p.y} tone="lost" />
        ))}
      </m.g>
      <EmptyEnd animated />
    </m.g>
  )

  return (
    <SceneSection base="welcome.scene-a" anchor="tour" figure={figure} figureAlt="welcome.scene-a.figure-alt" />
  )
}
