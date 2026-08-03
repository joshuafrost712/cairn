import type { AiFunction } from '../lib/aiConfig'

/**
 * What running a workshop through a model would cost, in tokens (tl-14).
 *
 * PURE. No Dexie, no fetch, no clock, no React — every number comes in as an
 * argument. That is what lets `test/estimate.test.ts` check the arithmetic against
 * sums a reviewer can do on paper, which is this spec's acceptance criterion and not
 * merely good practice: an estimator nobody can check is a number nobody should act
 * on. `workshopShape.ts` is the impure half that reads the workshop.
 *
 * THE PURPOSE IS A DECISION, NOT A FORECAST. An administrator choosing between a
 * cheap model and an expensive one needs to know whether the difference is a few
 * dollars or a few hundred. That is achievable. Predicting a workshop's consumption
 * to the percent is not, and a figure with false precision is worse than a range —
 * the same argument the program applies to rarity bands and to
 * Planning-Quality-Protocol's significant-digits rule. So this returns low, expected
 * and high, and `EXCLUSIONS` says out loud what is not in any of them.
 *
 * EVERY NUMBER IS LABELLED DERIVED OR ASSUMED. `basis` on each component carries the
 * split, and the panel renders it, because that is the difference between an estimate
 * an administrator can argue with and one they have to believe. The assumptions are
 * the genuinely unknowable ones — how long a dictated capture runs, how many
 * evaluators watch an activity — and they are overridable for exactly that reason.
 */

/**
 * Characters per token, the one approximation the whole module rests on.
 *
 * Four is the standard rough ratio for English prose and it is deliberately NOT
 * dressed up as a measurement. A real tokenizer would be provider-specific, which
 * would tie this estimator to one vendor when its whole job is comparing several —
 * the spec puts Anthropic's token-counting API out of scope for that reason. The
 * consequence is honest: this is a two-significant-figure instrument, and the range
 * is wide enough to contain the error.
 */
export const CHARS_PER_TOKEN = 4

const tok = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN)

/**
 * Fixed sizes, in characters, for the things the app itself puts in a request.
 *
 * These are properties of this app's own prompts rather than guesses about a user, so
 * they are constants rather than assumptions. `ROUTING_CONTRACT_CHARS` covers the
 * routing rules and JSON schema that `renderRoutingDoc` and `renderSchemaJson` put
 * beside every capture; the rubric and roster are measured for real and arrive on the
 * shape instead.
 */
export const ROUTING_CONTRACT_CHARS = 4_000
export const OBSERVATION_CHARS = 400
export const SCENARIO_PROMPT_CHARS = 2_000
export const SCENARIO_OUTPUT_CHARS_PER_QUESTION = 600
export const REPORT_OUTPUT_CHARS = 4_000
export const EMAIL_OUTPUT_CHARS = 1_200
export const GUIDANCE_OUTPUT_CHARS = 1_500

/**
 * The workshop's measurable shape. Everything here is read from the workshop itself.
 *
 * `observedCaptureChars` is the one nullable field and it is the calibration hook: if
 * the workshop already holds real captures, their mean length replaces the assumed
 * one and the panel says so. An estimator never compared to an outcome stays wrong
 * indefinitely.
 */
export interface WorkshopShape {
  activities: number
  participants: number
  /** Mean questions wired per activity. */
  questionsPerActivity: number
  /** Size of the rubric document each capture carries, measured. */
  rubricChars: number
  /** Size of the roster document each capture carries, measured. */
  rosterChars: number
  /** Follow-up conversations already derived for this workshop. */
  conversations: number
  /** Mean length of this workshop's real captures, or null when it has none yet. */
  observedCaptureChars: number | null
}

export const EMPTY_SHAPE: WorkshopShape = {
  activities: 0,
  participants: 0,
  questionsPerActivity: 0,
  rubricChars: 0,
  rosterChars: 0,
  conversations: 0,
  observedCaptureChars: null,
}

/**
 * The genuinely unknowable inputs, with stated defaults an administrator can change.
 *
 * Each one is a question the workshop cannot answer from its own data. They are
 * stored per workshop (`ai_config.assumptions`) so a change survives a reload, and
 * they are rendered as assumptions rather than facts.
 */
export interface EstimateAssumptions {
  /** Mean characters in one dictated capture. */
  captureChars: number
  /** How many evaluators capture against the same activity. */
  evaluatorsPerActivity: number
  /**
   * The fraction of participants an evaluator names per activity.
   *
   * 0.5 rather than 1 because an evaluator watching a room of 22 does not produce an
   * observation about every one of them for every question. This is the single
   * assumption with the largest leverage on the total, which is why it is on screen.
   */
  observationCoverage: number
  /** Narrative reports generated per participant over the workshop. */
  reportsPerParticipant: number
  /** Participant-facing emails drafted per participant. */
  emailsPerParticipant: number
  /** Event digests drafted per activity. */
  digestsPerEvent: number
  /** Discrepancy notes expected. Zero by default: an administrator knows, the app does not. */
  discrepancyNotes: number
  /** Observations quoted as evidence into one conversation's guidance. */
  observationsPerConversation: number
  /** Characters in the document handed to scenario draft-fill, when it is used at all. */
  documentChars: number
  /** Multipliers on the expected case, from the variance in capture length. */
  lowMultiplier: number
  highMultiplier: number
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = {
  captureChars: 1_200,
  evaluatorsPerActivity: 2,
  observationCoverage: 0.5,
  reportsPerParticipant: 1,
  emailsPerParticipant: 1,
  digestsPerEvent: 1,
  discrepancyNotes: 0,
  observationsPerConversation: 3,
  documentChars: 20_000,
  lowMultiplier: 0.6,
  highMultiplier: 1.8,
}

/**
 * What no number in this estimate includes.
 *
 * Chrome node ids rather than prose, because it is user-facing copy. Stated as data
 * so the panel cannot render a range without also rendering its exclusions — the
 * spec asks for the range and what is in it in the same breath, and a list the
 * component has to remember to print is one it will eventually forget.
 */
export const EXCLUSIONS = [
  'setup.ai.est.excl-retries',
  'setup.ai.est.excl-rerouting',
  'setup.ai.est.excl-operator',
] as const

export interface TokenPair {
  inputTokens: number
  outputTokens: number
}

const ZERO: TokenPair = { inputTokens: 0, outputTokens: 0 }

const add = (a: TokenPair, b: TokenPair): TokenPair => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})

const scale = (t: TokenPair, factor: number): TokenPair => ({
  inputTokens: Math.round(t.inputTokens * factor),
  outputTokens: Math.round(t.outputTokens * factor),
})

/** The total tokens in a pair, for the one-number-on-screen case. */
export const totalTokens = (t: TokenPair): number => t.inputTokens + t.outputTokens

export interface EstimateComponent {
  fn: AiFunction
  inputTokens: number
  outputTokens: number
  /**
   * True for work that happens once for the whole workshop rather than per day.
   *
   * Shown separately rather than folded into a rate, because a one-off amortised
   * into a per-day figure misleads in both directions: it inflates a short workshop
   * and vanishes in a long one.
   */
  oneOff: boolean
  /** Which shape fields drove it, and which assumptions. Field names, not copy. */
  basis: { derived: string[]; assumed: string[] }
}

export interface EstimateResult {
  components: EstimateComponent[]
  /** Sum of the components that recur through the workshop. */
  recurring: TokenPair
  /** Sum of the components that happen once. */
  oneOff: TokenPair
  /** recurring + oneOff, and the low/high band around it. */
  expected: TokenPair
  low: TokenPair
  high: TokenPair
  /** True when `observedCaptureChars` replaced the assumed capture length. */
  usedObservedCaptureLength: boolean
}

/**
 * The capture length actually used: measured if the workshop has captures, else assumed.
 *
 * Exported because the panel labels the number differently depending which it was,
 * and re-deriving that in the component would let the label disagree with the maths.
 */
export function effectiveCaptureChars(
  shape: WorkshopShape,
  assumptions: EstimateAssumptions,
): { chars: number; observed: boolean } {
  const observed = shape.observedCaptureChars
  if (observed != null && observed > 0) return { chars: observed, observed: true }
  return { chars: assumptions.captureChars, observed: false }
}

/**
 * Estimate one workshop's token consumption for the functions that are switched on.
 *
 * A disabled function contributes no component at all rather than a zero one, so
 * "everything off" returns an empty component list and a genuine zero — the spec's
 * fourth acceptance case, and the reason nothing here has a floor.
 */
export function estimateWorkshopTokens(
  shape: WorkshopShape,
  enabledFunctions: readonly AiFunction[],
  assumptions: EstimateAssumptions = DEFAULT_ASSUMPTIONS,
): EstimateResult {
  const on = new Set(enabledFunctions)
  const { chars: captureChars, observed } = effectiveCaptureChars(shape, assumptions)

  // Observations across the whole workshop. Linear in participants by construction,
  // which is what makes the doubling property testable rather than coincidental.
  const observations =
    shape.activities *
    shape.participants *
    shape.questionsPerActivity *
    assumptions.observationCoverage
  const observationsPerParticipant =
    shape.activities * shape.questionsPerActivity * assumptions.observationCoverage

  const components: EstimateComponent[] = []

  if (on.has('observation_routing')) {
    // Each capture is self-contained: it carries the rubric, the roster and the
    // contract alongside the dictated text. That is `buildCaptureFile`'s design and
    // it is why the input side is measurable rather than guessed.
    const captures = shape.activities * assumptions.evaluatorsPerActivity
    const perCapture = captureChars + shape.rubricChars + shape.rosterChars + ROUTING_CONTRACT_CHARS
    components.push({
      fn: 'observation_routing',
      inputTokens: tok(captures * perCapture),
      outputTokens: tok(observations * OBSERVATION_CHARS),
      oneOff: false,
      basis: {
        derived: ['activities', 'participants', 'questionsPerActivity', 'rubricChars', 'rosterChars'],
        assumed: observed
          ? ['evaluatorsPerActivity', 'observationCoverage']
          : ['captureChars', 'evaluatorsPerActivity', 'observationCoverage'],
      },
    })
  }

  if (on.has('scenario_draft')) {
    // One call per document, and a workshop is set up once. Output is bounded by the
    // scenario schema, so it scales with questions rather than with the document.
    components.push({
      fn: 'scenario_draft',
      inputTokens: tok(assumptions.documentChars + SCENARIO_PROMPT_CHARS),
      outputTokens: tok(shape.questionsPerActivity * SCENARIO_OUTPUT_CHARS_PER_QUESTION),
      oneOff: true,
      basis: { derived: ['questionsPerActivity'], assumed: ['documentChars'] },
    })
  }

  if (on.has('narrative_prose')) {
    const reports = shape.participants * assumptions.reportsPerParticipant
    const evidencePerParticipant = observationsPerParticipant * OBSERVATION_CHARS + shape.rubricChars
    components.push({
      fn: 'narrative_prose',
      inputTokens: tok(reports * evidencePerParticipant),
      outputTokens: tok(reports * REPORT_OUTPUT_CHARS),
      oneOff: false,
      basis: {
        derived: ['participants', 'activities', 'questionsPerActivity', 'rubricChars'],
        assumed: ['reportsPerParticipant', 'observationCoverage'],
      },
    })
  }

  if (on.has('email_drafting')) {
    // Counted per DocKind, because a participant email and an event digest are
    // different documents drawn from different evidence.
    const participantEmails = shape.participants * assumptions.emailsPerParticipant
    const digests = shape.activities * assumptions.digestsPerEvent
    const notes = assumptions.discrepancyNotes
    const perEmailEvidence = observationsPerParticipant * OBSERVATION_CHARS
    const perDigestEvidence =
      shape.participants * shape.questionsPerActivity * assumptions.observationCoverage * OBSERVATION_CHARS
    components.push({
      fn: 'email_drafting',
      inputTokens: tok(
        participantEmails * perEmailEvidence + (digests + notes) * perDigestEvidence,
      ),
      outputTokens: tok((participantEmails + digests + notes) * EMAIL_OUTPUT_CHARS),
      oneOff: false,
      basis: {
        derived: ['participants', 'activities', 'questionsPerActivity'],
        assumed: ['emailsPerParticipant', 'digestsPerEvent', 'discrepancyNotes', 'observationCoverage'],
      },
    })
  }

  if (on.has('conversation_guidance')) {
    const evidencePerConversation =
      assumptions.observationsPerConversation * OBSERVATION_CHARS + shape.rubricChars
    components.push({
      fn: 'conversation_guidance',
      inputTokens: tok(shape.conversations * evidencePerConversation),
      outputTokens: tok(shape.conversations * GUIDANCE_OUTPUT_CHARS),
      oneOff: false,
      basis: {
        derived: ['conversations', 'rubricChars'],
        assumed: ['observationsPerConversation'],
      },
    })
  }

  const recurring = components
    .filter((c) => !c.oneOff)
    .reduce((acc, c) => add(acc, { inputTokens: c.inputTokens, outputTokens: c.outputTokens }), ZERO)
  const oneOff = components
    .filter((c) => c.oneOff)
    .reduce((acc, c) => add(acc, { inputTokens: c.inputTokens, outputTokens: c.outputTokens }), ZERO)
  const expected = add(recurring, oneOff)

  return {
    components,
    recurring,
    oneOff,
    expected,
    low: scale(expected, assumptions.lowMultiplier),
    high: scale(expected, assumptions.highMultiplier),
    usedObservedCaptureLength: observed && components.some((c) => c.fn === 'observation_routing'),
  }
}

/**
 * Resolve a stored assumptions object into a complete one.
 *
 * Tolerant in one direction, exactly like `resolveAiConfig`: an unknown key is
 * ignored and a non-finite or negative value falls back to the default rather than
 * propagating, because an estimate built on a NaN renders as "NaN tokens" and an
 * administrator cannot tell that from a bug in the arithmetic. The multipliers are
 * additionally ordered, so a stored low above a stored high cannot produce a band
 * that reads backwards.
 */
export function resolveAssumptions(stored: unknown): EstimateAssumptions {
  const out: EstimateAssumptions = { ...DEFAULT_ASSUMPTIONS }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out
  for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!(key in DEFAULT_ASSUMPTIONS)) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    out[key as keyof EstimateAssumptions] = raw
  }
  // The band must bracket the expected case, not merely be ordered. A stored pair of
  // {low: 1.5, high: 1.8} passes an ordering check and still puts a figure labelled
  // "Low" above the expected one, which is a chart that lies about its own middle.
  if (out.lowMultiplier > 1 || out.highMultiplier < 1 || out.lowMultiplier > out.highMultiplier) {
    out.lowMultiplier = DEFAULT_ASSUMPTIONS.lowMultiplier
    out.highMultiplier = DEFAULT_ASSUMPTIONS.highMultiplier
  }
  return out
}

/** The assumptions that differ from the defaults, for storage. Empty object when none do. */
export function assumptionsValue(a: EstimateAssumptions): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(DEFAULT_ASSUMPTIONS) as (keyof EstimateAssumptions)[]) {
    if (a[key] !== DEFAULT_ASSUMPTIONS[key]) out[key] = a[key]
  }
  return out
}
