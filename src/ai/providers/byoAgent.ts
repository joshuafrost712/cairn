import { buildExportBundle } from '../../routing/operations'
import { buildScenarioPrompt } from '../scenarioDraft'
import { buildGuidancePrompt } from '../guidancePrompt'
import { failed, operatorAction, refused, type AiProvider, type ProviderJob } from './types'
import type { AiFunction } from '../../lib/aiConfig'

/**
 * Bring-your-own agent: the operator points their own subscription — Claude, a GPT
 * plan, Codex, whatever they have — at an exported brief and pastes the result back
 * (tl-13).
 *
 * ONE THING DISTINGUISHES THIS FROM github-claude, and it is not the prompt text.
 * Nothing leaves the app automatically in this mode: there is no repository, no
 * token, and no outbound request of any kind. The operator's own tool does the work,
 * on material they carried there themselves. That is the whole point of the mode for
 * an organization whose answer to "where does our evidence go" has to be "nowhere we
 * did not carry it", so `intent: 'push'` is REFUSED here rather than quietly falling
 * back to the repo.
 *
 * tl-15 IS the brief pack, and it arrives here as a fourth `observation_routing`
 * intent rather than as a function of its own: `pack` is the same captures under the
 * same contract, handed over as a folder instead of as a prompt. Routing it through
 * the intent keeps it behind `runAiJob`'s toggle check and inside the trace, which a
 * download button wired straight to `buildBriefPack` would not be.
 *
 * THE PACK IS AVAILABLE IN EVERY MODE, NOT ONLY THIS ONE, and that is deliberate. An
 * administrator on `github-claude` who happens to have Codex in front of them should not
 * have to change their workshop's provider setting to use it once; `fallbackOutcome` in
 * ./index.ts serves the same pack with its own instruction id, so the trace says which
 * mode it actually happened in.
 */
export const byoAgentProvider: AiProvider = {
  mode: 'byo-agent',

  handles(fn: AiFunction): boolean {
    return fn === 'observation_routing' || fn === 'scenario_draft' || fn === 'conversation_guidance'
  },

  async run(job: ProviderJob) {
    switch (job.fn) {
      case 'observation_routing': {
        if (job.intent === 'push') return refused('setup.ai.error.byo-never-pushes')
        // tl-21: unattended routing belongs to the mode that has a machine to do it.
        if (job.intent === 'run') return refused('setup.ai.error.mode-not-unattended')
        try {
          const { json, count } = await buildExportBundle()
          return operatorAction('setup.ai.op.byo-routing', { value: { count }, prompt: json })
        } catch (err) {
          return failed(err instanceof Error ? err.message : 'The capture bundle could not be built.')
        }
      }

      case 'scenario_draft':
        return operatorAction('setup.ai.op.byo-scenario', {
          prompt: buildScenarioPrompt(job.document, job.scale),
        })

      case 'conversation_guidance':
        return operatorAction('setup.ai.op.byo-guidance', { prompt: buildGuidancePrompt(job.brief) })
    }
  },
}
