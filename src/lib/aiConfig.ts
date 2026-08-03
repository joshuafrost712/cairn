/**
 * AI provider modes and function toggles, resolved from storage. Pure: no IO, no
 * Dexie, no React (tl-13).
 *
 * The same split db/settings.ts has with lib/settings.ts, and for the same reason:
 * the readers are everywhere and the storage shape is jsonb, so exactly one module
 * translates between them and nothing downstream ever parses a stored value or
 * remembers a default.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT. A resolved config answers "what did the
 * administrator choose"; it does not answer "may this call happen". That second
 * question is settled server-side by `ai_call_permitted()` in
 * 20260802000100_ai_config.sql, because a switch enforced only in the client is a
 * UI preference wearing a permission's clothes: whoever can open a console can
 * call the endpoint directly. `aiEnabled()` in ../ai/aiEnabled.ts is the client's
 * copy of that decision, and it is the copy that decides what to RENDER and
 * whether to bother making the request.
 */

/** How the workshop's AI work gets done. */
export const AI_MODES = ['github-claude', 'byo-agent', 'hosted-api'] as const
export type AiMode = (typeof AI_MODES)[number]

export const DEFAULT_AI_MODE: AiMode = 'github-claude'

/**
 * The five functions a model could do work for, all declared from the start.
 *
 * Joshua's decision (2026-08-02): the three unbuilt ones are NAMED and marked
 * rather than omitted, so tl-14 through tl-16 add no migration. What that decision
 * also requires is that a toggle governing nothing is never presented as a working
 * toggle — see `AI_FUNCTION_BUILT`.
 */
export const AI_FUNCTIONS = [
  'observation_routing',
  'scenario_draft',
  'narrative_prose',
  'email_drafting',
  'conversation_guidance',
] as const
export type AiFunction = (typeof AI_FUNCTIONS)[number]

/**
 * Whether this build actually has a call path for a function.
 *
 * `false` is not "off": it is "there is nothing here to switch". The UI says so,
 * and `aiEnabled()` refuses regardless of the stored value, so a row written by a
 * newer client cannot make this build attempt a call it has no code for.
 */
export const AI_FUNCTION_BUILT: Record<AiFunction, boolean> = {
  observation_routing: true,
  scenario_draft: true,
  narrative_prose: false,
  email_drafting: false,
  conversation_guidance: true,
}

/**
 * What a function does when the workshop has said nothing.
 *
 * The spec asks for "off by default except observation routing". Scenario
 * draft-fill is on here too, and the deviation is argued rather than assumed: the
 * spec's reason for exempting routing is that it is "the pipeline the app already
 * depends on", and draft-fill is the only other thing in this category — it is a
 * live, working button in Setup today. Defaulting it off would have taken a
 * working feature away from every existing workshop in the name of a switch
 * nobody had asked for, and the spec's own regression criterion ("the existing
 * scenario draft-fill still works") would have failed on the first workshop that
 * had no ai_config row, which is all of them.
 *
 * `ai_call_permitted()` in the migration mirrors this exactly. If one changes, the
 * other must; `test/aiEnabled.test.ts` pins the pair by asserting on the list.
 */
export const AI_FUNCTION_DEFAULTS: Record<AiFunction, boolean> = {
  observation_routing: true,
  scenario_draft: true,
  narrative_prose: false,
  email_drafting: false,
  conversation_guidance: false,
}

/** One function's settings. `model` is null until tl-14's registry names any. */
export interface AiFunctionConfig {
  enabled: boolean
  model: string | null
}

/** A workshop's resolved AI configuration, every default already applied. */
export interface AiConfig {
  /** Null when nothing is stored: the app's pre-tl-13 behaviour. */
  workshop_id: string | null
  mode: AiMode
  functions: Record<AiFunction, AiFunctionConfig>
  /**
   * The estimator's assumption overrides (tl-14), SPARSE: only what an administrator
   * actually changed.
   *
   * The one field on this interface that is not fully resolved, and the exception is
   * argued rather than sloppy. Everything else here has its default applied because a
   * caller must never have to remember one; assumptions stay sparse because the
   * defaults are the estimator's and change with it — resolving them into the row
   * would freeze a workshop on whatever `DEFAULT_ASSUMPTIONS` said the day somebody
   * last opened the panel, so a corrected default would silently never reach it.
   * Run `resolveAssumptions()` from ../ai/estimate to get a complete set. It lives
   * there rather than here because the estimator owns the keys, and importing them
   * into this module would make the two files circular.
   */
  assumptions: Record<string, number>
  updated_by: string | null
  updated_at: string | null
}

/** One `ai_config` row as Postgres and Dexie both hold it. */
export interface AiConfigRow {
  workshop_id: string
  mode: string
  /** jsonb: a partial map of function -> { enabled, model }. */
  functions: unknown
  /** jsonb: a partial map of estimator assumption -> number (tl-14). */
  assumptions?: unknown
  updated_by?: string | null
  updated_at?: string | null
}

function defaultFunctions(): Record<AiFunction, AiFunctionConfig> {
  return Object.fromEntries(
    AI_FUNCTIONS.map((fn) => [fn, { enabled: AI_FUNCTION_DEFAULTS[fn], model: null }]),
  ) as Record<AiFunction, AiFunctionConfig>
}

/** The configuration of a workshop that has authored none. */
export function defaultAiConfig(workshopId: string | null = null): AiConfig {
  return {
    workshop_id: workshopId,
    mode: DEFAULT_AI_MODE,
    functions: defaultFunctions(),
    assumptions: {},
    updated_by: null,
    updated_at: null,
  }
}

/**
 * Read the stored assumptions map: known-shaped entries only.
 *
 * Shape validation, not defaulting — `resolveAssumptions` in ../ai/estimate does the
 * defaulting, and this only decides what counts as a stored number at all. Anything
 * non-finite or negative is dropped rather than carried, because a NaN reaching the
 * estimator renders as "NaN tokens" on screen and a negative one would subtract from
 * a total, which would read as a workshop being cheaper than doing nothing.
 *
 * The key list is deliberately NOT checked here. The estimator owns the keys and
 * ignores ones it does not know (the database refuses them outright, per
 * `ai_assumptions_are_legal`), so duplicating the list in this module would be a
 * third copy to keep in step for no gain.
 */
function readAssumptions(stored: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out
  for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) out[key] = raw
  }
  return out
}

export const DEFAULT_AI_CONFIG: AiConfig = defaultAiConfig(null)

const isMode = (value: unknown): value is AiMode =>
  typeof value === 'string' && (AI_MODES as readonly string[]).includes(value)

const isFunction = (value: string): value is AiFunction =>
  (AI_FUNCTIONS as readonly string[]).includes(value)

/**
 * Resolve a stored row into a configuration.
 *
 * TOLERANT IN ONE DIRECTION ONLY. An unrecognized mode or function key falls back
 * to the default rather than propagating, because a newer client may have written
 * a value this build has no code for and the honest reading of "a mode I cannot
 * service" is "the mode that works". The database is the strict half: its trigger
 * REFUSES an unknown function outright (`ai_functions_are_legal`), so tolerance
 * here cannot be used to smuggle a value in.
 *
 * Filters by workshop like `buildScale` does, rather than trusting the caller to
 * have queried correctly: a configuration silently assembled from another
 * workshop's row would decide where this workshop's evidence gets sent, and
 * nothing on screen would look wrong.
 */
export function resolveAiConfig(
  workshopId: string | null,
  rows: AiConfigRow[],
): AiConfig {
  const base = defaultAiConfig(workshopId)
  if (!workshopId) return base
  const row = rows.find((r) => r.workshop_id === workshopId)
  if (!row) return base

  const functions = defaultFunctions()
  const stored = row.functions
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
      if (!isFunction(key)) continue
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as { enabled?: unknown; model?: unknown }
      functions[key] = {
        enabled:
          typeof entry.enabled === 'boolean' ? entry.enabled : AI_FUNCTION_DEFAULTS[key],
        model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : null,
      }
    }
  }

  return {
    workshop_id: workshopId,
    mode: isMode(row.mode) ? row.mode : DEFAULT_AI_MODE,
    functions,
    assumptions: readAssumptions(row.assumptions),
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/** The jsonb `functions` value to store for a resolved config. */
export function functionsValue(config: AiConfig): Record<string, AiFunctionConfig> {
  return Object.fromEntries(
    AI_FUNCTIONS.map((fn) => [
      fn,
      { enabled: config.functions[fn].enabled, model: config.functions[fn].model },
    ]),
  )
}

/**
 * Why a mode cannot be selected here, as a chrome node id, or null when it can.
 *
 * A REASON RATHER THAN A HIDDEN CONTROL. The spec is explicit that `hosted-api`
 * without a backend is "disabled with the reason shown, not degraded", and the
 * same applies to the deployment switch: an administrator who cannot select hosted
 * AI should learn that somebody owns that decision, not conclude the app cannot
 * do it. Product-thinking rule from Agent-Engineering-Protocol §7 — state the
 * capability boundary rather than letting somebody discover it by hitting it.
 */
export function modeUnavailableReason(
  mode: AiMode,
  deployment: { supabaseConfigured: boolean; hostedAiEnabled: boolean },
): string | null {
  if (mode !== 'hosted-api') return null
  if (!deployment.supabaseConfigured) return 'setup.ai.mode.hosted-needs-backend'
  if (!deployment.hostedAiEnabled) return 'setup.ai.mode.hosted-not-enabled-here'
  return null
}
