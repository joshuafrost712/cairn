import { describe, it, expect } from 'vitest'
import { DEFAULT_SCALE } from '../src/lib/scale'
import { validateObservation, isOnScale } from '../src/ai/contract'

const valid = {
  participant_name: 'CIT One',
  participant_id: 'p-1',
  ksa_code: 'GENRE',
  text: 'summary',
  source_excerpt: 'quote',
  evidence_designation: 3,
  sentiment_flag: 'strong',
  confidence: 'high',
  needs_review: false,
  origin: 'individual',
}

describe('validateObservation', () => {
  it('accepts a well-formed observation', () => {
    const r = validateObservation(valid)
    expect(r.ok).toBe(true)
  })

  it('allows a null participant_id', () => {
    expect(validateObservation({ ...valid, participant_id: null }).ok).toBe(true)
  })

  it('rejects a designation that is not an integer', () => {
    expect(validateObservation({ ...valid, evidence_designation: 2.5 }).ok).toBe(false)
    expect(validateObservation({ ...valid, evidence_designation: '2' }).ok).toBe(false)
  })

  it('accepts any integer here, because this pass does not know the scale (tl-09)', () => {
    // Range is not this function's job any more. Which workshop a routed file
    // belongs to is resolved from the participants it names, so the scale check
    // happens in a second pass — `isOnScale` — once that is known.
    expect(validateObservation({ ...valid, evidence_designation: 4 }).ok).toBe(true)
    expect(validateObservation({ ...valid, evidence_designation: 5 }).ok).toBe(true)
  })

  it('isOnScale is what refuses a value the workshop does not define', () => {
    const four = validateObservation({ ...valid, evidence_designation: 4 })
    expect(four.ok).toBe(true)
    if (!four.ok) return
    expect(isOnScale(four.value, DEFAULT_SCALE)).toBe(false)
    expect(isOnScale({ ...four.value, evidence_designation: 3 }, DEFAULT_SCALE)).toBe(true)
  })

  it('rejects bad enums', () => {
    expect(validateObservation({ ...valid, sentiment_flag: 'mixed' }).ok).toBe(false)
    expect(validateObservation({ ...valid, confidence: 'sure' }).ok).toBe(false)
    expect(validateObservation({ ...valid, origin: 'team' }).ok).toBe(false)
  })

  it('rejects a non-boolean needs_review and missing fields', () => {
    expect(validateObservation({ ...valid, needs_review: 'yes' }).ok).toBe(false)
    const { text, ...missing } = valid
    void text
    expect(validateObservation(missing).ok).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(validateObservation(null).ok).toBe(false)
    expect(validateObservation('x').ok).toBe(false)
  })
})
