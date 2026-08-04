import { describe, it, expect } from 'vitest'
import {
  LCS_RATIO,
  excerptIsGrounded,
  groundedRatio,
  longestRunLength,
  normalizeForProvenance,
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

describe('the contiguous-run rule', () => {
  it('measures the longest run and nothing else', () => {
    expect(longestRunLength('checked the hebrew', normalizeForProvenance(SOURCE))).toBe(18)
    expect(longestRunLength('quantum entanglement', normalizeForProvenance(SOURCE))).toBeLessThan(4)
  })

  it('is a fraction of the excerpt, so a long invention scores low', () => {
    expect(groundedRatio('checked the Hebrew', SOURCE)).toBe(1)
    expect(groundedRatio('Maria explained the imagery of the psalm to each person', SOURCE)).toBeLessThan(LCS_RATIO)
  })

  it('refuses a sentence assembled from words the transcript happens to contain', () => {
    /**
     * THE REVIEW'S SHARPEST FINDING, kept as a test because it is the failure this module
     * exists to prevent and the first draft let it through at 0.83. Yosef said something
     * else; a different group had answered. An ordered bag of words cannot tell the
     * difference, and gets easier to fool as the transcript grows.
     */
    expect(excerptIsGrounded('Yosef said the team had answered', SOURCE)).toBe(false)
    expect(excerptIsGrounded('Maria asked Yosef whether the term was the same', SOURCE)).toBe(false)
  })

  it('refuses a reordering of the source’s own phrases', () => {
    expect(excerptIsGrounded('she moved on before Maria opened by reading', SOURCE)).toBe(false)
  })
})

describe('a short excerpt has to be a real substring', () => {
  /**
   * Below `MIN_FALLBACK_CHARS` a run is a coincidence rather than a measurement: "the team "
   * appears in almost any transcript. So the substring rule is the whole test down there.
   */
  it('refuses a short phrase that is not actually a span', () => {
    expect(excerptIsGrounded('the team moved', SOURCE)).toBe(false)
    expect(excerptIsGrounded('read the passage', SOURCE)).toBe(false)
  })

  it('still accepts a short phrase that really is in the source', () => {
    expect(excerptIsGrounded('reading the passage aloud', SOURCE)).toBe(true)
    expect(excerptIsGrounded('moved on', SOURCE)).toBe(true)
  })
})

describe('every script this app is used with, not only the Latin ones', () => {
  /**
   * THE OTHER HALF OF THE REVIEW'S FINDING, and the reason the rule is a run of characters
   * rather than a list of words. The first draft tokenized on `[^a-z0-9']`, so Hindi, Thai,
   * Khmer and Chinese produced no tokens at all and could only ever pass an exact substring —
   * the strictest possible treatment for the languages least likely to survive it. Throughline
   * is used with Tetun, Hindi and Khasi today.
   */
  const HINDI =
    'मारिया ने पहले पद को ज़ोर से पढ़ा और फिर टीम से पूछा कि उन्होंने दोहराए गए शब्द के बारे में क्या देखा। बाद में वह उत्तर मिलने से पहले आगे बढ़ गई।'
  const THAI =
    'มาเรียอ่านข้อพระคัมภีร์ออกเสียงแล้วถามทีมว่าสังเกตอะไรเกี่ยวกับคำที่ซ้ำกันต่อมาเธอก็ไปต่อก่อนที่กลุ่มจะตอบ'

  it('accepts an elided Devanagari quotation', () => {
    expect(excerptIsGrounded('मारिया ने पहले पद को ज़ोर से पढ़ा … आगे बढ़ गई', HINDI)).toBe(true)
  })

  it('accepts a Devanagari span whose danda was tidied to a full stop', () => {
    expect(excerptIsGrounded('बाद में वह उत्तर मिलने से पहले आगे बढ़ गई.', HINDI)).toBe(true)
  })

  it('refuses a Devanagari sentence that is not in the source', () => {
    expect(excerptIsGrounded('मारिया ने समूह को भजन का अर्थ समझाया और हर व्यक्ति से बात की', HINDI)).toBe(false)
  })

  it('handles a script with no spaces at all', () => {
    // Nothing tokenizes Thai here, and nothing needs to: a run is a run.
    expect(excerptIsGrounded('อ่านข้อพระคัมภีร์ออกเสียงแล้วถามทีม', THAI)).toBe(true)
    expect(excerptIsGrounded('เธออธิบายความหมายของบทเพลงให้ทุกคนฟังอย่างละเอียด', THAI)).toBe(false)
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
