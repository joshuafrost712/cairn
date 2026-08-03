import { getAiConfig, traceAiCall } from '../../db/aiConfig'
import { aiEnabled } from '../aiEnabled'
import { githubClaudeProvider } from './githubClaude'
import { localAgentProvider } from './localAgent'
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
import { buildExportBundle } from '../../routing/operations'
import type { AiConfig, AiMode } from '../../lib/aiConfig'

export * from './types'

/**
 * THE PROVIDERS ARE NOT RE-EXPORTED HERE, and that omission is the point.
 *
 * They were, and it made "there is no other way into a provider" false by one import:
 * `providerFor(mode).run(job)` from this barrel skips `aiEnabled` entirely, and for
 * `github-claude` there is no server-side backstop to catch it — the bypassed call is
 * `pushPendingCaptures()` writing to a private repo with the device's own token. So
 * the barrel exports the guarded entry point and the types, and nothing else.
 *
 * A test, or a future spec that genuinely needs one provider, imports it from its own
 * module (`./githubClaude`). That is a deliberate act rather than the path of least
 * resistance, which is the most a module boundary can do.
 */

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
  'local-agent': localAgentProvider,
  'byo-agent': byoAgentProvider,
  'hosted-api': hostedApiProvider,
}

/** Module-private: exported only through `runAiJob`, per the note above. */
function providerFor(mode: AiMode): AiProvider {
  return PROVIDERS[mode] ?? githubClaudeProvider
}

/**
 * The fallback for a function the selected mode has no path for.
 *
 * Deliberately NOT `byoAgentProvider.run(job)`: reusing that would trace the call as
 * though the workshop had chosen bring-your-own, and a trace that misreports the mode
 * is worse than no trace. Same prompts, its own instruction id.
 *
 * OBSERVATION ROUTING FALLS BACK TOO, and getting that wrong would have been the most
 * expensive thing in this spec. It first returned `refused` here, which contradicted
 * both this file's own comment and the shipped copy on the Routing page ("there is no
 * hosted endpoint for routing yet, so this step still hands you a prompt") — and the
 * consequence was real rather than editorial: selecting `hosted-api` is classified
 * `affects_future`, so an administrator would have chosen a mode, been told nothing
 * about it, and found the capture pipeline the whole app depends on refusing. A
 * hand-off a human can complete is the honest answer for a mode with no endpoint.
 *
 * `push` is still refused, because it is not "do this another way" but "use the
 * repository", which is a different mode's mechanism.
 */
async function fallbackOutcome(job: AiJob): Promise<AiOutcome> {
  switch (job.fn) {
    case 'scenario_draft':
      return operatorAction('setup.ai.op.fallback-prompt', {
        prompt: buildScenarioPrompt(job.document, job.scale),
      })
    case 'conversation_guidance':
      return operatorAction('setup.ai.op.fallback-prompt', { prompt: buildGuidancePrompt(job.brief) })
    case 'observation_routing': {
      if (job.intent === 'push') return refused('setup.ai.error.hosted-fn-not-built')
      // tl-21: an unattended run is the one intent a hand-off cannot stand in for, so the
      // fallback refuses it here as the two subscription modes refuse it in their own
      // files. Returning the copy bundle would report "done" for work nothing has done.
      if (job.intent === 'run') return refused('setup.ai.error.mode-not-unattended')
      try {
        const { json, count } = await buildExportBundle()
        return operatorAction('setup.ai.op.fallback-prompt', { value: { count }, prompt: json })
      } catch (err) {
        return failed(err instanceof Error ? err.message : 'The capture bundle could not be built.')
      }
    }
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

  /**
   * Record and return. FIRED, NOT AWAITED, and the distinction is the one the
   * protocol's reliability section is about: `traceAiCall` catches its own throws,
   * which covers a Dexie that refuses, and does nothing at all about a Dexie that
   * HANGS. A blocked IndexedDB upgrade — an ordinary event for an installed PWA with a
   * second tab open on the previous version — would leave `db.aiCallLog.put` pending
   * forever, and awaiting it here would mean `runAiJob` never resolves and the panel
   * stays busy with no error anywhere. Every outbound call in this spec got a timeout;
   * the one local write on the critical path gets this instead.
   */
  const finish = (outcome: AiOutcome): AiOutcome => {
    void traceAiCall({
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
  if (!provider.handles(job.fn)) return finish(await fallbackOutcome(job))

  try {
    return finish(await provider.run(job))
  } catch (err) {
    // A provider is contracted never to throw; this is the belt for when one does,
    // and it fails loud to the trace rather than swallowing.
    return finish(failed(err instanceof Error ? err.message : 'The AI request failed.'))
  }
}
