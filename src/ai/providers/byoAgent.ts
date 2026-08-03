import { buildExportBundle } from '../../routing/operations'
import { buildScenarioPrompt } from '../scenarioDraft'
import { buildGuidancePrompt } from '../guidancePrompt'
import { failed, operatorAction, refused, type AiJob, type AiProvider } from './types'
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
 * tl-15 builds the full brief pack. What exists here is the same prompt the
 * copy/paste path already produces, which is the honest minimum: a mode that
 * pretended to have a richer brief than it does would be worse than one that says
 * what it has.
 */
export const byoAgentProvider: AiProvider = {
  mode: 'byo-agent',

  handles(fn: AiFunction): boolean {
    return fn === 'observation_routing' || fn === 'scenario_draft' || fn === 'conversation_guidance'
  },

  async run(job: AiJob) {
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
