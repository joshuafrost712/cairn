import {
  AI_FUNCTION_BUILT,
  AI_FUNCTION_DEFAULTS,
  AI_FUNCTIONS,
  type AiConfig,
  type AiFunction,
} from '../lib/aiConfig'

/**
 * The one guard (tl-13).
 *
 * Checked INSIDE the provider entry point (`runAiJob` in ./providers/index.ts) so
 * a caller cannot bypass it by construction: there is no other way into a provider,
 * and a call that reaches one has already been through here. That placement is the
 * spec's requirement and it is the difference between a toggle and a hidden button.
 *
 * WHAT THIS IS NOT. It is not the permission. The permission is
 * `ai_call_permitted()` in Postgres, called by every Edge Function with the
 * caller's verified identity, because whoever can open a console can invoke an
 * endpoint whatever this function returns. Both exist on purpose and neither
 * replaces the other: this one decides what to render and whether to spend a round
 * trip, that one decides whether the work happens.
 */
export function aiEnabled(fn: AiFunction, config: AiConfig): boolean {
  // An unbuilt function is refused whatever the stored value says. A newer client
  // may have switched something on that this build has no code for, and attempting
  // it would fail somewhere less honest than here.
  if (!AI_FUNCTION_BUILT[fn]) return false
  return config.functions[fn]?.enabled ?? AI_FUNCTION_DEFAULTS[fn]
}

/**
 * Why a function is unavailable, as a chrome node id, or null when it is available.
 *
 * Separate from the boolean because the UI owes the user a reason and the guard
 * owes the caller a decision, and folding the two would make every call site
 * reason about strings. "AI is switched off for this" and "this is not built yet"
 * are different sentences, and the second one must not look like a setting an
 * administrator got wrong.
 */
export function aiUnavailableReason(fn: AiFunction, config: AiConfig): string | null {
  if (!AI_FUNCTION_BUILT[fn]) return 'setup.ai.fn.not-built'
  if (!aiEnabled(fn, config)) return 'setup.ai.fn.disabled'
  return null
}

/** The functions this build can actually do work for, in declaration order. */
export const BUILT_AI_FUNCTIONS: AiFunction[] = AI_FUNCTIONS.filter((fn) => AI_FUNCTION_BUILT[fn])
