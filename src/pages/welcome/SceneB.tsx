import { useRef } from 'react'
import { m, useInView, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { EvaluatorDot } from './diagrams/EvaluatorDot'
import { FlowPath } from './diagrams/FlowPath'
import { ObsChip } from './diagrams/ObsChip'
import { SceneSection } from './SceneSection'
import { useCountUp } from './useCountUp'

/**
 * Scene B: capture. The same three evaluators, and nothing is lost.
 *
 * Four notes from three people, because one evaluator watching two activities is
 * the ordinary case and a one-note-per-evaluator diagram would quietly imply
 * otherwise. Each note carries a tick when it lands — a mark, not a printed time:
 * a fake "09:14" on the page reads as real data, and at this scale it would be
 * unreadable anyway. The prose is what says the notes are timestamped.
 */

const CHIP_X = 268
const KEPT = 4

/** Where each note comes from, and which slot inside the participant's record it takes. */
const ARRIVALS: Array<{ fromX: number; fromY: number; slotY: number; path: string }> = [
  { fromX: 61, fromY: 96, slotY: 108, path: 'M 61 96 C 150 96 180 118 266 118' },
  { fromX: 61, fromY: 102, slotY: 136, path: 'M 61 102 C 150 112 180 146 266 146' },
  { fromX: 61, fromY: 166, slotY: 164, path: 'M 61 166 C 150 166 180 174 266 174' },
  { fromX: 61, fromY: 236, slotY: 192, path: 'M 61 236 C 150 236 180 202 266 202' },
]

const draw = (delay: number): Variants => ({
  hidden: { pathLength: 0, opacity: 0 },
  shown: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.55, delay, ease: 'easeInOut' },
  },
})

const travel = (dx: number, dy: number, delay: number): Variants => ({
  hidden: { opacity: 0, x: dx, y: dy },
  shown: {
    opacity: 1,
    x: 0,
    y: 0,
    transition: { duration: 0.6, delay, ease: [0.2, 0, 0, 1] },
  },
})

const tickIn = (delay: number): Variants => ({
  hidden: { opacity: 0, scale: 0.6 },
  shown: { opacity: 1, scale: 1, transition: { duration: 0.25, delay } },
})

function Activities() {
  const items = [
    { id: 'welcome.scene-b.activity-1', x: 20 },
    { id: 'welcome.scene-b.activity-2', x: 130 },
    { id: 'welcome.scene-b.activity-3', x: 272 },
  ]
  return (
    <g>
      {items.map((it) => (
        <g key={it.id}>
          <circle cx={it.x} cy={20} r={3} fill="var(--d1)" />
          <text x={it.x + 9} y={20} dominantBaseline="central" fontSize={12} fill="var(--muted)">
            {c(it.id)}
          </text>
        </g>
      ))}
    </g>
  )
}

function Record() {
  return (
    <g>
      <rect
        x={252}
        y={76}
        width={150}
        height={186}
        rx={10}
        fill="var(--card)"
        stroke="var(--line)"
      />
      <text x={327} y={94} textAnchor="middle" fontSize={12} fill="var(--ink)">
        {c('welcome.people.participant')}
      </text>
    </g>
  )
}

/** The "kept" mark beside a landed note. Geometry, so it invents no data. */
function Tick({ y, animated, delay }: { y: number; animated: boolean; delay: number }) {
  const path = (
    <path
      d={`M 322 ${y} L 326 ${y + 4} L 334 ${y - 5}`}
      fill="none"
      stroke="var(--d2)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
  if (!animated) return path
  return <m.g variants={tickIn(delay)}>{path}</m.g>
}

export function SceneB() {
  const reduce = useReducedMotion() ?? false
  const ref = useRef<HTMLParagraphElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.4 })
  const count = useCountUp(KEPT, { run: !reduce && inView, durationMs: 1400, delayMs: 400 })

  const evaluators = (
    <g>
      <EvaluatorDot x={44} y={96} initials={c('welcome.people.ev-1')} />
      <EvaluatorDot x={44} y={166} initials={c('welcome.people.ev-2')} />
      <EvaluatorDot x={44} y={236} initials={c('welcome.people.ev-3')} />
    </g>
  )

  const figure = reduce ? (
    <g>
      <Activities />
      {evaluators}
      <Record />
      {ARRIVALS.map((a, i) => (
        <FlowPath key={`p${i}`} d={a.path} />
      ))}
      {ARRIVALS.map((a, i) => (
        <g key={`c${i}`}>
          <ObsChip x={CHIP_X} y={a.slotY} tone="kept" />
          <Tick y={a.slotY + 10} animated={false} delay={0} />
        </g>
      ))}
    </g>
  ) : (
    <m.g initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
      <Activities />
      {evaluators}
      <Record />
      {ARRIVALS.map((a, i) => (
        <FlowPath key={`p${i}`} d={a.path} animated variants={draw(0.15 + i * 0.22)} />
      ))}
      {ARRIVALS.map((a, i) => (
        <g key={`c${i}`}>
          <ObsChip
            x={CHIP_X}
            y={a.slotY}
            tone="kept"
            variants={travel(a.fromX - CHIP_X + 20, a.fromY - a.slotY - 10, 0.4 + i * 0.22)}
          />
          <Tick y={a.slotY + 10} animated delay={0.95 + i * 0.22} />
        </g>
      ))}
    </m.g>
  )

  return (
    <SceneSection
      base="welcome.scene-b"
      figure={figure}
      figureAlt="welcome.scene-b.figure-alt"
      flip
      figureCaption={
        <p className="wel-figcaption" ref={ref}>
          <Copy id="welcome.scene-b.count" tokens={{ count }} />
        </p>
      }
    />
  )
}
