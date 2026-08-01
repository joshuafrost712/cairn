import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * tl-20's two motion rules, checked by parsing the stylesheet that states them.
 *
 * Neither can be caught by looking at the running app, and that is the whole reason
 * this file exists. An animation that holds a final state looks perfect to the
 * person who wrote it and hides content from every visitor who asked for reduced
 * motion. A staggered entrance with `backwards` fill and an un-zeroed delay flashes
 * a list invisible for a third of a second on exactly those devices. Both are
 * invisible bugs in a literal sense: you cannot see them unless you are the person
 * being harmed by them.
 *
 * The behavioural half (does the drawer actually slide, does the confirm actually
 * pop, does anything overflow a 390px phone) is scripts/ui-responsive-audit.mjs.
 */

const STYLES = join(import.meta.dirname, '..', 'src', 'styles')
const motion = readFileSync(join(STYLES, 'motion.css'), 'utf8')
const tokens = readFileSync(join(STYLES, 'tokens.css'), 'utf8')

/** Strip comments before matching, so a rule named in prose is not read as code. */
const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const motionCode = code(motion)

/** The @media (prefers-reduced-motion: reduce) block at the end of motion.css. */
function reducedMotionBlock(css: string): string {
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
  expect(at, 'motion.css must carry a reduced-motion block').toBeGreaterThan(-1)
  return css.slice(at)
}

/** Every keyframes name declared, and every one referenced by an animation. */
const declared = [...motionCode.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])
const animationDecls = [...motionCode.matchAll(/animation(?:-name)?:\s*([^;}]+)[;}]/g)].map((m) => m[1].trim())

describe('the motion layer is wired to what it declares', () => {
  it('declares at least the animations the spec asked for', () => {
    expect(declared).toEqual(
      expect.arrayContaining([
        'drawer-in',
        'scrim-in',
        'page-enter',
        'confirm-pop',
        'item-in',
        'splash-pulse',
      ]),
    )
  })

  it('references no keyframes name that does not exist', () => {
    const known = new Set([...declared, 'none'])
    const unknown = animationDecls
      .map((decl) => decl.split(/\s+/).find((tok) => known.has(tok) || /^[a-z][\w-]*$/i.test(tok)))
      .filter((name): name is string => name != null && !known.has(name) && !name.startsWith('var('))
    expect(unknown).toEqual([])
  })

  it('is the only stylesheet that animates: no transition or keyframe elsewhere', () => {
    // Motion in one file is what makes the rules below checkable at all. welcome.css
    // is exempt: the landing page is a separate chunk with its own motion budget and
    // its own library, and test/welcomeChunk.test.ts guards that boundary.
    for (const file of ['tokens.css', 'layout.css', 'dashboard.css', 'workbench.css']) {
      const css = code(readFileSync(join(STYLES, file), 'utf8'))
      expect(css, `${file} should not animate; motion.css owns that`).not.toMatch(
        /@keyframes|transition:|animation:/,
      )
    }
  })
})

describe('Rule 1: every animation ends on the natural state', () => {
  it('never holds a final state with a forwards or both fill mode', () => {
    // A held final state is the one way a zero-duration animation can still hide
    // something, which is what reduced motion turns every animation here into.
    expect(motionCode).not.toMatch(/\bforwards\b/)
    expect(motionCode).not.toMatch(/animation-fill-mode:\s*both/)
  })

  it('declares no 100% or `to` keyframe, since the resting style IS the end state', () => {
    const blocks = [...motion.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block, `a keyframe block declares an end state: ${block.trim().slice(0, 60)}`).not.toMatch(
        /(^|\s)(to|100%)\s*\{/,
      )
    }
  })
})

describe('Rule 2: a delay or a loop is switched off by name under reduced motion', () => {
  const reduced = reducedMotionBlock(motionCode)

  it('zeroes the interaction durations in tokens.css', () => {
    // The premise of Rule 1: this is what makes reduced motion free for everything
    // that is neither delayed nor looping.
    const block = code(tokens).slice(code(tokens).indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/--dur-1:\s*0ms/)
    expect(block).toMatch(/--dur-2:\s*0ms/)
  })

  it('names every selector that carries an animation-delay', () => {
    const delayed = [...motionCode.matchAll(/([^{}]+)\{[^{}]*animation-delay:[^{}]*\}/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    )
    expect(delayed.length, 'expected the staggered list to still carry a delay').toBeGreaterThan(0)
    for (const sel of delayed) {
      expect(reduced, `${sel} has an animation-delay and must be disabled under reduced motion`).toContain(sel)
    }
  })

  it('names every selector that loops forever', () => {
    const looping = [...motionCode.matchAll(/([^{}]+)\{[^{}]*animation:[^;}]*infinite[^{}]*\}/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    )
    expect(looping.length, 'expected the splash pulse to still loop').toBeGreaterThan(0)
    for (const sel of looping) {
      expect(reduced, `${sel} loops forever and must be disabled under reduced motion`).toContain(sel)
    }
  })

  it('disables those by name rather than by shortening them', () => {
    expect(reduced).toMatch(/animation:\s*none/)
  })
})
