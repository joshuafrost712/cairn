import { describe, it, expect } from 'vitest'
import {
  acknowledgeFlag,
  applyOverrides,
  evidenceKey,
  idVersion,
  makeOverride,
  mergeDraft,
  revertOverride,
} from '../src/drafts/merge'
import { segmentsToMarkdown, type DocSegment } from '../src/reports/segments'
import type { SegmentOverride } from '../src/drafts/types'

const AT = '2026-08-26T21:00:00.000Z'

function seg(id: string, text: string, evidence: string[] = [], gapAfter = false): DocSegment {
  return { id: `v1/${id}`, kind: 'bullet', text, gapAfter, evidence, editable: true }
}

const edit = (s: DocSegment, text: string | null) => makeOverride(s, text, AT, 'josh@sil.org')

describe('evidenceKey', () => {
  it('does not care what order the render gathered the observations in', () => {
    expect(evidenceKey(['b', 'a'])).toBe(evidenceKey(['a', 'b']))
  })
  it('distinguishes a set that gained a member', () => {
    expect(evidenceKey(['a'])).not.toBe(evidenceKey(['a', 'b']))
  })
  it('handles the empty set', () => {
    expect(evidenceKey([])).toBe('')
  })
})

describe('idVersion', () => {
  it('reads the prefix', () => {
    expect(idVersion('v1/pe:p-1/hl/k:GENRE/claim')).toBe('v1')
  })
  it('is null for something with no path at all', () => {
    expect(idVersion('nonsense')).toBe(null)
  })
})

describe('mergeDraft', () => {
  it('carries a clean edit straight over', () => {
    const before = seg('a', 'original', ['o-1'])
    const ov = edit(before, 'my wording')
    const r = mergeDraft({ overrides: [ov] }, [seg('a', 'original', ['o-1'])])
    expect(r.overrides).toEqual([ov])
    expect(r.flags).toEqual([])
    expect(r.orphans).toEqual([])
  })

  it('the regenerated document owns structure; the override only supplies text', () => {
    const ov = edit(seg('a', 'original', ['o-1']), 'mine')
    const regenerated = [seg('b', 'new first'), seg('a', 'original', ['o-1'])]
    const r = mergeDraft({ overrides: [ov] }, regenerated)
    expect(r.segments.map((s) => s.id)).toEqual(['v1/b', 'v1/a'])
  })

  it('flags stale evidence and names what arrived and what left', () => {
    const ov = edit(seg('a', 'original', ['o-1']), 'mine')
    const r = mergeDraft({ overrides: [ov] }, [seg('a', 'original', ['o-1', 'o-2'])])
    // Never silently replaced: the edit stands and the change is surfaced.
    expect(r.overrides).toHaveLength(1)
    expect(r.flags).toEqual([
      { segmentId: 'v1/a', kind: 'stale-evidence', addedEvidence: ['o-2'], removedEvidence: [] },
    ])
  })

  it('reports a removed observation too', () => {
    const ov = edit(seg('a', 'original', ['o-1', 'o-2']), 'mine')
    const r = mergeDraft({ overrides: [ov] }, [seg('a', 'original', ['o-1'])])
    expect(r.flags[0].removedEvidence).toEqual(['o-2'])
  })

  it('flags stale text when a verdict changed what the generator would say', () => {
    const ov = edit(seg('a', 'Checking: emerging (1/3).', ['o-1']), 'mine')
    const r = mergeDraft({ overrides: [ov] }, [seg('a', 'Checking: competent (2/3).', ['o-1'])])
    expect(r.flags).toEqual([
      { segmentId: 'v1/a', kind: 'stale-text', addedEvidence: [], removedEvidence: [] },
    ])
  })

  it('prefers the evidence flag when both changed, because it is the bigger fact', () => {
    const ov = edit(seg('a', 'old text', ['o-1']), 'mine')
    const r = mergeDraft({ overrides: [ov] }, [seg('a', 'new text', ['o-1', 'o-2'])])
    expect(r.flags.map((f) => f.kind)).toEqual(['stale-evidence'])
  })

  it('orphans an edit whose line is gone instead of dropping it', () => {
    const ov = edit(seg('a', 'original', ['o-1']), 'mine')
    const r = mergeDraft({ overrides: [ov] }, [seg('b', 'something else')])
    expect(r.overrides).toEqual([])
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0].text).toBe('mine')
    expect(r.orphans[0].reason).toBe('segment-gone')
  })

  it('carries existing orphans forward: they do not resolve themselves', () => {
    const stale = { ...edit(seg('z', 'gone', []), 'mine'), reason: 'segment-gone' as const }
    const r = mergeDraft({ overrides: [], orphans: [stale] }, [seg('a', 'x')])
    expect(r.orphans).toHaveLength(1)
  })

  it('orphans everything at once on an id-version bump rather than matching by coincidence', () => {
    const old: SegmentOverride = {
      segmentId: 'v0/a',
      text: 'mine',
      baseText: 'original',
      baseEvidenceKey: 'o-1',
      at: AT,
      by: null,
    }
    const r = mergeDraft({ overrides: [old] }, [seg('a', 'original', ['o-1'])])
    expect(r.overrides).toEqual([])
    expect(r.orphans[0].reason).toBe('id-version')
  })

  it('DOES NOT reattach an edit to a different KSA when the highlight ranking changes', () => {
    // The regression test for index-keyed ids. Yesterday GENRE was the top
    // highlight and CHECK second; today a new observation flips them. With
    // rank-keyed ids ("highlight #1") the edit written about GENRE would now sit
    // on the CHECK line, attributed to CHECK's evidence, and read as correct.
    const yesterday = [
      seg('pe:p-1/hl/k:GENRE/claim', 'Genre Theory: strong (3/3).', ['o-genre']),
      seg('pe:p-1/hl/k:CHECK/claim', 'Checking: competent (2/3).', ['o-check']),
    ]
    const ov = edit(yesterday[0], 'You read the genre better than anyone in the room.')

    const today = [
      seg('pe:p-1/hl/k:CHECK/claim', 'Checking: strong (3/3).', ['o-check', 'o-check-2']),
      seg('pe:p-1/hl/k:GENRE/claim', 'Genre Theory: strong (3/3).', ['o-genre']),
    ]
    const r = mergeDraft({ overrides: [ov] }, today)

    expect(r.overrides).toHaveLength(1)
    expect(r.overrides[0].segmentId).toBe('v1/pe:p-1/hl/k:GENRE/claim')
    expect(r.flags).toEqual([])

    const rendered = applyOverrides(r.segments, r.overrides)
    const check = rendered.find((s) => s.id.includes('k:CHECK'))!
    expect(check.text).toBe('Checking: strong (3/3).')
  })
})

describe('applyOverrides', () => {
  it('lays the human text over the generated structure', () => {
    const segs = [seg('a', 'generated', ['o-1'])]
    const out = applyOverrides(segs, [edit(segs[0], 'human')])
    expect(out[0].text).toBe('human')
    // Everything else about the segment is untouched: it is still the same line.
    expect(out[0].evidence).toEqual(['o-1'])
  })

  it('removes a deleted line', () => {
    const segs = [seg('a', 'keep'), seg('b', 'drop')]
    const out = applyOverrides(segs, [edit(segs[1], null)])
    expect(out.map((s) => s.text)).toEqual(['keep'])
  })

  it('moves the trailing gap up so deleting the last line of a block does not run two blocks together', () => {
    const segs = [seg('a', 'first'), seg('b', 'last', [], true), seg('c', 'next block')]
    const out = applyOverrides(segs, [edit(segs[1], null)])
    expect(segmentsToMarkdown(out)).toBe('first\n\nnext block')
  })

  it('is a no-op with no overrides', () => {
    const segs = [seg('a', 'x'), seg('b', 'y')]
    expect(applyOverrides(segs, [])).toEqual(segs)
  })
})

describe('resolving a flag', () => {
  it('acknowledging re-baselines to the current render and clears the flag next merge', () => {
    const ov = edit(seg('a', 'old', ['o-1']), 'mine')
    const today = [seg('a', 'new', ['o-1', 'o-2'])]
    const merged = mergeDraft({ overrides: [ov] }, today)
    expect(merged.flags).toHaveLength(1)

    const acked = acknowledgeFlag(merged.overrides, today, 'v1/a', AT)
    expect(mergeDraft({ overrides: acked }, today).flags).toEqual([])
  })

  it('reverting drops the edit and lets the generated line stand', () => {
    const segs = [seg('a', 'generated')]
    const reverted = revertOverride([edit(segs[0], 'human')], 'v1/a')
    expect(applyOverrides(segs, reverted)[0].text).toBe('generated')
  })
})
