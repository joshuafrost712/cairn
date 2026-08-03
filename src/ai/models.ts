import type { AiMode } from '../lib/aiConfig'

/**
 * The model registry: what a workshop could send its evidence to, what that costs,
 * and what the provider says it does with the data (tl-14).
 *
 * DATA WITH A REVIEW DATE, NOT A LOOKUP. Every number and every posture below was
 * read off a published page on `REGISTRY_REVIEWED`, and the date is surfaced in the
 * UI beside the estimate. Pricing and retention terms change; a registry that cannot
 * say when it was last checked becomes quietly wrong, and an administrator deciding
 * where a participant's evidence goes deserves to know the answer is six weeks old
 * rather than live. `registryIsStale()` is the honest half of that.
 *
 * THE APP MAKES NO SAFETY CLAIM OF ITS OWN. There is no "data-safe" flag here, and
 * the omission is deliberate: this app is not in a position to warrant another
 * company's practices. `data_posture` states what a provider's own page says,
 * `posture_source` links the page, and `posture_note` quotes the substance so the
 * claim can be checked rather than trusted. All three are rendered under each entry,
 * which is the point: a first draft recorded the note and never showed it, leaving an
 * administrator with this app's three-word summary and a link, and nothing in between
 * to judge the summary by. Joshua's ask was to be able to pick a model he does not
 * have to worry about, and the honest form of that is showing him the terms, not
 * grading them for him.
 *
 * WHERE A CLAIM HAS TWO PAGES IT HAS TWO CITATIONS. Google states its paid-tier
 * position on the logs policy and its free-tier position on the pricing page, so those
 * are two fields with two links rather than one note under one of them. The spec's rule
 * is that a posture claim traces to a page that actually says it, and a caveat filed
 * under a page that is silent about it fails that rule while looking like it passes.
 *
 * WHAT IS NOT HERE, AND WHY. OpenAI, Mistral, and the other providers an operator
 * might hold a subscription to have no entry. The rule for a missing entry is the
 * same as for a missing statement — `unclear_or_trains` is the honest default — but
 * an entry with an invented price is worse than an absent one, and nothing in this
 * build can reach those providers anyway: `hosted-api` has exactly one endpoint and
 * it is Gemini. When `byo-agent` grows a brief pack (tl-15) that names other
 * providers, they get entries with prices read off their own pricing pages, not
 * prices recalled here.
 */

/** The date every price and posture below was read off a published page. */
export const REGISTRY_REVIEWED = '2026-08-03'

/** Past this, the copy calls the registry stale rather than quietly trusting it. */
export const REGISTRY_STALE_AFTER_DAYS = 183

/**
 * What a provider says it does with what you send it.
 *
 * Three values, each requiring a citable source on the entry. The ordering is
 * deliberate: `unclear_or_trains` is the default for anything without a statement,
 * because "we could not confirm" and "they train on it" have the same practical
 * consequence for somebody deciding whether to send a participant's evidence.
 */
export type DataPosture =
  /** Provider states it does not train on inputs and does not retain them beyond operational need. */
  | 'no_training_no_retention'
  /** Provider states it does not train on inputs, but retains them for a stated period. */
  | 'no_training_retained'
  /** No citable statement, or the provider does use the content to improve its products. */
  | 'unclear_or_trains'

/**
 * What the model is for, in this app's terms rather than a benchmark's.
 *
 * `high_volume` is the routing tier: thousands of short classification passes where
 * unit cost dominates. `strong` is the prose tier: reports and emails a human sends
 * under their own name, where register matters more than price. `balanced` is the
 * default tier for everything in between.
 */
export type CapabilityTier = 'high_volume' | 'balanced' | 'strong'

export interface ModelEntry {
  /** The provider's own model id, exactly as an API call would name it. */
  id: string
  display_name: string
  provider: 'anthropic' | 'google'
  tier: CapabilityTier
  /** USD per million input tokens, on the provider's standard paid tier. */
  input_per_mtok: number
  /** USD per million output tokens, on the provider's standard paid tier. */
  output_per_mtok: number
  context_window: number
  data_posture: DataPosture
  /** The page the posture was read from. Must actually say it. */
  posture_source: string
  /**
   * What that page says, in enough words to be checkable.
   *
   * RENDERED, not merely recorded. The three-word posture enum plus a link is not
   * enough to check a claim against: the enum is this app's summary and the link is a
   * page an administrator has to go and read. The note is the substance in between,
   * and it appears under each entry so the summary can be judged without leaving.
   */
  posture_note: string
  /**
   * True when the posture above holds only on the provider's PAID tier and its free
   * tier is `unclear_or_trains`.
   *
   * This is the field that matters most for this deployment and the reason it exists
   * rather than being folded into a note. `draft-scenario`'s own config comment says
   * "Gemini free tier — Google AI Studio key", and on that tier Google's pricing page
   * states content IS used to improve its products. So the difference between the two
   * tiers is the difference between "a participant's evidence is retained for 55 days
   * for abuse detection" and "a participant's evidence trains a product", and an
   * administrator choosing hosted AI has to be told which one they are on. Nothing in
   * the app can detect the tier of a key it never sees, so the panel states the
   * condition rather than guessing the answer.
   *
   * Rendered PER ENTRY, gated on this flag. The first draft printed the caveat once
   * above the whole list, which made it false for the three Anthropic entries whose
   * posture has no tier split, and worst of all in the two subscription modes where
   * those are the only reachable models: the one sentence on screen would then have
   * been wrong about every model the administrator could actually pick.
   */
  free_tier_differs: boolean
  /**
   * The free-tier claim, and the page that actually says it. Null when there is no
   * tier split.
   *
   * A SECOND SOURCE, because the two claims live on two different pages and the spec's
   * rule is that every posture claim traces to a page that actually says it. Google's
   * paid-tier wording is on the logs policy; its free-tier wording is on the pricing
   * page. Filing both under one link would leave an administrator clicking through to
   * substantiate the sentence that matters most here and not finding it there.
   */
  free_tier_note: string | null
  free_tier_source: string | null
  /**
   * A qualification on the price, as a chrome node id, or null.
   *
   * Exists because a registry whose purpose is a CURRENT price has to be able to say
   * "and this one is promotional". Sonnet 5 was on introductory pricing on the review
   * date; recording only the standard rate would have been accurate and misleading.
   */
  price_note_id: string | null
  /** Which provider modes in THIS build can actually reach the model. */
  reachable_in: AiMode[]
  /** Date this entry's price and posture were read. Normally `REGISTRY_REVIEWED`. */
  reviewed: string
}

/**
 * Anthropic's posture, shared by every Claude entry because it is a property of the
 * API rather than of a model.
 *
 * The page says both halves plainly: "Retained data is never used for model training
 * without your express permission" and "Conversation content (your prompts and
 * Claude's outputs) is not retained by default". That pair is what
 * `no_training_no_retention` means, and it is the strongest posture in the registry.
 *
 * The documented exception is Covered Models (Fable 5, Mythos 5), which require
 * 30-day retention. No Covered Model is listed here, so no entry carries it — if one
 * is added later it is `no_training_retained`, not this constant.
 */
const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention'
const ANTHROPIC_NOTE =
  'Anthropic states retained data is never used for model training without express permission, and that conversation content is not retained by default. Zero data retention is available on request. The same page names two exceptions: its Covered Models require 30-day retention (none is listed here), and content flagged by trust-and-safety systems may be kept up to 2 years.'

/**
 * Google's posture on the PAID Gemini tier, and the free-tier caveat that rides with it.
 *
 * The logs policy says "prompts and responses within logs are not used for product
 * improvement or development" and "Logs are retained for a default maximum period of
 * 55 days", configurable down to 7. That is `no_training_retained`: a real
 * no-training commitment with a real retention window, which is a weaker posture than
 * Anthropic's and should read as weaker rather than being flattened into "safe".
 *
 * The free tier is a different answer to the same question — Google's pricing page
 * marks free-tier content as used to improve its products — which is why every Gemini
 * entry sets `free_tier_differs`.
 */
const GOOGLE_SOURCE = 'https://ai.google.dev/gemini-api/docs/logs-policy'
const GOOGLE_NOTE =
  'On the paid tier Google states prompts and responses within logs are not used for product improvement or development, and that logs are retained for a default maximum period of 55 days, configurable down to 7.'

/**
 * The free-tier half, and its own page.
 *
 * Google's pricing page is where the tier split is actually stated, in as many words:
 * free tier "Content used to improve our products", paid tier "Content not used to
 * improve our products". The logs policy above says nothing about the free tier, which
 * is why this claim cannot ride on that citation.
 */
const GOOGLE_FREE_TIER_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing'
const GOOGLE_FREE_TIER_NOTE =
  'Google’s pricing page marks free-tier content as "used to improve our products", against "not used to improve our products" on the paid tier. So the posture above holds only on a paid key. This deployment’s draft-scenario function documents a free Google AI Studio key; the app never sees the key and cannot tell which tier is in use, but whoever set it can.'

/**
 * The registry.
 *
 * Kept short on purpose. The spec asks for a small reasoned set rather than a
 * dropdown of everything a provider sells, because the decision an administrator is
 * making is "cheap enough for routing" or "good enough for prose", and eleven models
 * do not help them make it.
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  // ---- Google, the only provider a metered call in this build can reach ----
  {
    id: 'gemini-2.5-flash-lite',
    display_name: 'Gemini 2.5 Flash-Lite',
    provider: 'google',
    tier: 'high_volume',
    input_per_mtok: 0.1,
    output_per_mtok: 0.4,
    context_window: 1_000_000,
    data_posture: 'no_training_retained',
    posture_source: GOOGLE_SOURCE,
    posture_note: GOOGLE_NOTE,
    free_tier_differs: true,
    free_tier_note: GOOGLE_FREE_TIER_NOTE,
    free_tier_source: GOOGLE_FREE_TIER_SOURCE,
    price_note_id: null,
    reachable_in: ['hosted-api'],
    reviewed: REGISTRY_REVIEWED,
  },
  {
    id: 'gemini-2.5-flash',
    display_name: 'Gemini 2.5 Flash',
    provider: 'google',
    tier: 'balanced',
    input_per_mtok: 0.3,
    output_per_mtok: 2.5,
    context_window: 1_000_000,
    data_posture: 'no_training_retained',
    posture_source: GOOGLE_SOURCE,
    posture_note: GOOGLE_NOTE,
    free_tier_differs: true,
    free_tier_note: GOOGLE_FREE_TIER_NOTE,
    free_tier_source: GOOGLE_FREE_TIER_SOURCE,
    price_note_id: null,
    reachable_in: ['hosted-api'],
    reviewed: REGISTRY_REVIEWED,
  },
  {
    id: 'gemini-3.6-flash',
    display_name: 'Gemini 3.6 Flash',
    provider: 'google',
    tier: 'strong',
    input_per_mtok: 1.5,
    output_per_mtok: 7.5,
    context_window: 1_000_000,
    data_posture: 'no_training_retained',
    posture_source: GOOGLE_SOURCE,
    posture_note: GOOGLE_NOTE,
    free_tier_differs: true,
    free_tier_note: GOOGLE_FREE_TIER_NOTE,
    free_tier_source: GOOGLE_FREE_TIER_SOURCE,
    price_note_id: null,
    reachable_in: ['hosted-api'],
    reviewed: REGISTRY_REVIEWED,
  },

  // ---- Anthropic. Reachable through the repository hand-off, on a subscription
  //      rather than per token, which is why the estimator shows these as tokens and
  //      not as money unless the mode is hosted-api. The prices are still facts worth
  //      recording: they are what a comparison against Gemini needs.
  {
    id: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'high_volume',
    input_per_mtok: 1,
    output_per_mtok: 5,
    context_window: 200_000,
    data_posture: 'no_training_no_retention',
    posture_source: ANTHROPIC_SOURCE,
    posture_note: ANTHROPIC_NOTE,
    free_tier_differs: false,
    free_tier_note: null,
    free_tier_source: null,
    price_note_id: null,
    reachable_in: ['github-claude', 'byo-agent'],
    reviewed: REGISTRY_REVIEWED,
  },
  {
    id: 'claude-sonnet-5',
    display_name: 'Claude Sonnet 5',
    provider: 'anthropic',
    tier: 'balanced',
    input_per_mtok: 3,
    output_per_mtok: 15,
    context_window: 1_000_000,
    data_posture: 'no_training_no_retention',
    posture_source: ANTHROPIC_SOURCE,
    posture_note: ANTHROPIC_NOTE,
    free_tier_differs: false,
    free_tier_note: null,
    free_tier_source: null,
    price_note_id: 'setup.ai.model.price-intro',
    reachable_in: ['github-claude', 'byo-agent'],
    reviewed: REGISTRY_REVIEWED,
  },
  {
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    provider: 'anthropic',
    tier: 'strong',
    input_per_mtok: 5,
    output_per_mtok: 25,
    context_window: 1_000_000,
    data_posture: 'no_training_no_retention',
    posture_source: ANTHROPIC_SOURCE,
    posture_note: ANTHROPIC_NOTE,
    free_tier_differs: false,
    free_tier_note: null,
    free_tier_source: null,
    price_note_id: null,
    reachable_in: ['github-claude', 'byo-agent'],
    reviewed: REGISTRY_REVIEWED,
  },
]

/** One entry by id, or null. Never throws: an unknown id is a stored value this build does not know. */
export function modelById(id: string | null | undefined): ModelEntry | null {
  if (!id) return null
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null
}

/** The models a given mode can actually reach in this build. */
export function modelsForMode(mode: AiMode): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.reachable_in.includes(mode))
}

/**
 * Whether this deployment's mode spends money per token.
 *
 * The one place the distinction lives. `github-claude` and `byo-agent` both run on
 * somebody's subscription, so a dollar figure beside them would be fiction; only
 * `hosted-api` bills per token. The estimator asks this rather than each caller
 * remembering which of three modes is the metered one.
 */
export function modeIsMetered(mode: AiMode): boolean {
  return mode === 'hosted-api'
}

/** A recommendation: one job, one model, one line saying why. */
export interface ModelRecommendation {
  /** What this recommendation is for, as a chrome node id suffix. */
  job: 'routing' | 'prose' | 'default'
  model_id: string
  /** Why, as a chrome node id. The reasoning is copy, so it lives in the content layer. */
  whyId: string
}

/**
 * Three recommendations, not a ranked list of everything.
 *
 * The default is `gemini-2.5-flash` because it is what the deployed Edge Function
 * already uses when `GEMINI_MODEL` is unset — recommending anything else would make
 * the registry's advice disagree with the app's own behaviour, which is the kind of
 * quiet contradiction tl-13's D2 was.
 */
export const RECOMMENDATIONS: ModelRecommendation[] = [
  { job: 'routing', model_id: 'gemini-2.5-flash-lite', whyId: 'setup.ai.model.why-routing' },
  { job: 'prose', model_id: 'claude-opus-5', whyId: 'setup.ai.model.why-prose' },
  { job: 'default', model_id: 'gemini-2.5-flash', whyId: 'setup.ai.model.why-default' },
]

/**
 * Whether the registry is old enough that the copy should say so.
 *
 * Takes `now` as a parameter rather than reading the clock, so it is testable and so
 * this module stays free of the one impurity that would make it awkward to unit-test.
 */
export function registryIsStale(now: Date, reviewed: string = REGISTRY_REVIEWED): boolean {
  const then = Date.parse(`${reviewed}T00:00:00Z`)
  if (Number.isNaN(then)) return true
  const days = (now.getTime() - then) / 86_400_000
  return days > REGISTRY_STALE_AFTER_DAYS
}

/**
 * The currency cost of a token count on one model, in USD.
 *
 * Returns null rather than 0 when there is no model, because "no model chosen" and
 * "free" are different facts and a 0 on screen would assert the second.
 */
export function estimateCostUsd(
  tokens: { inputTokens: number; outputTokens: number },
  model: ModelEntry | null,
): number | null {
  if (!model) return null
  return (
    (tokens.inputTokens / 1_000_000) * model.input_per_mtok +
    (tokens.outputTokens / 1_000_000) * model.output_per_mtok
  )
}
