import { isSupabaseConfigured } from '../../lib/supabase'
import { hostedAiEnabled } from '../../db/aiConfig'
import { draftScenarioWithAI } from '../scenarioDraft'
import { failed, refused, result, type AiJob, type AiProvider } from './types'
import type { AiFunction } from '../../lib/aiConfig'

/**
 * Hosted API: the model call happens server-side, through an Edge Function that
 * holds the key (tl-13).
 *
 * TWO RULES THIS PROVIDER MAY NOT BREAK.
 *
 * The key never reaches the browser. Everything here goes through
 * `supabase.functions.invoke`, and there is no code path in this file that reads a
 * provider domain or an API key — which is a property the acceptance check verifies
 * by grepping the built bundle for `generativelanguage`, not by reading this comment.
 *
 * No client-side fallback. When Supabase is not configured the mode is unavailable
 * with the reason shown, and NOT degraded into a direct call that would need a key in
 * the bundle to work. If a deployment needs hosted AI without Supabase, that is a
 * hosting decision for its operator rather than something this app works around.
 *
 * The deployment switch (`hosted_ai_enabled`) is the third guard and it is Joshua's:
 * his deployment holds the Gemini key, so hosted AI stays off there and no workshop
 * administrator can spend his quota. The mode is built and tested regardless, because
 * a mode that is only written when somebody needs it is a mode nobody can evaluate.
 */
export const hostedApiProvider: AiProvider = {
  mode: 'hosted-api',

  /**
   * Only the function that has a deployed endpoint.
   *
   * `false` here is not a refusal: `runAiJob` falls back to the operator-prompt path
   * for a function this mode cannot service, and says which fallback happened. A
   * workshop that has chosen hosted AI still gets guidance drafted, by hand, with the
   * reason on screen — rather than a dead button and a mode that looks broken.
   */
  handles(fn: AiFunction): boolean {
    return fn === 'scenario_draft'
  },

  async run(job: AiJob) {
    if (!isSupabaseConfigured) return refused('setup.ai.mode.hosted-needs-backend')
    if (!hostedAiEnabled()) return refused('setup.ai.mode.hosted-not-enabled-here')
    if (job.fn !== 'scenario_draft') return refused('setup.ai.error.hosted-fn-not-built')

    const r = await draftScenarioWithAI(job.document, {
      workshopId: job.workshopId,
      scale: job.scale,
    })
    // A refusal from the server arrives here as a reason string, because the Edge
    // Function answers 403 with a body rather than throwing. It is reported as an
    // error rather than a `refused`: `refused` carries a chrome id this build wrote,
    // and this text came from the server, which is a distinction the trace should
    // keep rather than blur.
    if (!r.ok) return failed(r.reason)
    return result(r.value)
  },
}
