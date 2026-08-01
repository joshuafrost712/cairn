import type { ReactNode } from 'react'
import { m, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { EvaluatorDot } from './diagrams/EvaluatorDot'
import { FlowPath } from './diagrams/FlowPath'
import { ObsChip } from './diagrams/ObsChip'
import { ReportCard } from './diagrams/ReportCard'
import type { Designation } from './diagrams/ramp'
import { Reveal } from './Reveal'

/**
 * Scene E: the same week, twice.
 *
 * Both lanes run off ONE trigger, by variant propagation from the wrapper rather
 * than two independent `whileInView` elements. That is the difference between a
 * contrast and two animations that happen to be near each other: the notes have
 * to scatter on the left at the same moment they land on the right, or the beat is
 * lost and the viewer reads two unrelated diagrams.
 *
 * Reduced motion is the strongest still frame on the page — an empty box beside
 * two filled reports — so it gets its own branch rather than the animated end
 * state, which on the left lane is nothing at all.
 */

const DOTS = [
  { y: 40, id: 'welcome.people.ev-1' },
  { y: 100, id: 'welcome.people.ev-2' },
  { y: 160, id: 'welcome.people.ev-3' },
]

const LOST_CELLS: Designation[] = []
const WITH_CELLS_A: Designation[] = [2, 3, 1]
const WITH_CELLS_B: Designation[] = [3, 2, 3]

const scatter = (dx: number, dy: number, delay: number): Variants => ({
  hidden: { opacity: 0, x: 0, y: 0 },
  shown: {
    opacity: [0, 1, 1, 0],
    x: [0, 0, dx, dx],
    y: [0, 0, dy, dy],
    transition: { duration: 1.8, delay, times: [0, 0.15, 0.7, 1], ease: 'easeOut' },
  },
})

const arrive = (dx: number, dy: number, delay: number): Variants => ({
  hidden: { opacity: 0, x: dx, y: dy },
  shown: { opacity: 1, x: 0, y: 0, transition: { duration: 0.6, delay, ease: [0.2, 0, 0, 1] } },
})

const fadeIn = (delay: number): Variants => ({
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.45, delay } },
})

const drawIn = (delay: number): Variants => ({
  hidden: { pathLength: 0, opacity: 0 },
  shown: { pathLength: 1, opacity: 1, transition: { duration: 0.5, delay, ease: 'easeInOut' } },
})

function Dots() {
  return (
    <g>
      {DOTS.map((d) => (
        <EvaluatorDot key={d.id} x={28} y={d.y} initials={c(d.id)} r={13} />
      ))}
    </g>
  )
}

/** The workshop that evaluated from memory. */
function WithoutLane({ animated }: { animated: boolean }) {
  const starts = [
    { x: 56, y: 22, dx: 34, dy: -14 },
    { x: 62, y: 92, dx: 40, dy: 16 },
    { x: 56, y: 158, dx: 30, dy: 22 },
  ]
  return (
    <svg viewBox="0 0 300 200" className="wel-lane__svg" role="presentation">
      <Dots />
      {starts.map((s, i) => (
        <ObsChip
          key={i}
          x={s.x}
          y={s.y}
          tone={animated ? 'kept' : 'lost'}
          w={40}
          h={17}
          variants={animated ? scatter(s.dx, s.dy, 0.1 + i * 0.18) : undefined}
        />
      ))}
      {/* The residue, so the animated lane ends where the reduced-motion lane
          starts: dashed ghosts of the notes, not an empty rectangle. Same reasoning
          as SceneA's `residue`. */}
      {animated && (
        <m.g variants={fadeIn(1.55)}>
          {starts.map((s, i) => (
            <ObsChip key={i} x={s.x} y={s.y} tone="lost" w={40} h={17} />
          ))}
        </m.g>
      )}
      <ReportCard x={196} y={64} w={92} cells={LOST_CELLS} empty />
    </svg>
  )
}

/** The same week, written down as it happened. */
function WithLane({ animated }: { animated: boolean }) {
  const slots = [44, 78, 112]
  const paths = DOTS.map(
    (d, i) => `M 43 ${d.y} C 80 ${d.y} 92 ${slots[i] + 9} 116 ${slots[i] + 9}`,
  )
  return (
    <svg viewBox="0 0 300 200" className="wel-lane__svg" role="presentation">
      <Dots />
      {paths.map((p, i) =>
        animated ? (
          <FlowPath key={`p${i}`} d={p} animated variants={drawIn(0.15 + i * 0.14)} />
        ) : (
          <FlowPath key={`p${i}`} d={p} />
        ),
      )}
      {slots.map((y, i) => (
        <ObsChip
          key={`c${i}`}
          x={118}
          y={y}
          tone="confirmed"
          w={40}
          h={17}
          variants={animated ? arrive(-70, DOTS[i].y - y - 9, 0.35 + i * 0.14) : undefined}
        />
      ))}
      {/* The gate the notes had to clear before they could be compiled. */}
      <line x1={176} y1={28} x2={176} y2={172} stroke="var(--line-strong)" strokeWidth={1.5} />
      <ReportCard
        x={192}
        y={24}
        w={96}
        cells={WITH_CELLS_A}
        variants={animated ? fadeIn(1.15) : undefined}
      />
      <ReportCard
        x={192}
        y={106}
        w={96}
        cells={WITH_CELLS_B}
        variants={animated ? fadeIn(1.32) : undefined}
      />
    </svg>
  )
}

export function SceneE() {
  const animated = !(useReducedMotion() ?? false)

  const lanes: ReactNode = (
    <div className="wel-lanes">
      {/* Both lanes are role="presentation"; the contrast is one idea, so it gets
          one description rather than two half-descriptions. */}
      <p className="wel-sr-only">
        <Copy id="welcome.scene-e.figure-alt" />
      </p>
      <div className="wel-lane">
        <Copy id="welcome.scene-e.without-label" as="p" className="wel-lane__label" />
        <WithoutLane animated={animated} />
        <Copy id="welcome.scene-e.without-caption" as="p" className="wel-lane__caption" />
      </div>
      <div className="wel-lane wel-lane--with">
        <Copy id="welcome.scene-e.with-label" as="p" className="wel-lane__label" />
        <WithLane animated={animated} />
        <Copy
          id="welcome.scene-e.with-caption"
          as="p"
          className="wel-lane__caption wel-lane__caption--with"
        />
      </div>
    </div>
  )

  return (
    <section className="wel-scene wel-scene--wide">
      <div className="wel-scene__inner wel-scene__inner--stacked">
        <Reveal className="wel-scene__copy wel-scene__copy--centered">
          <Copy id="welcome.scene-e.eyebrow" as="p" className="wel-eyebrow" />
          <Copy
            id="welcome.scene-e.title"
            as="h2"
            className="wel-scene__title"
            data-wel-heading="welcome.scene-e"
          />
          <Copy id="welcome.scene-e.body" as="p" className="wel-scene__body" />
        </Reveal>
        {animated ? (
          <m.div initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
            {lanes}
          </m.div>
        ) : (
          <div>{lanes}</div>
        )}
      </div>
    </section>
  )
}
