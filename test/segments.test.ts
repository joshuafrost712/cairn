import { describe, it, expect } from 'vitest'
import {
  claimEvidence,
  derivationNote,
  endBlock,
  evaluatorLabel,
  evidenceSegment,
  push,
  segId,
  segmentsToMarkdown,
  slug,
  type DocSegment,
} from '../src/reports/segments'
import { annotateObservations } from '../src/reports/verification'
import { DEFAULT_SCALE, buildScale } from '../src/lib/scale'
import type { ScalePoint } from '../src/lib/scale'
import { obs } from './factories'
import type { KsaRollup } from '../src/reports/build'
import type { AnnotatedObservation } from '../src/reports/verification'

function rollup(partial: Partial<KsaRollup<AnnotatedObservation>> = {}): KsaRollup<AnnotatedObservation> {
  return {
    ksa_code: 'GENRE',
    area: 'Genre Theory',
    representative: null,
    designations: [],
    conflict: false,
    cbc_subpoint_refs: [],
    contributing: [],
    toVerify: [],
    ...partial,
  }
}

const one = (o = obs()) => annotateObservations([o], [])[0]

describe('segId and slug', () => {
  it('joins parts verbatim so a nested id keeps its path', () => {
    const root = segId('v1', 'de')
    expect(segId(root, 'p:p-1', 'claim')).toBe('v1/de/p:p-1/claim')
  })

  it('slug is what protects the separator, and only where data enters', () => {
    // A CBC subpoint label is authored content and can contain anything.
    expect(slug('1.2 Exegesis/Translation')).toBe('1.2 Exegesis_Translation')
    expect(segId('v1', `s:${slug('a/b')}`).split('/')).toHaveLength(2)
  })
})

describe('segmentsToMarkdown', () => {
  const seg = (text: string, gapAfter = false): DocSegment => ({
    id: text,
    kind: 'paragraph',
    text,
    gapAfter,
    evidence: [],
    editable: true,
  })

  it('reproduces blank lines from gapAfter', () => {
    expect(segmentsToMarkdown([seg('a', true), seg('b')])).toBe('a\n\nb')
  })

  it('keeps a multi-line segment as its own lines', () => {
    expect(segmentsToMarkdown([seg('a\n  > "q"', true), seg('b')])).toBe('a\n  > "q"\n\nb')
  })

  it('a trailing gap leaves a trailing newline, as the renderers always did', () => {
    expect(segmentsToMarkdown([seg('a', true)])).toBe('a\n')
  })

  it('empty in, empty out', () => {
    expect(segmentsToMarkdown([])).toBe('')
  })
})

describe('endBlock', () => {
  it('closes the last segment rather than emitting an empty one', () => {
    const out: DocSegment[] = []
    push(out, { id: 'x', scale: DEFAULT_SCALE, kind: 'paragraph', text: 'a' })
    endBlock(out)
    expect(out).toHaveLength(1)
    expect(out[0].gapAfter).toBe(true)
  })

  it('is a no-op on an empty document, so a leading gap cannot be created', () => {
    const out: DocSegment[] = []
    endBlock(out)
    expect(out).toEqual([])
  })
})

describe('push defaults editability by kind', () => {
  it('headings and meta are structure; everything else is editable', () => {
    const out: DocSegment[] = []
    push(out, { id: 'h', kind: 'heading', text: '# h' })
    push(out, { id: 'm', kind: 'meta', text: '_gate_' })
    push(out, { id: 'p', kind: 'paragraph', text: 'p' })
    push(out, { id: 'b', kind: 'bullet', text: '- b' })
    expect(out.map((s) => s.editable)).toEqual([false, false, true, true])
  })

  it('an explicit editable wins over the default', () => {
    const out: DocSegment[] = []
    push(out, { id: 'h', kind: 'heading', text: '# h', editable: true })
    expect(out[0].editable).toBe(true)
  })
})

describe('evaluatorLabel', () => {
  it('takes the local part', () => {
    expect(evaluatorLabel('josh@sil.org')).toBe('josh')
  })
  it('names the gap rather than printing an empty string', () => {
    expect(evaluatorLabel(null)).toBe('an evaluator')
    expect(evaluatorLabel(undefined)).toBe('an evaluator')
  })
  it('passes through something that is not an email', () => {
    expect(evaluatorLabel('josh')).toBe('josh')
  })
})

describe('evidenceSegment', () => {
  it('names the evaluator only when asked, which is the participant-facing switch', () => {
    const o = one(obs({ evaluator_email: 'josh@sil.org', evidence_designation: 2, text: 'did a thing' }))
    expect(evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE, showEvaluator: true }).text).toContain('josh rated 2/3')
    expect(evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE }).text).not.toContain('josh')
  })

  it('indents the quote two spaces past the bullet', () => {
    const o = one(obs({ source_excerpt: 'a quote' }))
    expect(evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE, indent: '  ' }).text).toBe(
      '  - 2/3: did a thing\n    > "a quote"',
    )
  })

  it('omits the quote line entirely when there is no excerpt', () => {
    const o = one(obs({ source_excerpt: null }))
    expect(evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE }).text.split('\n')).toHaveLength(1)
  })

  it('says when a designation was adjusted, using the effective value', () => {
    const o = { ...one(obs({ evidence_designation: 1 })), effective_designation: 3 as const }
    const text = evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE }).text
    expect(text).toContain('3/3 (adjusted from 1)')
  })

  it('falls back to the recorded designation when nothing is annotated', () => {
    expect(evidenceSegment(obs({ evidence_designation: 1 }), { id: 'x', scale: DEFAULT_SCALE }).text).toContain('1/3')
  })

  it('carries exactly its own observation and stays editable', () => {
    const o = one(obs({ id: 'o-9' }))
    const s = evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE })
    expect(s.evidence).toEqual(['o-9'])
    expect(s.editable).toBe(true)
    expect(s.kind).toBe('evidence')
  })
})

describe('derivationNote', () => {
  it('states the max rule with the designations it ran over', () => {
    const r = rollup({
      representative: 3,
      designations: [1, 2, 3],
      contributing: [one(obs({ id: 'a' })), one(obs({ id: 'b' })), one(obs({ id: 'c' }))],
    })
    expect(derivationNote(r, DEFAULT_SCALE)).toBe('3/3 is the highest of 3 counting designations (1, 2, 3).')
  })

  it('counts what was set aside, because that is the difference between what was said and what counted', () => {
    const r = rollup({ representative: 2, designations: [2], toVerify: [one(obs({ id: 'x', scale: DEFAULT_SCALE }))] })
    expect(derivationNote(r, DEFAULT_SCALE)).toContain('1 set aside pending review')
    expect(derivationNote(r, DEFAULT_SCALE)).toContain('1 counting designation (2)')
  })

  it('adds the reconciliation sentence on a conflict', () => {
    const r = rollup({ representative: 3, designations: [1, 3], conflict: true })
    expect(derivationNote(r, DEFAULT_SCALE)).toContain('differ by 2 or more')
  })

  it('distinguishes no evidence at all from evidence that is all set aside', () => {
    expect(derivationNote(rollup(), DEFAULT_SCALE)).toBe('No evidence captured for this area yet.')
    expect(derivationNote(rollup({ toVerify: [one(obs({ id: 'x', scale: DEFAULT_SCALE }))] }))).toContain('1 observation is still set aside')
  })
})

describe('claimEvidence', () => {
  it('is the whole counting set, because the claim asserts a max over all of it', () => {
    const r = rollup({
      contributing: [one(obs({ id: 'a' })), one(obs({ id: 'b' }))],
      toVerify: [one(obs({ id: 'c' }))],
    })
    // Set-aside evidence is deliberately absent: it did not produce the number.
    expect(claimEvidence(r)).toEqual(['a', 'b'])
  })
})

/**
 * A five-point workshop, which tl-09 made legal and which every score readout in this
 * file printed as "/3" until tl-29.
 */
function fivePointScale() {
  const points: ScalePoint[] = [0, 1, 2, 3, 4].map((value, i) => ({
    workshop_id: 'w-5',
    value,
    label: `p${value}`,
    description: null,
    is_low_trigger: value <= 1,
    sort_order: i,
  }))
  return buildScale('w-5', points)
}

describe('the denominator comes from the workshop scale, not a literal', () => {
  it('prints an evidence bullet out of the top point of a five-point scale', () => {
    const o = one(obs({ evidence_designation: 2, text: 'did a thing' }))
    expect(evidenceSegment(o, { id: 'x', scale: fivePointScale() }).text).toContain('2/4')
    expect(evidenceSegment(o, { id: 'x', scale: DEFAULT_SCALE }).text).toContain('2/3')
  })

  it('prints the derivation note out of the same top point', () => {
    const r = rollup({ representative: 3, designations: [1, 3] })
    expect(derivationNote(r, fivePointScale())).toContain('3/4 is the highest')
    expect(derivationNote(r, DEFAULT_SCALE)).toContain('3/3 is the highest')
  })
})
