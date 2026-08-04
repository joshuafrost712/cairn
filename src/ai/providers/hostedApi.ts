import { isSupabaseConfigured } from '../../lib/supabase'
import { getAiConfig, hostedAiEnabled } from '../../db/aiConfig'
import { buildExportBundle } from '../../routing/operations'
import { draftScenarioWithAI } from '../scenarioDraft'
import { routeCapturesHosted } from '../hostedRouting'
import { modelById } from '../models'
import { failed, operatorAction, refused, result, type ProviderJob, type AiOutcome, type AiProvider } from './types'
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
   * The functions that have deployed endpoints: scenario drafting (tl-13, Gemini)
   * and observation routing (tl-23, Anthropic).
   *
   * `false` here is not a refusal: `runAiJob` falls back to the operator-prompt path
   * for a function this mode cannot service, and says which fallback happened. A
   * workshop that has chosen hosted AI still gets guidance drafted, by hand, with the
   * reason on screen — rather than a dead button and a mode that looks broken.
   */
  handles(fn: AiFunction): boolean {
    return fn === 'scenario_draft' || fn === 'observation_routing'
  },

  async run(job: ProviderJob): Promise<AiOutcome> {
    // The three guards, in order: a backend to call, the deployment's permission
    // to spend, then the workshop's toggle — which `runAiJob` has already checked
    // before any provider is chosen.
    if (!isSupabaseConfigured) return refused('setup.ai.mode.hosted-needs-backend')
    if (!hostedAiEnabled()) return refused('setup.ai.mode.hosted-not-enabled-here')

    switch (job.fn) {
      case 'observation_routing':
        return routeThroughServer(job.workshopId, job.intent)

      case 'scenario_draft': {
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
        // The model and the token counts travel with the outcome, so the trace records
        // what was actually spent rather than a null and a zero. On the DRAFTING path
        // the client is the only writer of these numbers; on the routing path the Edge
        // Function writes its own rows and the client stays silent (see hostedRouting.ts).
        return result(r.value, {
          model: r.model ?? null,
          tokensIn: r.tokensIn ?? null,
          tokensOut: r.tokensOut ?? null,
        })
      }

      default:
        return refused('setup.ai.error.hosted-fn-not-built')
    }
  },
}

/**
 * The routing branch (tl-23). Three intents, three different answers:
 *
 *   `push`  — refused. Pushing is "use the routing repository", a different mode's
 *             mechanism, not another way of doing this one.
 *   `copy`  — the existing bundle for a human, the same operatorAction shape the
 *             fallback uses. A mode being able to route on the server does not
 *             take away the hand-off an administrator may still want.
 *   `run`   — the fan-out through the Edge Function.
 */
async function routeThroughServer(
  workshopId: string,
  intent: 'copy' | 'push' | 'run',
): Promise<AiOutcome> {
  if (intent === 'push') return refused('setup.ai.hosted.never-pushes')

  // The hand-off calls no model, so the model check below must not gate it: a
  // workshop whose stored routing model is Gemini (the registry's own unit-cost
  // recommendation for routing) still gets its bundle for a human. The stage-6
  // review caught the check sitting above this branch.
  if (intent === 'copy') {
    const { json, count } = await buildExportBundle()
    return operatorAction('setup.ai.op.fallback-prompt', { value: { count }, prompt: json })
  }

  /**
   * The workshop's chosen model, checked against tl-14's registry — the same
   * refusal shape localAgentProvider uses, and for the same reason: a stored id
   * this path cannot reach must be refused rather than silently replaced by a
   * default while the Setup panel goes on naming something else. The server's
   * allowlist (in _shared/anthropic.ts, mirrored to the registry by a test) is
   * the authoritative gate; this is the copy that fails before spending a call.
   * The endpoint calls Anthropic models only, so a Gemini id — reachable in this
   * MODE for scenario drafting — is unreachable for ROUTING.
   */
  const config = await getAiConfig(workshopId)
  const chosen = config.functions.observation_routing?.model ?? null
  if (chosen) {
    const entry = modelById(chosen)
    if (!entry || entry.provider !== 'anthropic' || !entry.reachable_in.includes('hosted-api')) {
      return refused('setup.ai.hosted.model-unreachable')
    }
  }

  return routeCapturesHosted(workshopId)
}
