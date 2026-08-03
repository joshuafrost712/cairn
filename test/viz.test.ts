import { describe, it, expect } from 'vitest'
import {
  DEEMPH_FILL,
  EMPTY_FILL,
  designationFill,
  designationInk,
  fillFor,
  isDeemphasized,
  levelWord,
  rampStep,
  shouldLabelSegment,
} from '../src/components/viz/viz'
import { DEFAULT_SCALE, buildScale, normalizeScalePoints } from '../src/lib/scale'

const D = DEFAULT_SCALE

/** A 1-5 scale where only the bottom point calls for a conversation. */
const FIVE = buildScale(
  'w1',
  normalizeScalePoints('w1', [
    { value: 1, label: 'well below', description: null, is_low_trigger: true },
    { value: 2, label: 'below', description: null, is_low_trigger: false },
    { value: 3, label: 'meets', description: null, is_low_trigger: false },
    { value: 4, label: 'above', description: null, is_low_trigger: false },
    { value: 5, label: 'well above', description: null, is_low_trigger: false },
  ]),
)

describe('designation colour rules', () => {
  it('returns a token reference, never a literal colour, so dark mode is a values-only change', () => {
    expect(designationFill(0, D)).toBe('var(--d-4-0)')
    expect(designationFill(3, D)).toBe('var(--d-4-3)')
  })

  it('colours by POSITION on the workshop scale, not by the number itself', () => {
    // The bottom point of a 1-5 scale takes the bottom of the 5-step ramp, the
    // same way 0 takes the bottom of the 4-step one. Colouring by the number
    // would paint the worst score there is in the second-lightest step.
    expect(designationFill(1, FIVE)).toBe('var(--d-5-0)')
    expect(designationFill(5, FIVE)).toBe('var(--d-5-4)')
  })

  it('flips ink at the step where the ramp stops taking dark text', () => {
    expect(designationInk(0, D)).toBe('var(--d-4-0-ink)')
    expect(designationInk(3, D)).toBe('var(--d-4-3-ink)')
  })

  it('falls back to the empty surface for a value the scale does not define', () => {
    // Not clamped onto the nearest point: a designation nobody can label is a
    // data error, and painting it as a real score would hide it.
    expect(designationFill(9, D)).toBe(EMPTY_FILL)
    expect(designationFill(0, FIVE)).toBe(EMPTY_FILL)
  })

  it('renders a null value on the empty surface, never as a zero', () => {
    expect(fillFor(null, D)).toBe(EMPTY_FILL)
    expect(fillFor(null, D)).not.toBe(designationFill(0, D))
  })
})

describe('at-risk emphasis mode', () => {
  it('keeps the low-trigger fills and greys out everything else', () => {
    expect(fillFor(0, D, true)).toBe(designationFill(0, D))
    expect(fillFor(1, D, true)).toBe(designationFill(1, D))
    expect(fillFor(2, D, true)).toBe(DEEMPH_FILL)
    expect(fillFor(3, D, true)).toBe(DEEMPH_FILL)
  })

  it('follows the trigger flags rather than a threshold', () => {
    // On this scale only 1 is a trigger, so 2 greys out even though it is the
    // second-lowest point. A `d <= 1` rule would have greyed it and agreed by
    // accident; a `d <= 2` rule would have kept it and been wrong.
    expect(fillFor(1, FIVE, true)).toBe(designationFill(1, FIVE))
    expect(fillFor(2, FIVE, true)).toBe(DEEMPH_FILL)
    expect(isDeemphasized(2, FIVE, true)).toBe(true)
    expect(isDeemphasized(1, FIVE, true)).toBe(false)
  })

  it('changes nothing when the toggle is off', () => {
    expect(fillFor(3, D, false)).toBe(designationFill(3, D))
    expect(isDeemphasized(3, D, false)).toBe(false)
  })

  it('never de-emphasizes an empty cell, which has no value to rank', () => {
    expect(isDeemphasized(null, D, true)).toBe(false)
    expect(fillFor(null, D, true)).toBe(EMPTY_FILL)
  })
})

describe('rampStep', () => {
  it('snaps a mean onto the nearest point of the scale', () => {
    expect(rampStep(0.4, D)).toBe(0)
    expect(rampStep(1.5, D)).toBe(2)
    expect(rampStep(2.4, D)).toBe(2)
  })

  it('snaps onto a real point of a scale that does not start at zero', () => {
    expect(rampStep(1.2, FIVE)).toBe(1)
    expect(rampStep(3.6, FIVE)).toBe(4)
  })

  it('clamps outside the domain rather than producing an undefined token', () => {
    expect(rampStep(-3, D)).toBe(0)
    expect(rampStep(99, D)).toBe(3)
    expect(rampStep(-3, FIVE)).toBe(1)
    expect(rampStep(99, FIVE)).toBe(5)
  })
})

describe('levelWord', () => {
  it("uses the workshop's own word for a point", () => {
    expect(levelWord(D, 2)).toBe('competent')
    expect(levelWord(FIVE, 3)).toBe('meets')
  })

  it('falls back to the bare number rather than inventing a word', () => {
    expect(levelWord(FIVE, 9)).toBe('9')
    expect(levelWord(D, null)).toBe('')
  })
})

describe('shouldLabelSegment', () => {
  it('labels a segment holding at least the threshold share', () => {
    expect(shouldLabelSegment(3, 10, 0.12)).toBe(true)
    expect(shouldLabelSegment(12, 100, 0.12)).toBe(true)
  })

  it('skips a sliver too narrow to hold a legible numeral', () => {
    expect(shouldLabelSegment(1, 40, 0.12)).toBe(false)
  })

  it('never labels an empty segment or an empty total', () => {
    expect(shouldLabelSegment(0, 10)).toBe(false)
    expect(shouldLabelSegment(0, 0)).toBe(false)
  })
})
