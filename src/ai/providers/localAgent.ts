import { getAiConfig } from '../../db/aiConfig'
import { scaleForWorkshop } from '../../db/scale'
import { buildExportBundle, importObservationsText } from '../../routing/operations'
import { buildScenarioPrompt, parseDraftReply } from '../scenarioDraft'
import { buildGuidancePrompt, validateGuidanceReply } from '../guidancePrompt'
import { modelById, modelsForMode } from '../models'
import { relayRoutingPrompt, relayRoutingSystem, relayWorkerSystem } from '../relayPrompts'
import {
  awaitRelayJob,
  buildRelayJobFile,
  markRelayCollected,
  submitRelayJob,
  type RelayFailure,
  type RelayJob,
  type RelayJobRequest,
} from '../../relay/client'
import { relayConfigured } from '../../relay/config'
import { failed, operatorAction, refused, result, type AiJob, type AiOutcome, type AiProvider } from './types'
import type { AiFunction } from '../../lib/aiConfig'

/**
 * Local agent: the workshop's own machine does the work, on a subscription that is
 * already paid for (tl-21).
 *
 * THE ONE PROPERTY NO OTHER MODE HAS. `github-claude` costs nothing per call and needs no
 * key, but it is not unattended — a person opens a Claude session and works the runbook.
 * `hosted-api` is unattended and metered. This mode is the only one that is both free at
 * the point of use and unattended, and the only one that needs no network: the model runs
 * through a CLI on the machine in the room, so an administrator on hotel wifi or on none
 * presses one button and the observations come back.
 *
 * TWO RULES THIS PROVIDER MAY NOT BREAK.
 *
 * **Returned content goes through the existing validation and nothing else.** A model on
 * a laptop is no more trusted than a model on a server: routing results go through
 * `importObservationsText` (which is `validateObservation` plus the scale check at the
 * import boundary), a scenario draft goes through `parseDraftReply`, and guidance goes
 * through `validateGuidanceReply`. There is no path in this file that writes a record the
 * copy/paste path could not have written.
 *
 * **The relay is the durable record of an in-flight job, not the app.** If the tab closes
 * mid-job the relay finishes it and holds the result; `src/relay/collect.ts` is what asks
 * for uncollected results when the screen comes back. That is why this spec needs no
 * Dexie table and no outbox entry: there is nothing here for the app to persist.
 */
export const localAgentProvider: AiProvider = {
  mode: 'local-agent',

  handles(fn: AiFunction): boolean {
    return fn === 'observation_routing' || fn === 'scenario_draft' || fn === 'conversation_guidance'
  },

  async run(job: AiJob): Promise<AiOutcome> {
    if (!relayConfigured()) return refused('setup.ai.relay.not-configured')

    /**
     * The workshop's chosen model, checked against tl-14's registry for this mode.
     *
     * A stored id this mode cannot reach is REFUSED rather than quietly ignored. Ignoring
     * it would run the CLI's own default while the Setup panel went on naming a different
     * model, which is the kind of disagreement between screen and behaviour that takes an
     * afternoon to notice.
     */
    const config = await getAiConfig(job.workshopId)
    const chosen = config.functions[job.fn]?.model ?? null
    if (chosen) {
      const entry = modelById(chosen)
      if (!entry || !entry.reachable_in.includes('local-agent')) {
        return refused('setup.ai.relay.model-unreachable')
      }
    }
    const model = chosen ?? defaultLocalModel()

    switch (job.fn) {
      case 'observation_routing':
        return routeCaptures(job.workshopId, job.intent, model)

      case 'scenario_draft': {
        const request: RelayJobRequest = {
          workshopId: job.workshopId,
          fn: 'scenario_draft',
          system: relayWorkerSystem(),
          prompt: buildScenarioPrompt(job.document, job.scale),
          model,
          expect: 'json',
        }
        return runThrough(request, (text) => {
          const parsed = parseDraftReply(text)
          return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: parsed.reason }
        })
      }

      case 'conversation_guidance': {
        const request: RelayJobRequest = {
          workshopId: job.workshopId,
          fn: 'conversation_guidance',
          system: relayWorkerSystem(),
          prompt: buildGuidancePrompt(job.brief),
          model,
          // Prose, not JSON. The runner strips a fence if the model added one, and
          // `validateGuidanceReply` rejects anything that still looks like code.
          expect: 'text',
        }
        return runThrough(request, (text) => {
          const checked = validateGuidanceReply(text)
          return checked.ok ? { ok: true, value: checked.value } : { ok: false, reason: checked.reason }
        })
      }
    }
  },
}

/**
 * The model this mode uses when the workshop has named none.
 *
 * The cheapest Claude tier the registry says is reachable here, rather than a literal:
 * the registry is where model ids live, and a hardcoded string in a provider is how the
 * app ends up asking for a model the registry has retired. Null when the registry can
 * reach nothing in this mode, which leaves the choice to the CLI's own default.
 */
function defaultLocalModel(): string | null {
  const reachable = modelsForMode('local-agent')
  const cheapest = reachable
    .slice()
    .sort((a, b) => a.input_per_mtok - b.input_per_mtok)[0]
  return cheapest?.id ?? null
}

/** How long to wait on one batch: a base plus an allowance per capture, capped. */
function routingTimeoutMs(count: number): number {
  return Math.min(15 * 60_000, 120_000 + count * 45_000)
}

async function routeCaptures(
  workshopId: string,
  intent: 'copy' | 'push' | 'run',
  model: string | null,
): Promise<AiOutcome> {
  /**
   * `push` means "write the captures to the routing repository", which is a different
   * mode's mechanism rather than a different way of doing this one. Refused for the same
   * reason `byo-agent` refuses it: a workshop that has chosen this mode has said where
   * its work happens, and quietly reaching for GitHub instead would make that choice a
   * suggestion.
   */
  if (intent === 'push') return refused('setup.ai.relay.never-pushes')

  const { json, count } = await buildExportBundle()
  if (count === 0) return refused('setup.ai.relay.nothing-pending')

  // The workshop's own scale, passed in explicitly. Every renderer in `workspace.ts`
  // carries a `DEFAULT_SCALE` fallback for callers that have none, and relying on it here
  // would hand a five-point workshop a 0-3 rubric — the same bug tl-13 fixed in the Edge
  // Function, in a file where nothing would have complained.
  const scale = await scaleForWorkshop(workshopId)
  const request: RelayJobRequest = {
    workshopId,
    fn: 'observation_routing',
    system: relayRoutingSystem(scale),
    prompt: relayRoutingPrompt(json),
    model,
    expect: 'json',
  }

  /**
   * The folder exchange, which is the floor and always works: an untested browser, a
   * locked-down profile, a phone, or Safari — which refuses a loopback request as
   * insecure content, with no prompt and no site setting to change. The administrator
   * saves this file into the relay's `in/` folder and the answer appears in `out/`,
   * which is pasted back through the existing import box. Same payload, same
   * validation, two clicks instead of none.
   */
  if (intent === 'copy') {
    return operatorAction('setup.ai.op.local-drop', {
      value: { count },
      prompt: buildRelayJobFile(request),
    })
  }

  const submitted = await submitRelayJob(request)
  if (!submitted.ok) return fromRelayFailure(submitted)

  const finished = await awaitRelayJob(submitted.id, { timeoutMs: routingTimeoutMs(count) })
  if (!finished.ok) {
    // "Still running" is not "failed": the relay has the job and the result will be
    // waiting. Saying so is the difference between an administrator waiting a minute and
    // an administrator routing the same batch twice.
    if (finished.stillRunning) return operatorAction('setup.ai.relay.still-running', { value: { count } })
    return fromRelayFailure(finished)
  }
  if (finished.job.status === 'failed') return failedJob(finished.job)

  const text = finished.job.result?.text ?? ''
  try {
    const imported = await importObservationsText(text)
    await markRelayCollected([finished.job.id])
    return result(
      { ...imported, captures: count },
      {
        model: finished.job.result?.model ?? model,
        tokensIn: finished.job.result?.tokens_in ?? null,
        tokensOut: finished.job.result?.tokens_out ?? null,
      },
    )
  } catch (err) {
    // The result stays UNCOLLECTED on purpose when the import refuses it. The relay's
    // copy is the only record of what the model actually said, and discarding it because
    // this device could not use it would leave nothing to read.
    return failed(
      err instanceof Error
        ? `The machine answered, but the answer could not be imported: ${err.message}`
        : 'The machine answered, but the answer could not be imported.',
    )
  }
}

/** Submit, wait, validate: the shape both single-shot functions share. */
async function runThrough(
  request: RelayJobRequest,
  validate: (text: string) => { ok: true; value: unknown } | { ok: false; reason: string },
): Promise<AiOutcome> {
  const submitted = await submitRelayJob(request)
  if (!submitted.ok) return fromRelayFailure(submitted)
  const finished = await awaitRelayJob(submitted.id, { timeoutMs: 5 * 60_000 })
  if (!finished.ok) {
    if (finished.stillRunning) return operatorAction('setup.ai.relay.still-running')
    return fromRelayFailure(finished)
  }
  if (finished.job.status === 'failed') return failedJob(finished.job)

  const checked = validate(finished.job.result?.text ?? '')
  await markRelayCollected([finished.job.id])
  if (!checked.ok) return failed(checked.reason)
  return result(checked.value, {
    model: finished.job.result?.model ?? request.model ?? null,
    tokensIn: finished.job.result?.tokens_in ?? null,
    tokensOut: finished.job.result?.tokens_out ?? null,
  })
}

/**
 * A transport failure as an outcome.
 *
 * `refused` carries a chrome id this build wrote, and every relay state has one — which
 * is what lets the copy for "not reachable" name both causes (nothing listening, or a
 * browser that decided not to allow it) rather than reporting a bare network error that
 * an administrator cannot act on.
 */
function fromRelayFailure(failure: RelayFailure): AiOutcome {
  return refused(failure.reasonId)
}

/** A job the machine ran and could not complete. Its own words, never a stack trace. */
function failedJob(job: RelayJob): AiOutcome {
  return failed(job.error ?? 'The machine could not complete that job.')
}
