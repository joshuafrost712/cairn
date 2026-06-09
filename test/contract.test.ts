import { describe, it, expect } from 'vitest'
import { validateObservation } from '../src/ai/contract'

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

  it('rejects an out-of-range designation', () => {
    const r = validateObservation({ ...valid, evidence_designation: 4 })
    expect(r.ok).toBe(false)
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
