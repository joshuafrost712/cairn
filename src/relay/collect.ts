/**
 * Picking up work the machine finished while nobody was looking (tl-21).
 *
 * THE RELAY IS THE DURABLE RECORD OF AN IN-FLIGHT JOB, NOT THE APP. That sentence is the
 * whole reason this file exists and the reason this spec needs no Dexie table: if the tab
 * closes mid-batch, the laptop lid shuts, or a batch simply takes longer than the poll
 * window, the relay finishes the job and holds the result until it is collected. The
 * screen that asked for the work asks for it again when it comes back.
 *
 * Without this, the failure is quiet and expensive: an administrator whose tab reloaded
 * would see nothing, route the same captures again, and spend a second batch of the
 * subscription's tokens on work that was already done.
 */

import { traceAiCall } from '../db/aiConfig'
import { importObservationsText } from '../routing/operations'
import { collectRelayResults, markRelayCollected, type RelayJob } from './client'
import { relayConfigured } from './config'

export interface RelayDrain {
  /** Routing results imported through the normal validation path. */
  files: number
  stored: number
  rejected: number
  shared: number
  /** Jobs the machine could not complete, with the first reason to show. */
  failed: number
  firstError: string | null
  /**
   * Results for a function whose screen is gone (a scenario draft, a piece of guidance).
   *
   * COUNTED AND NAMED RATHER THAN DROPPED SILENTLY. A draft is only meaningful in the
   * panel that asked for it, so there is nowhere to put it — but "two results were
   * discarded because the screen that asked for them is gone" is a true sentence an
   * administrator can act on, and a silent zero is not.
   */
  discarded: number
}

const EMPTY: RelayDrain = { files: 0, stored: 0, rejected: 0, shared: 0, failed: 0, firstError: null, discarded: 0 }

/**
 * Collect and import everything waiting for this workshop.
 *
 * Never throws: a drain that runs on a screen opening must not be able to break that
 * screen. A relay that is not configured or not reachable returns the empty drain, which
 * reads as "nothing was waiting" — correct, because from this device's point of view
 * nothing is.
 */
export async function drainRelayResults(workshopId: string | null): Promise<RelayDrain> {
  if (!relayConfigured() || !workshopId) return EMPTY
  const res = await collectRelayResults(workshopId)
  if (!res.ok) return EMPTY

  const out: RelayDrain = { ...EMPTY }
  const collected: string[] = []

  for (const job of res.jobs) {
    if (job.fn !== 'observation_routing') {
      out.discarded++
      collected.push(job.id)
      continue
    }
    if (job.status === 'failed' || !job.result?.text) {
      out.failed++
      out.firstError = out.firstError ?? job.error ?? 'The machine could not complete that job.'
      collected.push(job.id)
      continue
    }
    try {
      const imported = await importObservationsText(job.result.text)
      out.files += imported.files
      out.stored += imported.stored
      out.rejected += imported.rejected
      out.shared += imported.shared
      collected.push(job.id)
      trace(workshopId, job, 'result', null)
    } catch (err) {
      // Left UNCOLLECTED deliberately: the relay's copy is the only record of what the
      // model said, and this device could not use it. Purging is on a clock, so it will
      // not sit there forever, and until then it can be read on disk.
      out.failed++
      out.firstError = out.firstError ?? (err instanceof Error ? err.message : 'That result could not be imported.')
      trace(workshopId, job, 'error', err instanceof Error ? err.message : 'import failed')
    }
  }

  await markRelayCollected(collected)
  return out
}

/**
 * A collected result is a second event worth tracing.
 *
 * The call was already traced when it was submitted — as `operator_action` with "still
 * running", which is what was true at that moment. This is the row that says the work
 * actually landed, and it carries the token counts, which is what tl-14's calibration
 * against real spend needs.
 */
function trace(workshopId: string, job: RelayJob, outcome: 'result' | 'error', detail: string | null): void {
  void traceAiCall({
    workshop_id: workshopId,
    fn: 'observation_routing',
    mode: 'local-agent',
    model: job.result?.model ?? null,
    actor_email: null,
    input_chars: null,
    outcome,
    detail: detail ?? 'setup.ai.relay.collected',
    tokens_in: job.result?.tokens_in ?? null,
    tokens_out: job.result?.tokens_out ?? null,
    latency_ms: job.result?.duration_ms ?? null,
  })
}
