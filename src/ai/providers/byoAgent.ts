import { instructionFor } from '../../db/templates'
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
 * tl-15's brief pack is NOT here, and the omission is the design. `pack` is a fourth
 * `observation_routing` intent — the same captures under the same contract, handed over as a
 * folder instead of as a prompt — and `runAiJob` serves it centrally, before any provider is
 * chosen, because it is the one intent that does not depend on the mode: it moves the work
 * rather than doing it, so it calls no model, holds no credential and touches no network.
 * `ProviderJob` excludes the intent from this signature, so this file cannot receive it even
 * by accident. See the note above `runAiJob` in ./index.ts for what that buys.
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
          prompt: buildScenarioPrompt(job.document, job.scale, await instructionFor(job.workshopId, 'instructions.scenario_draft')),
        })

      case 'conversation_guidance':
        return operatorAction('setup.ai.op.byo-guidance', { prompt: buildGuidancePrompt(job.brief, await instructionFor(job.workshopId, 'instructions.conversation_guidance')) })
    }
  },
}
