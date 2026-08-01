import { useRef } from 'react'
import { m, useInView, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { FlowPath } from './diagrams/FlowPath'
import { ObsChip } from './diagrams/ObsChip'
import { ReportCard } from './diagrams/ReportCard'
import type { Designation } from './diagrams/ramp'
import { SceneSection } from './SceneSection'
import { useCountUp } from './useCountUp'

/**
 * Scene D: compilation. Confirmed evidence becomes one report per participant.
 *
 * The card's cells fill from the product's own `--d0`..`--d3` ramp with the
 * numeral always rendered, so the tour looks like the screen it is advertising
 * rather than like a marketing illustration of it. Those four designations are
 * illustrative values, not copy: they exist to show the ramp, which is why they
 * live here as numbers and not in chrome.json.
 */

const CELLS: Designation[] = [2, 3, 1, 3]
const BEHIND = 14

const CHIP_X = 16
const CHIP_YS = [40, 84, 128, 172]
const CARD_X = 250
const CARD_Y = 90

const rollUp = (delay: number): Variants => ({
  hidden: { opacity: 0, x: -14 },
  shown: { opacity: 1, x: 0, transition: { duration: 0.45, delay } },
})

const drawIn = (delay: number): Variants => ({
  hidden: { pathLength: 0, opacity: 0 },
  shown: { pathLength: 1, opacity: 1, transition: { duration: 0.5, delay, ease: 'easeInOut' } },
})

const cardIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  shown: { opacity: 1, scale: 1, transition: { duration: 0.45, delay: 1.15 } },
}

const cellIn: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
}

export function SceneD() {
  const reduce = useReducedMotion() ?? false
  const animated = !reduce
  const ref = useRef<HTMLParagraphElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.4 })
  const behind = useCountUp(BEHIND, { run: animated && inView, durationMs: 1100, delayMs: 500 })

  const paths = CHIP_YS.map(
    (y) => `M ${CHIP_X + 48} ${y + 10} C 140 ${y + 10} 190 ${CARD_Y + 30} ${CARD_X - 6} ${CARD_Y + 30}`,
  )

  const body = (
    <>
      {paths.map((d, i) =>
        animated ? (
          <FlowPath key={`p${i}`} d={d} animated variants={drawIn(0.5 + i * 0.12)} />
        ) : (
          <FlowPath key={`p${i}`} d={d} />
        ),
      )}
      {CHIP_YS.map((y, i) => (
        <ObsChip
          key={`c${i}`}
          x={CHIP_X}
          y={y}
          tone="confirmed"
          variants={animated ? rollUp(0.1 + i * 0.12) : undefined}
        />
      ))}
      <ReportCard
        x={CARD_X}
        y={CARD_Y}
        w={130}
        cells={CELLS}
        variants={animated ? cardIn : undefined}
        cellVariants={animated ? cellIn : undefined}
        cellTransition={animated ? (i) => ({ duration: 0.3, delay: 1.5 + i * 0.14 }) : undefined}
      />
      <text x={315} y={78} textAnchor="middle" fontSize={12} fill="var(--muted)">
        {c('welcome.people.participant')}
      </text>
    </>
  )

  return (
    <SceneSection
      base="welcome.scene-d"
      viewBox="0 0 420 230"
      figure={
        animated ? (
          <m.g initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
            {body}
          </m.g>
        ) : (
          <g>{body}</g>
        )
      }
      figureAlt="welcome.scene-d.figure-alt"
      flip
      figureCaption={
        <p className="wel-figcaption" ref={ref}>
          <Copy id="welcome.scene-d.count" tokens={{ count: behind }} />
        </p>
      }
    />
  )
}
