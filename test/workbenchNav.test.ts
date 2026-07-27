import { describe, it, expect } from 'vitest'
import { canEditSegment, nextSegmentId } from '../src/workbench/nav'
import type { DocSegment } from '../src/reports/segments'

function seg(id: string, editable = true, kind: DocSegment['kind'] = 'bullet'): DocSegment {
  return { id, kind, text: id, gapAfter: false, evidence: [], editable }
}

const doc = [seg('a'), seg('b', false, 'heading'), seg('c')]

describe('nextSegmentId', () => {
  it('moves down and up', () => {
    expect(nextSegmentId(doc, 'a', 'down')).toBe('b')
    expect(nextSegmentId(doc, 'c', 'up')).toBe('b')
  })

  it('crosses lines nobody can edit, because you still want to read their evidence', () => {
    expect(nextSegmentId(doc, 'a', 'down')).toBe('b')
    expect(nextSegmentId(doc, 'b', 'down')).toBe('c')
  })

  it('stops at the ends rather than wrapping', () => {
    // Wrapping in a document is disorienting: down at the bottom should feel
    // like a wall, not teleport you back to the greeting.
    expect(nextSegmentId(doc, 'c', 'down')).toBe('c')
    expect(nextSegmentId(doc, 'a', 'up')).toBe('a')
  })

  it('jumps to the ends', () => {
    expect(nextSegmentId(doc, 'b', 'home')).toBe('a')
    expect(nextSegmentId(doc, 'b', 'end')).toBe('c')
  })

  it('enters the document sensibly with nothing selected', () => {
    expect(nextSegmentId(doc, null, 'down')).toBe('a')
    expect(nextSegmentId(doc, null, 'up')).toBe('c')
  })

  it('recovers when the selection points at a segment a regeneration removed', () => {
    expect(nextSegmentId(doc, 'gone', 'down')).toBe('a')
  })

  it('returns null on an empty document instead of throwing', () => {
    for (const key of ['up', 'down', 'home', 'end'] as const) {
      expect(nextSegmentId([], 'a', key)).toBe(null)
    }
  })

  it('handles a single-segment document', () => {
    const one = [seg('only')]
    expect(nextSegmentId(one, 'only', 'down')).toBe('only')
    expect(nextSegmentId(one, 'only', 'up')).toBe('only')
  })
})

describe('canEditSegment', () => {
  it('needs both the segment and the draft to allow it', () => {
    expect(canEditSegment(seg('a'), true)).toBe(true)
    expect(canEditSegment(seg('a'), false)).toBe(false)
    expect(canEditSegment(seg('a', false), true)).toBe(false)
  })

  it('is false for a segment that is not there', () => {
    expect(canEditSegment(undefined, true)).toBe(false)
  })
})
