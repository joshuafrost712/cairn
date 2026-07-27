import { describe, expect, it } from 'vitest'
import { readRefField, refFieldLabel, writeRefField } from '../src/devfeedback/refField'

// The dotted field path is the contract between three places: the data-dfb-field
// attribute in the DOM, the value the edit panel opens on, and the write applied
// on approval. If read and write ever disagree, the staleness guard silently
// blocks every apply (read returns '' while oldText holds the real string), so
// these cases are worth pinning.

const ksa = {
  id: 'k1',
  short_label: 'CLAT facilitation',
  guiding_questions: ['How did they open?', 'Who did they defer to?'],
  evidence_levels: { '0': 'no evidence', '3': 'led it' },
}

describe('readRefField', () => {
  it('reads a plain column', () => {
    expect(readRefField(ksa, 'short_label')).toBe('CLAT facilitation')
  })

  it('reads an array element by index', () => {
    expect(readRefField(ksa, 'guiding_questions.1')).toBe('Who did they defer to?')
  })

  it('reads a record entry by key', () => {
    expect(readRefField(ksa, 'evidence_levels.3')).toBe('led it')
  })

  it('returns empty string for a missing field, index, or row', () => {
    expect(readRefField(ksa, 'nope')).toBe('')
    expect(readRefField(ksa, 'guiding_questions.9')).toBe('')
    expect(readRefField(ksa, 'evidence_levels.2')).toBe('')
    expect(readRefField(null, 'short_label')).toBe('')
  })
})

describe('writeRefField', () => {
  it('sets a plain column without mutating the source row', () => {
    const next = writeRefField(ksa, 'short_label', 'CLAT drafting')
    expect(next.short_label).toBe('CLAT drafting')
    expect(ksa.short_label).toBe('CLAT facilitation')
  })

  it('replaces one array element and leaves its siblings alone', () => {
    const next = writeRefField(ksa, 'guiding_questions.0', 'How did they begin?')
    expect(next.guiding_questions).toEqual(['How did they begin?', 'Who did they defer to?'])
    // The source array must not be spliced in place: it is a live Dexie object,
    // and an in-place edit would leak into the cache before the write lands.
    expect(ksa.guiding_questions[0]).toBe('How did they open?')
  })

  it('replaces one evidence anchor and leaves the others alone', () => {
    const next = writeRefField(ksa, 'evidence_levels.0', 'nothing observed')
    expect(next.evidence_levels).toEqual({ '0': 'nothing observed', '3': 'led it' })
    expect(ksa.evidence_levels['0']).toBe('no evidence')
  })

  it('round-trips with readRefField for every shape', () => {
    for (const field of ['short_label', 'guiding_questions.1', 'evidence_levels.3']) {
      expect(readRefField(writeRefField(ksa, field, 'edited'), field)).toBe('edited')
    }
  })

  it('creates the container implied by the path when it is absent', () => {
    const bare = { id: 'k2' }
    expect(readRefField(writeRefField(bare, 'guiding_questions.0', 'first'), 'guiding_questions.0')).toBe('first')
    expect(readRefField(writeRefField(bare, 'evidence_levels.2', 'some'), 'evidence_levels.2')).toBe('some')
  })
})

describe('refFieldLabel', () => {
  it('names plain and indexed fields readably', () => {
    expect(refFieldLabel('evaluator_facing_prompt')).toBe('observation cue')
    expect(refFieldLabel('guiding_questions.2')).toBe('guiding question 2')
    expect(refFieldLabel('evidence_levels.3')).toBe('evidence anchor 3')
  })
})
