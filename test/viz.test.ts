import { describe, it, expect } from 'vitest'
import {
  DEEMPH_FILL,
  EMPTY_FILL,
  designationFill,
  designationInk,
  fillFor,
  isDeemphasized,
  rampStep,
  shouldLabelSegment,
} from '../src/components/viz/viz'

describe('designation colour rules', () => {
  it('returns a token reference, never a literal colour, so dark mode is a values-only change', () => {
    expect(designationFill(0)).toBe('var(--d0)')
    expect(designationFill(3)).toBe('var(--d3)')
  })

  it('flips ink at the midpoint of the ramp', () => {
    expect(designationInk(0)).toBe('var(--d0-ink)')
    expect(designationInk(1)).toBe('var(--d0-ink)')
    expect(designationInk(2)).toBe('var(--d2-ink)')
    expect(designationInk(3)).toBe('var(--d2-ink)')
  })

  it('renders a null value on the empty surface, never as a zero', () => {
    expect(fillFor(null)).toBe(EMPTY_FILL)
    expect(fillFor(null)).not.toBe(designationFill(0))
  })
})

describe('at-risk emphasis mode', () => {
  it('keeps the at-risk fills and greys out everything above the line', () => {
    expect(fillFor(0, true)).toBe(designationFill(0))
    expect(fillFor(1, true)).toBe(designationFill(1))
    expect(fillFor(2, true)).toBe(DEEMPH_FILL)
    expect(fillFor(3, true)).toBe(DEEMPH_FILL)
  })

  it('changes nothing when the toggle is off', () => {
    expect(fillFor(3, false)).toBe(designationFill(3))
    expect(isDeemphasized(3, false)).toBe(false)
  })

  it('never de-emphasizes an empty cell, which has no value to rank', () => {
    expect(isDeemphasized(null, true)).toBe(false)
    expect(fillFor(null, true)).toBe(EMPTY_FILL)
  })
})

describe('rampStep', () => {
  it('snaps a mean onto the four-step ramp', () => {
    expect(rampStep(0.4)).toBe(0)
    expect(rampStep(1.5)).toBe(2)
    expect(rampStep(2.4)).toBe(2)
  })

  it('clamps outside the domain rather than producing an undefined token', () => {
    expect(rampStep(-3)).toBe(0)
    expect(rampStep(99)).toBe(3)
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
