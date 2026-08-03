import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CHARS_PER_TOKEN,
  DEFAULT_ASSUMPTIONS,
  EMAIL_OUTPUT_CHARS,
  EXCLUSIONS,
  GUIDANCE_OUTPUT_CHARS,
  OBSERVATION_CHARS,
  REPORT_OUTPUT_CHARS,
  ROUTING_CONTRACT_CHARS,
  SCENARIO_OUTPUT_CHARS_PER_QUESTION,
  SCENARIO_PROMPT_CHARS,
  assumptionsValue,
  effectiveCaptureChars,
  estimateWorkshopTokens,
  resolveAssumptions,
  totalTokens,
  type EstimateAssumptions,
  type WorkshopShape,
} from '../src/ai/estimate'
import {
  MODEL_REGISTRY,
  RECOMMENDATIONS,
  REGISTRY_REVIEWED,
  estimateCostUsd,
  modeIsMetered,
  modelById,
  modelsForMode,
  registryIsStale,
} from '../src/ai/models'
import { AI_FUNCTIONS } from '../src/lib/aiConfig'
import { defaultAiConfig, resolveAiConfig, type AiConfigRow } from '../src/lib/aiConfig'
import { findChromeNode } from '../src/lib/content/chrome'

/**
 * tl-14: the estimator's arithmetic, worked out here so a reviewer can check the sums.
 *
 * The spec's acceptance criterion is that the arithmetic is legible in the test file
 * rather than merely asserted, and that is the whole design of what follows: every
 * expected number below is written as the multiplication that produces it, not as a
 * literal somebody once observed the code emit. A test that only pins current
 * behaviour would let a wrong estimator stay wrong forever, which for this feature
 * means an administrator being told a workshop costs $12 when it costs $400.
 *
 * The constants are imported rather than repeated, so a change to one of them fails
 * the case that depends on it instead of silently making the test agree with the bug.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small workshop: 2 activities, 4 participants, 3 questions each. */
const SMALL: WorkshopShape = {
  activities: 2,
  participants: 4,
  questionsPerActivity: 3,
  rubricChars: 2_000,
  rosterChars: 1_000,
  conversations: 0,
  observedCaptureChars: null,
}

/**
 * The Bali shape: the Psalms Workshop this app was built for.
 *
 * 22 participants and the real 6-area KSA framework, over 10 observed activities.
 * Kept as the second case because a formula that is right on 4 participants and wrong
 * on 22 is a formula with a term in the wrong place, and this is the shape Joshua will
 * actually read the number for.
 */
const BALI: WorkshopShape = {
  activities: 10,
  participants: 22,
  questionsPerActivity: 6,
  rubricChars: 8_000,
  rosterChars: 2_000,
  conversations: 0,
  observedCaptureChars: null,
}

const A = DEFAULT_ASSUMPTIONS

// ---------------------------------------------------------------------------
// Case 1 — a small workshop with only routing switched on
// ---------------------------------------------------------------------------

describe('case 1: a small workshop, routing only', () => {
  const r = estimateWorkshopTokens(SMALL, ['observation_routing'], A)

  it('charges one capture per evaluator per activity, each carrying rubric + roster + contract', () => {
    // captures        = 2 activities x 2 evaluators                      =      4
    // chars/capture   = 1200 capture + 2000 rubric + 1000 roster + 4000  =  8,200
    // input chars     = 4 x 8,200                                        = 32,800
    // input tokens    = 32,800 / 4                                       =  8,200
    const captures = SMALL.activities * A.evaluatorsPerActivity
    expect(captures).toBe(4)
    const perCapture =
      A.captureChars + SMALL.rubricChars + SMALL.rosterChars + ROUTING_CONTRACT_CHARS
    expect(perCapture).toBe(8_200)
    expect(r.components[0].inputTokens).toBe((captures * perCapture) / CHARS_PER_TOKEN)
    expect(r.components[0].inputTokens).toBe(8_200)
  })

  it('produces one observation per participant per question, at the coverage assumption', () => {
    // observations  = 2 activities x 4 participants x 3 questions x 0.5  =     12
    // output chars  = 12 x 400                                          =  4,800
    // output tokens = 4,800 / 4                                         =  1,200
    const observations =
      SMALL.activities * SMALL.participants * SMALL.questionsPerActivity * A.observationCoverage
    expect(observations).toBe(12)
    expect(r.components[0].outputTokens).toBe((observations * OBSERVATION_CHARS) / CHARS_PER_TOKEN)
    expect(r.components[0].outputTokens).toBe(1_200)
  })

  it('has nothing one-off in it, and bands the total on the stated multipliers', () => {
    expect(r.oneOff).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(r.expected).toEqual({ inputTokens: 8_200, outputTokens: 1_200 })
    // 8,200 x 0.6 = 4,920   |   8,200 x 1.8 = 14,760
    expect(r.low).toEqual({ inputTokens: 4_920, outputTokens: 720 })
    expect(r.high).toEqual({ inputTokens: 14_760, outputTokens: 2_160 })
  })

  it('names the capture length as an assumption, since this workshop has no captures yet', () => {
    expect(r.components[0].basis.assumed).toContain('captureChars')
    expect(r.usedObservedCaptureLength).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Case 2 — the Bali shape, routing and emails
// ---------------------------------------------------------------------------

describe('case 2: the Bali shape, routing and email drafting', () => {
  const r = estimateWorkshopTokens(BALI, ['observation_routing', 'email_drafting'], A)
  const routing = r.components.find((c) => c.fn === 'observation_routing')!
  const email = r.components.find((c) => c.fn === 'email_drafting')!

  it('routes 20 captures of 15,200 chars each', () => {
    // captures      = 10 x 2                                              =      20
    // chars/capture = 1200 + 8000 + 2000 + 4000                           =  15,200
    // input tokens  = 20 x 15,200 / 4                                     =  76,000
    expect(routing.inputTokens).toBe((20 * 15_200) / CHARS_PER_TOKEN)
    expect(routing.inputTokens).toBe(76_000)
    // observations  = 10 x 22 x 6 x 0.5                                   =     660
    // output tokens = 660 x 400 / 4                                       =  66,000
    expect(routing.outputTokens).toBe((660 * OBSERVATION_CHARS) / CHARS_PER_TOKEN)
    expect(routing.outputTokens).toBe(66_000)
  })

  it('counts participant emails and event digests separately, on their own evidence', () => {
    // obs/participant   = 10 activities x 6 questions x 0.5      =      30
    // participantEmails = 22 x 1                                 =      22
    // digests           = 10 x 1                                 =      10
    // evidence/email    = 30 x 400                               =  12,000 chars
    // evidence/digest   = 22 x 6 x 0.5 x 400                     =  26,400 chars
    // input chars       = 22 x 12,000 + 10 x 26,400              = 528,000
    // input tokens      = 528,000 / 4                            = 132,000
    expect(email.inputTokens).toBe((22 * 12_000 + 10 * 26_400) / CHARS_PER_TOKEN)
    expect(email.inputTokens).toBe(132_000)
    // output chars = (22 + 10 + 0 notes) x 1,200                 =  38,400
    // output tokens = 38,400 / 4                                 =   9,600
    expect(email.outputTokens).toBe((32 * EMAIL_OUTPUT_CHARS) / CHARS_PER_TOKEN)
    expect(email.outputTokens).toBe(9_600)
  })

  it('totals both components and reports the band', () => {
    // input  = 76,000 + 132,000 = 208,000     output = 66,000 + 9,600 = 75,600
    expect(r.expected).toEqual({ inputTokens: 208_000, outputTokens: 75_600 })
    expect(totalTokens(r.expected)).toBe(283_600)
    expect(r.low).toEqual({ inputTokens: 124_800, outputTokens: 45_360 })
    expect(r.high).toEqual({ inputTokens: 374_400, outputTokens: 136_080 })
  })

  it('converts to dollars on a metered model, and the sum is checkable', () => {
    const flash = modelById('gemini-2.5-flash')!
    // input  208,000 / 1e6 x $0.30 = $0.0624
    // output  75,600 / 1e6 x $2.50 = $0.1890
    //                        total = $0.2514
    expect(estimateCostUsd(r.expected, flash)).toBeCloseTo(0.2514, 6)
  })
})

// ---------------------------------------------------------------------------
// Case 3 — every function enabled
// ---------------------------------------------------------------------------

describe('case 3: every function enabled', () => {
  const shape: WorkshopShape = { ...SMALL, conversations: 5 }
  const r = estimateWorkshopTokens(shape, AI_FUNCTIONS, A)
  const by = (fn: string) => r.components.find((c) => c.fn === fn)!

  it('produces one component per function, in no fewer and no more', () => {
    expect(r.components).toHaveLength(AI_FUNCTIONS.length)
  })

  it('draft-fill is one-off, its input the document and its output bounded by the schema', () => {
    // input tokens  = (20,000 document + 2,000 prompt) / 4 = 5,500
    // output tokens = 3 questions x 600 / 4                =   450
    expect(by('scenario_draft').inputTokens).toBe(
      (A.documentChars + SCENARIO_PROMPT_CHARS) / CHARS_PER_TOKEN,
    )
    expect(by('scenario_draft').inputTokens).toBe(5_500)
    expect(by('scenario_draft').outputTokens).toBe(
      (shape.questionsPerActivity * SCENARIO_OUTPUT_CHARS_PER_QUESTION) / CHARS_PER_TOKEN,
    )
    expect(by('scenario_draft').outputTokens).toBe(450)
    expect(by('scenario_draft').oneOff).toBe(true)
  })

  it('reports read one participant’s evidence plus the rubric, and write a report each', () => {
    // obs/participant        = 2 x 3 x 0.5              =     3
    // evidence/participant   = 3 x 400 + 2,000 rubric   = 3,200 chars
    // reports                = 4 x 1                    =     4
    // input tokens           = 4 x 3,200 / 4            = 3,200
    // output tokens          = 4 x 4,000 / 4            = 4,000
    expect(by('narrative_prose').inputTokens).toBe((4 * 3_200) / CHARS_PER_TOKEN)
    expect(by('narrative_prose').inputTokens).toBe(3_200)
    expect(by('narrative_prose').outputTokens).toBe((4 * REPORT_OUTPUT_CHARS) / CHARS_PER_TOKEN)
    expect(by('narrative_prose').outputTokens).toBe(4_000)
  })

  it('guidance reads the quoted observations plus the rubric, per conversation', () => {
    // evidence/conversation = 3 observations x 400 + 2,000 rubric = 3,200 chars
    // input tokens          = 5 x 3,200 / 4                       = 4,000
    // output tokens         = 5 x 1,500 / 4                       = 1,875
    expect(by('conversation_guidance').inputTokens).toBe(
      (shape.conversations * (A.observationsPerConversation * OBSERVATION_CHARS + shape.rubricChars)) /
        CHARS_PER_TOKEN,
    )
    expect(by('conversation_guidance').inputTokens).toBe(4_000)
    expect(by('conversation_guidance').outputTokens).toBe(
      (shape.conversations * GUIDANCE_OUTPUT_CHARS) / CHARS_PER_TOKEN,
    )
    expect(by('conversation_guidance').outputTokens).toBe(1_875)
  })

  it('separates the recurring total from the one-off, rather than amortising it', () => {
    // recurring input  = 8,200 routing + 3,200 reports + 2,400 emails + 4,000 guidance = 17,800
    // recurring output = 1,200 + 4,000 + 1,800 + 1,875                                 =  8,875
    expect(r.recurring).toEqual({ inputTokens: 17_800, outputTokens: 8_875 })
    expect(r.oneOff).toEqual({ inputTokens: 5_500, outputTokens: 450 })
    // expected = recurring + one-off
    expect(r.expected).toEqual({ inputTokens: 23_300, outputTokens: 9_325 })
    expect(r.low).toEqual({ inputTokens: 13_980, outputTokens: 5_595 })
    expect(r.high).toEqual({ inputTokens: 41_940, outputTokens: 16_785 })
  })
})

// ---------------------------------------------------------------------------
// Case 4 — everything off
// ---------------------------------------------------------------------------

describe('case 4: everything off', () => {
  it('returns a genuine zero, with no components and no floor', () => {
    const r = estimateWorkshopTokens(BALI, [], A)
    expect(r.components).toEqual([])
    expect(r.expected).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(r.low).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(r.high).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(totalTokens(r.expected)).toBe(0)
    // The distinction the spec asks for: a workshop with everything switched off costs
    // nothing, which is different from a workshop too empty to estimate.
    expect(estimateCostUsd(r.expected, modelById('gemini-2.5-flash'))).toBe(0)
    expect(estimateCostUsd(r.expected, null)).toBeNull()
  })

  it('an empty workshop with everything ON also costs nothing, without dividing by zero', () => {
    const empty: WorkshopShape = {
      activities: 0,
      participants: 0,
      questionsPerActivity: 0,
      rubricChars: 0,
      rosterChars: 0,
      conversations: 0,
      observedCaptureChars: null,
    }
    const r = estimateWorkshopTokens(empty, AI_FUNCTIONS, A)
    // Draft-fill is the exception and correctly so: its input is the document an
    // administrator would upload, which does not depend on the workshop existing yet.
    expect(r.recurring).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(r.oneOff.inputTokens).toBe(5_500)
    for (const c of r.components) {
      expect(Number.isFinite(c.inputTokens)).toBe(true)
      expect(Number.isFinite(c.outputTokens)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The property the spec asks for
// ---------------------------------------------------------------------------

describe('doubling participants', () => {
  const base: WorkshopShape = { ...SMALL, conversations: 5 }
  const doubled: WorkshopShape = { ...base, participants: base.participants * 2 }
  const a = estimateWorkshopTokens(base, AI_FUNCTIONS, A)
  const b = estimateWorkshopTokens(doubled, AI_FUNCTIONS, A)
  const of = (r: typeof a, fn: string) => r.components.find((c) => c.fn === fn)!

  it('doubles the participant-driven components', () => {
    // Routing OUTPUT is participant-driven (one observation per participant per
    // question); routing INPUT is not (a capture is per evaluator per activity).
    expect(of(b, 'observation_routing').outputTokens).toBe(
      of(a, 'observation_routing').outputTokens * 2,
    )
    expect(of(b, 'narrative_prose').inputTokens).toBe(of(a, 'narrative_prose').inputTokens * 2)
    expect(of(b, 'narrative_prose').outputTokens).toBe(of(a, 'narrative_prose').outputTokens * 2)
  })

  it('leaves the components that are not participant-driven alone', () => {
    expect(of(b, 'observation_routing').inputTokens).toBe(of(a, 'observation_routing').inputTokens)
    expect(of(b, 'scenario_draft')).toEqual(of(a, 'scenario_draft'))
    expect(of(b, 'conversation_guidance')).toEqual(of(a, 'conversation_guidance'))
    expect(b.oneOff).toEqual(a.oneOff)
  })

  it('grows email drafting without doubling it, because digests are per event', () => {
    // The honest middle case, and worth pinning: participant emails double, event
    // digests do not, so the component grows by less than 2x. A test asserting a clean
    // doubling here would be asserting a bug.
    const before = of(a, 'email_drafting').outputTokens
    const after = of(b, 'email_drafting').outputTokens
    expect(after).toBeGreaterThan(before)
    expect(after).toBeLessThan(before * 2)
  })
})

describe('changing an assumption moves the estimate in the expected direction', () => {
  it('a longer capture raises routing input and nothing else', () => {
    const short = estimateWorkshopTokens(BALI, ['observation_routing', 'narrative_prose'], A)
    const long = estimateWorkshopTokens(BALI, ['observation_routing', 'narrative_prose'], {
      ...A,
      captureChars: A.captureChars * 2,
    })
    const rIn = (r: typeof short) => r.components.find((c) => c.fn === 'observation_routing')!
    expect(rIn(long).inputTokens).toBeGreaterThan(rIn(short).inputTokens)
    // Capture length is an input-side fact: it does not change how many observations
    // come back, so the output side must not move.
    expect(rIn(long).outputTokens).toBe(rIn(short).outputTokens)
    expect(
      long.components.find((c) => c.fn === 'narrative_prose')!.inputTokens,
    ).toBe(short.components.find((c) => c.fn === 'narrative_prose')!.inputTokens)
  })

  it('more evaluators per activity raises routing input proportionally', () => {
    const two = estimateWorkshopTokens(BALI, ['observation_routing'], A)
    const four = estimateWorkshopTokens(BALI, ['observation_routing'], {
      ...A,
      evaluatorsPerActivity: 4,
    })
    expect(four.components[0].inputTokens).toBe(two.components[0].inputTokens * 2)
  })
})

// ---------------------------------------------------------------------------
// Calibration: a measured capture length beats the assumed one
// ---------------------------------------------------------------------------

describe('measured capture length', () => {
  it('replaces the assumption when the workshop has real captures, and says so', () => {
    const measured: WorkshopShape = { ...BALI, observedCaptureChars: 3_000 }
    const r = estimateWorkshopTokens(measured, ['observation_routing'], A)
    // chars/capture = 3,000 + 8,000 + 2,000 + 4,000 = 17,000; x 20 captures / 4
    expect(r.components[0].inputTokens).toBe((20 * 17_000) / CHARS_PER_TOKEN)
    expect(r.usedObservedCaptureLength).toBe(true)
    expect(r.components[0].basis.assumed).not.toContain('captureChars')
  })

  it('treats a zero measurement as no measurement rather than as a free workshop', () => {
    // A workshop whose only capture is an empty string must not be told routing costs
    // the roster and nothing else. Null and 0 both mean "fall back to the assumption".
    expect(effectiveCaptureChars({ ...BALI, observedCaptureChars: 0 }, A)).toEqual({
      chars: A.captureChars,
      observed: false,
    })
    expect(effectiveCaptureChars({ ...BALI, observedCaptureChars: null }, A).observed).toBe(false)
  })

  it('does not claim a measurement was used when routing is switched off', () => {
    // The flag drives a label on the routing row. With routing off there is no row, so
    // claiming a measured length would be asserting something about work not shown.
    const r = estimateWorkshopTokens(
      { ...BALI, observedCaptureChars: 3_000 },
      ['narrative_prose'],
      A,
    )
    expect(r.usedObservedCaptureLength).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stored assumptions
// ---------------------------------------------------------------------------

describe('resolveAssumptions', () => {
  it('fills every default when nothing is stored', () => {
    expect(resolveAssumptions(undefined)).toEqual(DEFAULT_ASSUMPTIONS)
    expect(resolveAssumptions(null)).toEqual(DEFAULT_ASSUMPTIONS)
    expect(resolveAssumptions({})).toEqual(DEFAULT_ASSUMPTIONS)
    expect(resolveAssumptions([1, 2])).toEqual(DEFAULT_ASSUMPTIONS)
    expect(resolveAssumptions('nope')).toEqual(DEFAULT_ASSUMPTIONS)
  })

  it('takes a stored override and ignores keys it does not know', () => {
    const r = resolveAssumptions({ captureChars: 5_000, somethingNewer: 12 })
    expect(r.captureChars).toBe(5_000)
    expect(r.evaluatorsPerActivity).toBe(DEFAULT_ASSUMPTIONS.evaluatorsPerActivity)
    expect('somethingNewer' in r).toBe(false)
  })

  it('refuses a value that would make the estimate a lie rather than a number', () => {
    // NaN renders as "NaN tokens"; a negative subtracts from a total and would read as
    // a workshop being cheaper than doing nothing. Both fall back to the default.
    expect(resolveAssumptions({ captureChars: Number.NaN }).captureChars).toBe(A.captureChars)
    expect(resolveAssumptions({ captureChars: Number.POSITIVE_INFINITY }).captureChars).toBe(
      A.captureChars,
    )
    // On a REAL key. The first draft used `participants`, which is not an assumption
    // key at all, so it passed through the unknown-key branch and the negative guard
    // was never exercised.
    expect(resolveAssumptions({ captureChars: -5 }).captureChars).toBe(A.captureChars)
    expect(resolveAssumptions({ discrepancyNotes: -1 }).discrepancyNotes).toBe(A.discrepancyNotes)
    expect(resolveAssumptions({ participants: -5 })).toEqual(DEFAULT_ASSUMPTIONS)
    expect(resolveAssumptions({ captureChars: '900' as unknown as number }).captureChars).toBe(
      A.captureChars,
    )
  })

  it('refuses a band that reads backwards', () => {
    const r = resolveAssumptions({ lowMultiplier: 3, highMultiplier: 0.5 })
    expect(r.lowMultiplier).toBe(A.lowMultiplier)
    expect(r.highMultiplier).toBe(A.highMultiplier)
    // And a band that is ordered but does not bracket the expected case is refused
    // too: {1.5, 1.8} would put a figure labelled "Low" above the expected one.
    const above = resolveAssumptions({ lowMultiplier: 1.5, highMultiplier: 1.8 })
    expect(above.lowMultiplier).toBe(A.lowMultiplier)
    expect(above.highMultiplier).toBe(A.highMultiplier)
    const below = resolveAssumptions({ lowMultiplier: 0.3, highMultiplier: 0.9 })
    expect(below.lowMultiplier).toBe(A.lowMultiplier)
    expect(below.highMultiplier).toBe(A.highMultiplier)
    // And a legal pair survives.
    const ok = resolveAssumptions({ lowMultiplier: 0.8, highMultiplier: 1.2 })
    expect(ok.lowMultiplier).toBe(0.8)
    expect(ok.highMultiplier).toBe(1.2)
  })

  it('stores only what differs from the defaults, so a corrected default still reaches a workshop', () => {
    expect(assumptionsValue(DEFAULT_ASSUMPTIONS)).toEqual({})
    const changed: EstimateAssumptions = { ...DEFAULT_ASSUMPTIONS, captureChars: 2_400 }
    expect(assumptionsValue(changed)).toEqual({ captureChars: 2_400 })
  })

  it('round-trips through the sparse form', () => {
    const changed: EstimateAssumptions = {
      ...DEFAULT_ASSUMPTIONS,
      captureChars: 2_400,
      discrepancyNotes: 3,
    }
    expect(resolveAssumptions(assumptionsValue(changed))).toEqual(changed)
  })
})

describe('the ai_config row carries assumptions', () => {
  const row = (over: Partial<AiConfigRow> = {}): AiConfigRow => ({
    workshop_id: 'w1',
    mode: 'github-claude',
    functions: {},
    ...over,
  })

  it('defaults to an empty override map, which resolves to the estimator defaults', () => {
    expect(defaultAiConfig('w1').assumptions).toEqual({})
    expect(resolveAiConfig('w1', [row()]).assumptions).toEqual({})
    expect(resolveAssumptions(resolveAiConfig('w1', [row()]).assumptions)).toEqual(
      DEFAULT_ASSUMPTIONS,
    )
  })

  it('reads stored numbers and drops anything that is not one', () => {
    const c = resolveAiConfig('w1', [
      row({ assumptions: { captureChars: 2_400, evaluatorsPerActivity: 'three', bad: -1 } }),
    ])
    expect(c.assumptions).toEqual({ captureChars: 2_400 })
  })

  it('does not let another workshop’s assumptions leak in', () => {
    // The same filter-by-workshop rule resolveAiConfig already applies to the mode: an
    // estimate silently built from another workshop's overrides would look fine.
    const c = resolveAiConfig('w1', [row({ workshop_id: 'w2', assumptions: { captureChars: 9_000 } })])
    expect(c.assumptions).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Registry integrity — the spec's second acceptance block
// ---------------------------------------------------------------------------

describe('the model registry', () => {
  it('gives every entry a price, a posture, a citable source and a review date', () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0)
    for (const m of MODEL_REGISTRY) {
      expect(m.input_per_mtok, m.id).toBeGreaterThan(0)
      expect(m.output_per_mtok, m.id).toBeGreaterThan(0)
      expect(m.context_window, m.id).toBeGreaterThan(0)
      expect(['no_training_no_retention', 'no_training_retained', 'unclear_or_trains']).toContain(
        m.data_posture,
      )
      // A source that is not a URL is not a citation.
      expect(m.posture_source, m.id).toMatch(/^https:\/\//)
      // And a note short enough to be a label is not a statement of the terms.
      expect(m.posture_note.length, m.id).toBeGreaterThan(60)
      expect(m.reviewed, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(m.reachable_in.length, m.id).toBeGreaterThan(0)
    }
  })

  it('never asserts a posture stronger than "unclear" without a provider source', () => {
    // The rule the spec states: anything without a citable statement is
    // `unclear_or_trains`. Inverted here, because that is the direction that fails
    // dangerously — a confident posture on no evidence.
    for (const m of MODEL_REGISTRY) {
      if (m.data_posture !== 'unclear_or_trains') {
        expect(m.posture_source, m.id).toMatch(/anthropic|claude\.com|ai\.google\.dev/)
      }
    }
  })

  it('cites the free-tier claim to its OWN page, not to the paid-tier one', () => {
    // The two claims live on two pages. Filing the free-tier caveat under the logs
    // policy, which says nothing about the free tier, fails the spec's rule while
    // looking like it passes.
    for (const m of MODEL_REGISTRY) {
      if (!m.free_tier_differs) {
        expect(m.free_tier_note, m.id).toBeNull()
        expect(m.free_tier_source, m.id).toBeNull()
        continue
      }
      expect(m.free_tier_note, m.id).toBeTruthy()
      expect(m.free_tier_source, m.id).toMatch(/^https:\/\//)
      expect(m.free_tier_source, m.id).not.toBe(m.posture_source)
    }
  })

  it('gives every price note a real chrome node', () => {
    for (const m of MODEL_REGISTRY) {
      if (m.price_note_id) expect(findChromeNode(m.price_note_id), m.id).toBeTruthy()
    }
  })

  it('marks every Gemini entry as differing on the free tier, because it does', () => {
    // This is the fact that matters most for Joshua's deployment: draft-scenario's own
    // config comment says "Gemini free tier", and on that tier Google states content IS
    // used to improve its products. A Gemini entry that forgot this flag would show an
    // administrator a no-training posture that does not hold for the key in use.
    for (const m of MODEL_REGISTRY.filter((x) => x.provider === 'google')) {
      expect(m.free_tier_differs, m.id).toBe(true)
      expect(m.free_tier_note).toMatch(/free-tier|free tier/)
    }
    // Anthropic's posture has no tier split, so claiming one would be noise.
    for (const m of MODEL_REGISTRY.filter((x) => x.provider === 'anthropic')) {
      expect(m.free_tier_differs, m.id).toBe(false)
    }
  })

  it('has no duplicate ids', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offers at least one model to every mode, so no mode renders an empty picker', () => {
    for (const mode of ['github-claude', 'byo-agent', 'hosted-api'] as const) {
      expect(modelsForMode(mode).length, mode).toBeGreaterThan(0)
    }
  })

  it('only bills per token in the one mode that actually does', () => {
    expect(modeIsMetered('hosted-api')).toBe(true)
    expect(modeIsMetered('github-claude')).toBe(false)
    expect(modeIsMetered('byo-agent')).toBe(false)
  })

  it('resolves a recommendation to a real entry, with copy explaining why', () => {
    for (const rec of RECOMMENDATIONS) {
      expect(modelById(rec.model_id), rec.model_id).not.toBeNull()
      expect(findChromeNode(rec.whyId), rec.whyId).toBeTruthy()
    }
  })

  it('recommends for routing something cheaper than what it recommends for prose', () => {
    // The recommendations exist to separate a high-volume tier from a prose tier. If
    // the cheap one were not cheaper, the advice would be decoration.
    const routing = modelById(RECOMMENDATIONS.find((r) => r.job === 'routing')!.model_id)!
    const prose = modelById(RECOMMENDATIONS.find((r) => r.job === 'prose')!.model_id)!
    expect(routing.output_per_mtok).toBeLessThan(prose.output_per_mtok)
    expect(routing.tier).toBe('high_volume')
    expect(prose.tier).toBe('strong')
  })

  it('defaults to the model the deployed Edge Function already uses', () => {
    // tl-13's D2 was a literal in the function disagreeing with the app's own data.
    // The same shape of bug would be a registry recommending a model the server never
    // calls, so the default is pinned to draft-scenario's own fallback.
    const dflt = RECOMMENDATIONS.find((r) => r.job === 'default')!.model_id
    const fn = readFileSync('supabase/functions/draft-scenario/index.ts', 'utf8')
    expect(fn).toContain(`?? '${dflt}'`)
  })

  it('is not stale today, and says so honestly once it is', () => {
    expect(registryIsStale(new Date(`${REGISTRY_REVIEWED}T12:00:00Z`))).toBe(false)
    // A year on, the copy must call it stale rather than quietly trusting the prices.
    expect(registryIsStale(new Date('2027-08-03T00:00:00Z'))).toBe(true)
    // An unparseable date is treated as stale, which is the safe direction.
    expect(registryIsStale(new Date(), 'not-a-date')).toBe(true)
  })

  it('returns null for a model id this build does not know', () => {
    // A stored model written by a newer client must not throw on an older one.
    expect(modelById('gpt-9')).toBeNull()
    expect(modelById(null)).toBeNull()
    expect(modelById('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The two copies of the assumption list — TypeScript's and Postgres's
// ---------------------------------------------------------------------------

describe('the assumption keys are the same in both places', () => {
  const sql = readFileSync('supabase/migrations/20260803000100_ai_assumptions.sql', 'utf8')

  /**
   * The migration with its `--` comments stripped.
   *
   * Needed because this file's comments quote the very DDL they exist to warn against
   * ("its first draft re-declared tl-11's platform_setting with `create table if not
   * exists`"), so a check for that DDL run over the raw text fails on the explanation
   * rather than on a statement. Asserting against executable SQL only is also the
   * more honest test: what matters is what Postgres runs, not what the file says.
   */
  const ddl = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')

  it('mirrors DEFAULT_ASSUMPTIONS into ai_assumptions_are_legal', () => {
    // The pairing tl-13 established for AI_FUNCTION_DEFAULTS, for the same reason: SQL
    // cannot import TypeScript, so a test is the only thing that can hold the copies
    // together. Without this, adding an assumption to the estimator and forgetting the
    // migration means the database silently refuses every save from the new client.
    const block = sql.match(/_key not in \(([\s\S]*?)\) then/)
    expect(block, 'the key list was not found in the migration').toBeTruthy()
    const inSql = [...block![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort()
    const inTs = Object.keys(DEFAULT_ASSUMPTIONS).sort()
    expect(inSql).toEqual(inTs)
  })

  it('does not re-declare ai_config, because that is how tl-13 reopened a write path', () => {
    // The load-bearing property of this migration. `if not exists` protects an object's
    // shape and says nothing about the grants beside it, so a re-declaration can be a
    // no-op and a regression in one breath.
    expect(ddl).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?ai_config/i)
    expect(ddl).toMatch(/alter table ai_config\s+add column if not exists assumptions jsonb/i)
    // And it adds no grant and no policy: ai_config's own policies already govern the
    // column, since a policy is on a table rather than on its columns. Also no revoke:
    // this migration must not narrow what tl-13 opened either.
    expect(ddl).not.toMatch(/\bgrant\b/i)
    expect(ddl).not.toMatch(/\brevoke\b/i)
    expect(ddl).not.toMatch(/create policy/i)
    expect(ddl).not.toMatch(/drop policy/i)
  })

  it('keeps tl-13’s two invariants in the trigger it re-declares', () => {
    // The trigger is re-declared in full to add one check. Dropping either of the
    // original two would be silent: a workshop could select a mode the deployment
    // forbids, or store a function map no client can read.
    expect(sql).toMatch(/ai_functions_are_legal\(new\.functions\)/)
    expect(sql).toMatch(/ai_assumptions_are_legal\(new\.assumptions\)/)
    expect(sql).toMatch(/tl13\.hosted_ai_not_enabled_here/)
    expect(sql).toMatch(/new\.updated_at := now\(\)/)
  })

  it('refuses a negative assumption server-side, not merely on the client', () => {
    expect(sql).toMatch(/tl14\.assumption_must_not_be_negative/)
    expect(sql).toMatch(/tl14\.unknown_assumption/)
    expect(sql).toMatch(/tl14\.assumption_must_be_a_number/)
  })
})

// ---------------------------------------------------------------------------
// Presentation honesty, as far as it is testable without a browser
// ---------------------------------------------------------------------------

describe('presentation honesty', () => {
  it('states its exclusions as data, so a range cannot be rendered without them', () => {
    expect(EXCLUSIONS.length).toBeGreaterThanOrEqual(3)
    for (const id of EXCLUSIONS) {
      expect(findChromeNode(id), id).toBeTruthy()
    }
  })

  it('labels every component with what was derived and what was assumed', () => {
    const r = estimateWorkshopTokens({ ...BALI, conversations: 4 }, AI_FUNCTIONS, A)
    for (const c of r.components) {
      expect(c.basis.derived.length + c.basis.assumed.length, c.fn).toBeGreaterThan(0)
      // Every named assumption must be a real assumption key, or the panel would render
      // a label for a control that does not exist.
      for (const key of c.basis.assumed) {
        expect(Object.keys(DEFAULT_ASSUMPTIONS), `${c.fn} -> ${key}`).toContain(key)
      }
    }
  })

  it('has copy for every function’s row and every assumption’s label', () => {
    for (const fn of AI_FUNCTIONS) {
      expect(findChromeNode(`setup.ai.fn.${fn}`), fn).toBeTruthy()
    }
    for (const key of Object.keys(DEFAULT_ASSUMPTIONS)) {
      expect(findChromeNode(`setup.ai.assume.${key}`), key).toBeTruthy()
    }
  })

  it('has copy for every DERIVED field a component can name', () => {
    // The failure this prevents shipped once: the derived half of the basis rendered
    // raw camelCase identifiers while the assumed half rendered prose.
    const r = estimateWorkshopTokens({ ...BALI, conversations: 4 }, AI_FUNCTIONS, A)
    const named = new Set(r.components.flatMap((cp) => cp.basis.derived))
    expect(named.size).toBeGreaterThan(0)
    for (const key of named) {
      expect(findChromeNode(`setup.ai.derived.${key}`), key).toBeTruthy()
    }
  })

  it('has copy for every posture, so no posture renders as a raw enum', () => {
    for (const posture of new Set(MODEL_REGISTRY.map((m) => m.data_posture))) {
      expect(findChromeNode(`setup.ai.posture.${posture.replace(/_/g, '-')}`), posture).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// tl-13's D4 leftover: the harness that writes a fake audit record
// ---------------------------------------------------------------------------

describe('the git-tracked setup log', () => {
  const log = readFileSync('src/setup/log.ts', 'utf8')

  it('does not export to the git-tracked file in a local-only build', () => {
    // The debt tl-13 left in D4 and this spec's own harness reproduced: every browser
    // harness runs with both Supabase variables blank, drives real Setup saves against
    // a fixture workshop, and was posting them to `feedback/setup-changes/<date>.md` —
    // leaving files on disk that read exactly like an audit record of edits to the live
    // database. Pinned as a test rather than only fixed, because the failure is silent:
    // the file looks like a legitimate record, and nothing about a passing suite would
    // reveal that a later refactor had dropped the guard.
    const body = log.slice(log.indexOf('async function exportSetupLogEntry'))
    expect(body).toMatch(/if \(!isSupabaseConfigured\) return false/)
    // And the guard must be the FIRST statement, before the fetch is built: a check
    // placed after the POST would be no guard at all.
    expect(body.indexOf('!isSupabaseConfigured')).toBeLessThan(body.indexOf('fetch('))
  })

  it('still logs to Dexie and Postgres regardless, because that is the real record', () => {
    // The guard is scoped to the dev-server export only. Narrowing the Dexie write or
    // the `log_setup_change()` push would turn a cosmetic fix into a lost audit trail.
    const write = log.slice(log.indexOf('export async function logSetupChange'))
    expect(write).toMatch(/db\.setupChangeLog\.put\(entry\)/)
    expect(write).toMatch(/void pushSetupLog\(\)/)
    const putAt = write.indexOf('db.setupChangeLog.put(entry)')
    expect(write.slice(0, putAt)).not.toMatch(/isSupabaseConfigured/)
  })
})
