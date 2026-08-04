import { describe, it, expect } from 'vitest'
import {
  GROUNDING_RATIO,
  excerptIsGrounded,
  normalizeForProvenance,
  orderedWordRatio,
} from '../src/ai/provenance'
import { validateObservation, isOnScale, type RoutedObservation } from '../src/ai/contract'
import { DEFAULT_SCALE, type Scale, type ScalePoint } from '../src/lib/scale'

/**
 * The quotation check (tl-15), and the four other things the import boundary refuses.
 *
 * The two halves are tested together because the boundary is only as good as its weakest
 * rule and each was written against a specific silent failure: an invented quote reaching a
 * report in quotation marks, an observation filed under a participant or a question code
 * nothing rolls up, and a rating no legend can label.
 */

const SOURCE = `Maria opened by reading the passage aloud, then asked the team what they
noticed about the repeated word. Yosef checked the Hebrew and said the term is
the same in both verses. Later she moved on before the group had answered.`

describe('normalizeForProvenance', () => {
  it('folds the typography a router legitimately tidies', () => {
    // The single likeliest way a genuine quotation fails a naive substring test: dictation
    // software writes one apostrophe and a model writes the other.
    expect(normalizeForProvenance('“Don’t—wait…”')).toBe('"don\'t-wait..."')
  })

  it('collapses the line breaks a transcript carries', () => {
    expect(normalizeForProvenance('one\n  two\tthree ')).toBe('one two three')
  })
})

describe('excerptIsGrounded', () => {
  it('accepts a verbatim span', () => {
    expect(excerptIsGrounded('checked the Hebrew', SOURCE)).toBe(true)
  })

  it('accepts a span that crosses a line break in the source', () => {
    // The case a substring check on the raw text would fail, and the reason normalization
    // exists at all: a dictated capture wraps wherever the transcriber's window did.
    expect(excerptIsGrounded('the team what they noticed', SOURCE)).toBe(true)
  })

  it('accepts a lightly retyped quotation', () => {
    expect(excerptIsGrounded('Yosef checked the hebrew and said the term is the same', SOURCE)).toBe(true)
  })

  it('accepts an elided quotation', () => {
    expect(excerptIsGrounded('Maria opened by reading the passage aloud … she moved on', SOURCE)).toBe(true)
  })

  it('refuses an invented sentence', () => {
    // The failure that matters most. Nothing in the source says this, and it is exactly
    // the kind of plausible sentence a model produces when it is filling a gap.
    expect(excerptIsGrounded('Maria explained the imagery of the psalm to each participant in turn', SOURCE)).toBe(
      false,
    )
  })

  it('refuses a quotation about somebody the source never mentions', () => {
    expect(excerptIsGrounded('Daniel corrected the translation twice', SOURCE)).toBe(false)
  })

  it('accepts anything when this device has no source to judge against', () => {
    // THE GUARD ON THE GUARD, and the direction of it is deliberate: a device that never
    // held the capture cannot judge its quotations, and rejecting real work for want of a
    // source it never had would be a far worse failure than the one being prevented.
    expect(excerptIsGrounded('anything at all', null)).toBe(true)
    expect(excerptIsGrounded('anything at all', '')).toBe(true)
    expect(excerptIsGrounded('anything at all', '   ')).toBe(true)
  })

  it('refuses an empty quotation when there IS a source', () => {
    expect(excerptIsGrounded('   ', SOURCE)).toBe(false)
  })
})

describe('orderedWordRatio', () => {
  it('is 1 for a span in order and 0 for words that are not there', () => {
    expect(orderedWordRatio('checked the Hebrew', SOURCE)).toBe(1)
    expect(orderedWordRatio('quantum entanglement lattice', SOURCE)).toBe(0)
  })

  it('penalizes a quotation whose words appear in the wrong order', () => {
    // "she moved on ... Maria opened" is a real reordering rather than a quotation, and the
    // greedy left-to-right match is what makes that visible.
    expect(orderedWordRatio('she moved on before Maria opened by reading', SOURCE)).toBeLessThan(GROUNDING_RATIO)
  })

  it('ignores the words too short to carry evidence at all', () => {
    expect(orderedWordRatio('of a to', SOURCE)).toBe(0)
  })
})

describe('a short excerpt has to be a real substring', () => {
  /**
   * The hole the stopword case opened, and it is why `MIN_FALLBACK_WORDS` exists. A
   * ratio over three or four common words is a coincidence rather than a measurement:
   * "the team said" scores a perfect 1 against almost any transcript. So below the
   * threshold the fallback does not apply and the substring rule is the whole test.
   */
  it('refuses a short phrase assembled from words that are merely present', () => {
    expect(orderedWordRatio('the team moved', SOURCE)).toBe(1)
    expect(excerptIsGrounded('the team moved', SOURCE)).toBe(false)
  })

  it('still accepts a short phrase that really is in the source', () => {
    expect(excerptIsGrounded('read the passage', SOURCE.replace(/\s+/g, ' '))).toBe(false)
    expect(excerptIsGrounded('reading the passage aloud', SOURCE)).toBe(true)
  })
})

describe('the shape check that runs before it', () => {
  const good: RoutedObservation = {
    participant_name: 'Yosef',
    participant_id: 'p-1',
    ksa_code: 'Q1',
    text: 'Checked the source text.',
    source_excerpt: 'checked the Hebrew',
    evidence_designation: 2,
    sentiment_flag: 'strong',
    confidence: 'high',
    needs_review: false,
    origin: 'individual',
  }

  it('names the missing field rather than failing generically', () => {
    // The per-item report shows this text to whoever has to fix their agent, so it earns
    // its place: "missing/invalid ksa_code" is actionable and "rejected" is not.
    const r = validateObservation({ ...good, ksa_code: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/ksa_code/)
  })

  it('refuses a designation that is not an integer at all', () => {
    const r = validateObservation({ ...good, evidence_designation: 'high' })
    expect(r.ok).toBe(false)
  })

  it('leaves the scale question to isOnScale, which knows the workshop', () => {
    const threePoint: Scale = {
      workshop_id: 'ws-1',
      points: [1, 2, 3].map(
        (value): ScalePoint => ({ workshop_id: 'ws-1', value, label: `p${value}`, description: null, is_low_trigger: false }),
      ),
    }
    expect(isOnScale(good, DEFAULT_SCALE)).toBe(true)
    expect(isOnScale({ ...good, evidence_designation: 0 }, threePoint)).toBe(false)
  })
})
