import { buildExportBundle, pushPendingCaptures } from '../../routing/operations'
import { canPushPull } from '../../routing/config'
import { buildScenarioPrompt } from '../scenarioDraft'
import { buildGuidancePrompt } from '../guidancePrompt'
import { failed, operatorAction, refused, type AiJob, type AiProvider } from './types'
import type { AiFunction } from '../../lib/aiConfig'

/**
 * The default mode: files exchanged through a private GitHub repo, processed by a
 * human in a Claude Max session (tl-13).
 *
 * AND THE DEFAULT IS NOT A FALLBACK. A workshop that has configured nothing behaves
 * exactly as the app did before this spec, because this provider is the mechanism
 * that was already there — `routing/operations.ts` and the copy/paste path — rather
 * than a new one written to stand in for a real provider.
 *
 * Every outcome here is `operator_action`, and that is the honest shape rather than a
 * limitation: the work happens in a human's Claude session, so the app's part ends
 * when the material is in their hands. Its stated limitation, which the UI says
 * rather than letting somebody discover it: this mode is not unattended.
 */
export const githubClaudeProvider: AiProvider = {
  mode: 'github-claude',

  handles(fn: AiFunction): boolean {
    return fn === 'observation_routing' || fn === 'scenario_draft' || fn === 'conversation_guidance'
  },

  async run(job: AiJob) {
    switch (job.fn) {
      case 'observation_routing': {
        if (job.intent === 'push') {
          if (!canPushPull()) return refused('setup.ai.error.routing-not-automated')
          try {
            const { pushed, skipped } = await pushPendingCaptures()
            return operatorAction('setup.ai.op.routing-pushed', {
              value: { pushed, skipped },
              href: '/admin/routing',
            })
          } catch (err) {
            // Fail loud to the trace (§4): the caller gets a readable message and
            // the trace records that the hand-off did not happen, rather than a
            // hand-off silently becoming a no-op.
            return failed(err instanceof Error ? err.message : 'The push to the routing repo failed.')
          }
        }
        try {
          const { json, count } = await buildExportBundle()
          return operatorAction('setup.ai.op.routing-copy', {
            value: { count },
            prompt: json,
            href: '/admin/routing',
          })
        } catch (err) {
          return failed(err instanceof Error ? err.message : 'The capture bundle could not be built.')
        }
      }

      case 'scenario_draft':
        return operatorAction('setup.ai.op.scenario-prompt', {
          prompt: buildScenarioPrompt(job.document, job.scale),
        })

      case 'conversation_guidance':
        return operatorAction('setup.ai.op.guidance-prompt', {
          prompt: buildGuidancePrompt(job.brief),
        })
    }
  },
}
