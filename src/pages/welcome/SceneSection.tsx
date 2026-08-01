import type { ReactNode } from 'react'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { Reveal } from './Reveal'

/**
 * The shell every tour scene renders inside: eyebrow, heading, prose, figure.
 *
 * Scroll-driven rather than a carousel, which was a decision and not a shortcut.
 * Scroll behaves identically on a phone and a laptop, needs no controls, degrades
 * to a plain readable page when animation is off, and can be driven by a
 * presenter's thumb in a meeting. A carousel fails the last three.
 *
 * `data-wel-heading` is what the responsive audit walks: it needs a stable handle
 * on "every scene heading" to assert each one is actually visible with reduced
 * motion on. Do not remove it in a styling pass.
 */
export interface SceneSectionProps {
  /** Chrome id prefix, e.g. "welcome.scene-a". Every string is read off it. */
  base: string
  /** DOM id, so the hero's "see how it works" link can anchor to the first scene. */
  anchor?: string
  figure: ReactNode
  /** Diagram description, for the SVG's accessible name. */
  figureAlt?: string
  /** Put the figure first on wide screens. Alternating keeps a long page moving. */
  flip?: boolean
  /** Rendered under the figure: the scene's caption or live count. */
  figureCaption?: ReactNode
  /** Each scene sizes its own coordinate space; the width stays 420 so they scale alike. */
  viewBox?: string
}

export function SceneSection({
  base,
  anchor,
  figure,
  figureAlt,
  flip = false,
  figureCaption,
  viewBox = '0 0 420 300',
}: SceneSectionProps) {
  const guidance = c(`${base}.body`, 'guidance')
  const hasGuidance = guidance !== `${base}.body`
  return (
    <section className={`wel-scene${flip ? ' wel-scene--flip' : ''}`} id={anchor}>
      <div className="wel-scene__inner">
        <Reveal className="wel-scene__copy">
          <Copy id={`${base}.eyebrow`} as="p" className="wel-eyebrow" />
          <Copy id={`${base}.title`} as="h2" className="wel-scene__title" data-wel-heading={base} />
          <Copy id={`${base}.body`} as="p" className="wel-scene__body" />
          {hasGuidance && (
            <Copy id={`${base}.body`} field="guidance" as="p" className="wel-scene__aside" />
          )}
        </Reveal>
        <Reveal className="wel-scene__figure" delay={0.08}>
          <figure className="wel-figure">
            <svg
              viewBox={viewBox}
              className="wel-figure__svg"
              role="img"
              aria-label={figureAlt ? c(figureAlt) : undefined}
            >
              {figure}
            </svg>
            {figureCaption}
          </figure>
        </Reveal>
      </div>
    </section>
  )
}
