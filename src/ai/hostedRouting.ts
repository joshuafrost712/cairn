import { supabase, isSupabaseConfigured } from '../lib/supabase'
import {
  buildExportBundle,
  importObservationsText,
  OBSERVATIONS_BUNDLE_SCHEMA_ID,
} from '../routing/operations'
import { failed, refused, result, type AiOutcome } from './providers/types'

/**
 * The client half of hosted routing (tl-23): fan the pending captures out to the
 * `route-captures` Edge Function, one capture per call, and hand the assembled
 * results to the import boundary once.
 *
 * WHY ONE CAPTURE PER CALL. Every capture file is self-contained — its rubric and
 * roster ride along — so batching N captures multiplies the dominant input by N
 * and buys only fewer invocations, at the price of one wall-clock ceiling for a
 * whole day's work, one failure taking the batch with it, and a retry that
 * re-sends what already succeeded. Per-capture calls invert each of those: a
 * capture whose observations imported is no longer pending, so pressing Route now
 * again routes only what is left.
 *
 * THE FAN-OUT SHAPE: first capture alone, then the rest at bounded concurrency.
 * The first call writes the shared system prompt (the workshop's rubric) into the
 * provider's prompt cache; parallel calls with an identical prefix cannot read an
 * entry still being written, so racing all of them would pay the full prompt N
 * times. One warm-up call, then three at a time, is the shape that lets calls
 * two through N read the cache the first one wrote.
 *
 * TOKEN COUNTS ARE DELIBERATELY NOT RETURNED on the outcome. The Edge Function
 * inserts its own ai_call_log row per call with the real usage — the server is
 * where the spend is known, and a tab closed mid-fan-out must not leave money
 * unrecorded — so a client-side number here would appear beside the server's rows
 * as a second copy of the same spend, reading to an administrator as having spent
 * twice. `test/hostedRouting.test.ts` pins the nulls.
 */

/** How many captures are in flight at once, after the cache-warming first call. */
const FAN_OUT_CONCURRENCY = 3

/**
 * The client's ceiling on one call. Above the platform's own wall clock for an
 * Edge Function (150s on the free plan, 400s paid — read off Supabase's limits
 * page 2026-08-04; the Anthropic call inside is capped at 90s anyway), so the
 * server's answer (or its death) always arrives first and this only catches a
 * connection that will never produce one.
 */
const PER_CALL_TIMEOUT_MS = 160_000

/**
 * Server refusal slugs that end the whole run, mapped to this build's copy.
 * These are facts about the deployment or the workshop, not about one capture —
 * the next call would get the same answer, so continuing would only spend
 * requests to rediscover it. Slugs not in this map are per-capture failures.
 */
const RUN_ENDING_SLUGS: Record<string, string> = {
  'tl23.hosted_ai_disabled_on_this_deployment': 'setup.ai.mode.hosted-not-enabled-here',
  'tl23.daily_token_ceiling_reached': 'setup.ai.hosted.ceiling-reached',
  'tl23.model_not_callable_here': 'setup.ai.hosted.model-unreachable',
  'tl23.no_model_key': 'setup.ai.hosted.no-key',
}

interface ObservationsFileShape {
  capture_client_id: string
  observations: unknown[]
}

type CaptureResult =
  | { kind: 'file'; files: ObservationsFileShape[]; model: string | null }
  | { kind: 'fail'; reason: string }
  | { kind: 'end'; outcome: AiOutcome }

/** Route everything pending, through the server, and import what comes back. */
export async function routeCapturesHosted(workshopId: string): Promise<AiOutcome> {
  if (!isSupabaseConfigured || !supabase) return refused('setup.ai.mode.hosted-needs-backend')

  const { json } = await buildExportBundle()
  const captures = (JSON.parse(json) as { captures: unknown[] }).captures
  if (captures.length === 0) return refused('setup.ai.hosted.nothing-pending')

  const results: CaptureResult[] = []
  // First call alone: it writes the prompt cache the rest read (header note).
  results.push(await routeOne(workshopId, captures[0]))
  const first = results[0]
  if (first.kind === 'end') return first.outcome

  const rest = captures.slice(1)
  let next = 0
  let ended: AiOutcome | null = null
  const worker = async () => {
    while (next < rest.length && !ended) {
      const capture = rest[next++]
      const r = await routeOne(workshopId, capture)
      if (r.kind === 'end') {
        // A deployment-wide refusal: stop claiming new captures. In-flight calls
        // finish; their captures either land or stay pending for the retry.
        ended = r.outcome
        return
      }
      results.push(r)
    }
  }
  await Promise.all(Array.from({ length: FAN_OUT_CONCURRENCY }, worker))

  const files = results.filter((r): r is Extract<CaptureResult, { kind: 'file' }> => r.kind === 'file')
  const failures = results.filter((r): r is Extract<CaptureResult, { kind: 'fail' }> => r.kind === 'fail')

  if (files.length === 0) {
    // Nothing routed. If the run was ended by the server, that refusal is the
    // answer; otherwise the first per-capture failure is the most useful sentence.
    if (ended) return ended
    return failed(failures[0]?.reason ?? 'No captures could be routed.')
  }

  // One bundle, one pass through the import boundary — exactly the shape it
  // already accepts from every other mode, validation and roster check included.
  const bundle = JSON.stringify({
    schema: OBSERVATIONS_BUNDLE_SCHEMA_ID,
    results: files.flatMap((f) => f.files),
  })
  let imported
  try {
    imported = await importObservationsText(bundle)
  } catch (err) {
    return failed(
      err instanceof Error
        ? `The server answered, but the answers could not be imported: ${err.message}`
        : 'The server answered, but the answers could not be imported.',
    )
  }

  const failedCount = failures.length + (ended ? captures.length - results.length : 0)
  return result(
    {
      captures: captures.length,
      routed: files.length,
      failed: failedCount,
      stored: imported.stored,
      rejected: imported.rejected,
      shared: imported.shared,
    },
    {
      model: files[0].model,
      // Null on purpose — the server's ai_call_log rows carry the real numbers,
      // and two copies of one spend would read as having spent twice.
      tokensIn: null,
      tokensOut: null,
    },
  )
}

/** One capture through the Edge Function, classified for the loop above. */
async function routeOne(workshopId: string, capture: unknown): Promise<CaptureResult> {
  let data: unknown
  try {
    const res = await supabase!.functions.invoke('route-captures', {
      body: { workshop_id: workshopId, capture },
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    })
    if (res.error) return await classifyInvokeError(res.error)
    data = res.data
  } catch (err) {
    return { kind: 'fail', reason: err instanceof Error ? err.message : 'The routing call failed.' }
  }

  if (!data || typeof data !== 'object') {
    return { kind: 'fail', reason: 'The server returned an answer this build does not recognize.' }
  }
  const body = data as { observations_file?: unknown; raw?: unknown; model?: unknown }
  const model = typeof body.model === 'string' ? body.model : null

  const files = observationsFilesFrom(body.observations_file)
  if (files.length > 0) return { kind: 'file', files, model }

  // The server's tolerant extraction missed; one last attempt on the raw text.
  if (typeof body.raw === 'string') {
    try {
      const recovered = observationsFilesFrom(JSON.parse(body.raw))
      if (recovered.length > 0) return { kind: 'file', files: recovered, model }
    } catch {
      /* genuinely not JSON — fall through */
    }
    return { kind: 'fail', reason: 'The model answered, but not with observations this build can read.' }
  }
  return { kind: 'fail', reason: 'The server returned neither observations nor raw text.' }
}

/**
 * Both reply shapes the prompt can legally produce, normalized.
 *
 * The routing instructions (relayRoutingSystem's transport section) tell the model
 * to return the BUNDLE WRAPPER — `{schema, results: [...]}` — even for a single
 * capture, so the wrapper is the expected shape and a bare observations file is
 * the tolerated one, not the other way round. The first draft of this file had
 * only the bare shape and would have failed every keyed run while spending the
 * tokens; the stage-6 review caught it before a key existed to prove it.
 */
function observationsFilesFrom(x: unknown): ObservationsFileShape[] {
  if (isObservationsFile(x)) return [x]
  if (typeof x === 'object' && x !== null && Array.isArray((x as { results?: unknown }).results)) {
    return (x as { results: unknown[] }).results.filter(isObservationsFile)
  }
  return []
}

/**
 * A non-2xx from the function. supabase-js buries the body — the refusal an
 * administrator needs to read is in there, so dig it out (the same lesson
 * scenarioDraft.ts's readInvokeError records). Run-ending slugs become refusals
 * in this build's own copy; everything else is a per-capture failure carrying
 * the server's sentence.
 */
async function classifyInvokeError(error: unknown): Promise<CaptureResult> {
  const ctx = (error as { context?: unknown })?.context
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).json()) as { error?: unknown; reason?: unknown }
      const reason = typeof body.reason === 'string' ? body.reason : null
      const sentence = typeof body.error === 'string' ? body.error : null
      if (reason && RUN_ENDING_SLUGS[reason]) {
        return { kind: 'end', outcome: refused(RUN_ENDING_SLUGS[reason]) }
      }
      if (reason?.startsWith('tl13.')) {
        // Not an admin here, or the toggle is off server-side: the same answer
        // awaits every capture, so end the run with the server's own sentence.
        return { kind: 'end', outcome: failed(sentence ?? 'That call is not permitted.') }
      }
      if (sentence) return { kind: 'fail', reason: sentence }
    } catch {
      /* not JSON, or already consumed: fall through to the generic message */
    }
  }
  return {
    kind: 'fail',
    reason: error instanceof Error ? error.message : 'The routing call failed.',
  }
}

function isObservationsFile(x: unknown): x is ObservationsFileShape {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return typeof o.capture_client_id === 'string' && Array.isArray(o.observations)
}
