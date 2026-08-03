import { getAiConfig, traceAiCall } from '../../db/aiConfig'
import { aiEnabled } from '../aiEnabled'
import { githubClaudeProvider } from './githubClaude'
import { byoAgentProvider } from './byoAgent'
import { hostedApiProvider } from './hostedApi'
import {
  failed,
  jobInputChars,
  MAX_AI_INPUT_CHARS,
  operatorAction,
  refused,
  type AiJob,
  type AiOutcome,
  type AiProvider,
} from './types'
import { buildScenarioPrompt } from '../scenarioDraft'
import { buildGuidancePrompt } from '../guidancePrompt'
import type { AiConfig, AiMode } from '../../lib/aiConfig'

export * from './types'
export { githubClaudeProvider } from './githubClaude'
export { byoAgentProvider } from './byoAgent'
export { hostedApiProvider } from './hostedApi'

/**
 * THE PROVIDER ENTRY POINT (tl-13). One way in, for every AI function, in every mode.
 *
 * Four things happen here and nowhere else, which is what makes them impossible to
 * forget rather than merely documented:
 *
 *   1. **The toggle is checked**, by `aiEnabled`, before any provider is chosen. The
 *      spec's wording is that a toggle must gate the CALL rather than the button, and
 *      a check inside the entry point cannot be bypassed by construction: there is no
 *      other function that reaches a provider. (The permission itself is server-side,
 *      in `ai_call_permitted()`; this is the client's copy of the decision, and both
 *      are needed for the reason the protocol's §5 gives.)
 *   2. **The input is capped**, because captures are dictated free text and uploaded
 *      documents are arbitrary files. Rejected with a sentence, never truncated into
 *      a request that half-works.
 *   3. **Every call is traced** — function, mode, model, input size, outcome, latency
 *      — including the operator-action outcomes, which are the normal state of two of
 *      the three modes and the ones a log that only recorded model calls would
 *      silently omit.
 *   4. **A function its mode cannot service falls back once, and says so.** Hosted AI
 *      has one endpoint today; a workshop on that mode asking for guidance gets the
 *      operator-prompt path with a chrome id naming why, rather than a dead control.
 */
const PROVIDERS: Record<AiMode, AiProvider> = {
  'github-claude': githubClaudeProvider,
  'byo-agent': byoAgentProvider,
  'hosted-api': hostedApiProvider,
}

export function providerFor(mode: AiMode): AiProvider {
  return PROVIDERS[mode] ?? githubClaudeProvider
}

/**
 * The fallback for a function the selected mode has no path for.
 *
 * Deliberately NOT `byoAgentProvider.run(job)`: reusing that would trace the call as
 * though the workshop had chosen bring-your-own, and a trace that misreports the mode
 * is worse than no trace. Same prompts, its own instruction id.
 */
function fallbackOutcome(job: AiJob): AiOutcome {
  switch (job.fn) {
    case 'scenario_draft':
      return operatorAction('setup.ai.op.fallback-prompt', {
        prompt: buildScenarioPrompt(job.document, job.scale),
      })
    case 'conversation_guidance':
      return operatorAction('setup.ai.op.fallback-prompt', { prompt: buildGuidancePrompt(job.brief) })
    case 'observation_routing':
      return refused('setup.ai.error.hosted-fn-not-built')
  }
}

export interface RunAiJobOptions {
  /** Pass a config already in hand to save a Dexie read; otherwise it is resolved. */
  config?: AiConfig
}

/** Run one AI job. Never throws: everything comes back as an outcome. */
export async function runAiJob(job: AiJob, options: RunAiJobOptions = {}): Promise<AiOutcome> {
  const config = options.config ?? (await getAiConfig(job.workshopId))
  const inputChars = jobInputChars(job)
  const started = Date.now()

  const finish = async (outcome: AiOutcome): Promise<AiOutcome> => {
    await traceAiCall({
      workshop_id: job.workshopId,
      fn: job.fn,
      mode: config.mode,
      model: outcome.model ?? config.functions[job.fn]?.model ?? null,
      actor_email: job.actorEmail ?? null,
      input_chars: inputChars || null,
      outcome: outcome.kind,
      detail: outcome.reason ?? outcome.instructionsId ?? null,
      tokens_in: outcome.tokensIn ?? null,
      tokens_out: outcome.tokensOut ?? null,
      latency_ms: Date.now() - started,
    })
    return outcome
  }

  if (!aiEnabled(job.fn, config)) {
    // The trace records the refusal too. "Somebody tried to use a function this
    // workshop has switched off" is exactly the kind of thing an administrator
    // wondering why nothing is happening needs to be able to see.
    return finish(refused('setup.ai.fn.disabled'))
  }

  if (inputChars > MAX_AI_INPUT_CHARS) {
    return finish(refused('setup.ai.error.input-too-large'))
  }

  const provider = providerFor(config.mode)
  if (!provider.handles(job.fn)) return finish(fallbackOutcome(job))

  try {
    return finish(await provider.run(job))
  } catch (err) {
    // A provider is contracted never to throw; this is the belt for when one does,
    // and it fails loud to the trace rather than swallowing.
    return finish(failed(err instanceof Error ? err.message : 'The AI request failed.'))
  }
}
