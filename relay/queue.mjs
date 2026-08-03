/**
 * The relay's queue policy, as pure functions over an array of job records (tl-21).
 *
 * WHY THIS IS SEPARATE FROM THE DISK. Every interesting decision the queue makes is
 * about time — a lease that expired, an attempt that was the last one, a completed job
 * old enough to purge — and time is exactly what a test cannot wait for. So the rules
 * live here as functions of `(jobs, now)` and `state.mjs` is the thin layer that reads
 * files, applies the patches these return, and writes them back. `test/relayQueue.test.ts`
 * drives these directly with a fabricated clock.
 *
 * A job record, as it sits on disk:
 *
 *   {
 *     id, workshop_id, fn, transport: 'http' | 'drop',
 *     status: 'queued' | 'leased' | 'done' | 'failed',
 *     attempts, lease_until, created_at, updated_at, finished_at, collected_at,
 *     payload: { prompt, system, model },   // opaque to the relay
 *     result: { text, model, tokens_in, tokens_out, metered_equivalent_usd, duration_ms } | null,
 *     result_raw: string | null,            // the model's untrimmed reply, kept on failure
 *     error: string | null
 *   }
 *
 * `payload` and `result_raw` hold participant evidence. Nothing in this file puts
 * either of them into a summary, and `summarize()` is what the health endpoint and the
 * log line are built from.
 */

/**
 * How long a claimed job stays claimed before another dispatcher may take it.
 *
 * MUST EXCEED THE RUNNER'S OWN TIMEOUT, and by a margin. A lease shorter than a job's
 * wall-clock allowance would let the queue reap a job that is still running, hand it to a
 * second worker, and bill a subscription twice for one batch. The runner's default is ten
 * minutes; this is twenty.
 */
export const DEFAULT_LEASE_MS = 20 * 60_000

/** How many times a job may be attempted before it is failed for good. */
export const MAX_ATTEMPTS = 3

/** Completed jobs hold evidence, so they are purged on a short clock. */
export const DONE_TTL_MS = 24 * 60 * 60_000

/** Failed ones are kept longer, because a failure nobody has read yet is the one worth reading. */
export const FAILED_TTL_MS = 7 * 24 * 60 * 60_000

const iso = (ms) => new Date(ms).toISOString()

/** A job whose claim has run out. Includes a leased job with no expiry, which is a bug's residue. */
export function isLeaseExpired(job, now) {
  if (job.status !== 'leased') return false
  if (!job.lease_until) return true
  return Date.parse(job.lease_until) <= now
}

/**
 * The patches that return expired-lease jobs to the queue, or fail them if they have
 * used up their attempts.
 *
 * THE ATTEMPT IS COUNTED AT CLAIM TIME, not here, so a dispatcher that dies without
 * writing anything still costs the job one attempt. That is deliberate: the alternative
 * counts nothing for a crash, and a job that reliably crashes the runner would be
 * retried forever.
 */
export function reapExpired(jobs, now, maxAttempts = MAX_ATTEMPTS) {
  return jobs.filter((job) => isLeaseExpired(job, now)).map((job) => ({
    id: job.id,
    patch:
      job.attempts >= maxAttempts
        ? {
            status: 'failed',
            error: `Abandoned after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}: the lease expired with no result.`,
            finished_at: iso(now),
            lease_until: null,
            updated_at: iso(now),
          }
        : { status: 'queued', lease_until: null, updated_at: iso(now) },
  }))
}

/** The next job to run: oldest queued first, so a batch keeps its order. */
export function pickNext(jobs, now) {
  const queued = jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  void now
  return queued[0] ?? null
}

/** What claiming a job writes. */
export function leasePatch(job, now, leaseMs = DEFAULT_LEASE_MS) {
  return {
    status: 'leased',
    attempts: (job.attempts ?? 0) + 1,
    lease_until: iso(now + leaseMs),
    updated_at: iso(now),
  }
}

/**
 * What a finished-well job writes. `result_raw` is dropped on success: the extracted
 * value is the thing anything downstream uses, and keeping a second copy of the
 * evidence around for no reader is the opposite of the retention rule.
 */
export function completePatch(now, result) {
  return {
    status: 'done',
    result,
    result_raw: null,
    error: null,
    lease_until: null,
    finished_at: iso(now),
    updated_at: iso(now),
  }
}

/**
 * What a failure writes, and whether the job lives to try again.
 *
 * `retryable: false` fails the job immediately whatever its attempt count. A prompt
 * the model cannot answer, a payload the runner refuses as too large and an
 * unauthenticated CLI are all permanently unsatisfiable, and retrying them twice more
 * only delays the honest answer. This is the reliability protocol's "never retry a
 * non-transient error at all", applied where the queue can see it.
 */
export function failurePatch(job, now, reason, { retryable = true, raw = null, maxAttempts = MAX_ATTEMPTS } = {}) {
  const spent = (job.attempts ?? 0) >= maxAttempts
  const done = !retryable || spent
  return {
    status: done ? 'failed' : 'queued',
    error: reason,
    result_raw: raw,
    lease_until: null,
    ...(done ? { finished_at: iso(now) } : {}),
    updated_at: iso(now),
  }
}

/** Marking collected is what makes the result the app's rather than the relay's. */
export function collectPatch(now) {
  return { collected_at: iso(now), updated_at: iso(now) }
}

/** The finished jobs a workshop has not collected yet, oldest first. */
export function uncollected(jobs, workshopId) {
  return jobs
    .filter((j) => (j.status === 'done' || j.status === 'failed') && !j.collected_at)
    .filter((j) => !workshopId || j.workshop_id === workshopId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

/**
 * Which job files should be deleted now.
 *
 * Age is measured from `finished_at` rather than from collection, so an uncollected
 * result is purged on the same clock as a collected one. That loses work in one case —
 * an administrator who routes a batch and does not come back for a day — and it is the
 * right trade: the alternative keeps participant evidence on a laptop indefinitely
 * because nobody pressed a button, and the captures themselves are still in the app,
 * so the recovery is to route them again.
 */
export function purgeIds(jobs, now, { doneTtlMs = DONE_TTL_MS, failedTtlMs = FAILED_TTL_MS } = {}) {
  return jobs
    .filter((j) => j.status === 'done' || j.status === 'failed')
    .filter((j) => {
      const at = Date.parse(j.finished_at ?? j.updated_at ?? j.created_at ?? '')
      if (!Number.isFinite(at)) return false
      const ttl = j.status === 'done' ? doneTtlMs : failedTtlMs
      return now - at >= ttl
    })
    .map((j) => j.id)
}

/**
 * The queue as a health report. EVIDENCE-FREE BY CONSTRUCTION: this function names the
 * fields it copies rather than spreading a job, so a field added to the record later
 * cannot leak into the endpoint or the log by default.
 */
export function summarize(jobs) {
  const counts = { queued: 0, leased: 0, done: 0, failed: 0 }
  for (const j of jobs) if (j.status in counts) counts[j.status]++
  const finished = jobs
    .filter((j) => j.finished_at)
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))
  const last = finished[0]
  return {
    counts,
    uncollected: jobs.filter((j) => (j.status === 'done' || j.status === 'failed') && !j.collected_at).length,
    last: last
      ? {
          id: last.id,
          fn: last.fn,
          status: last.status,
          at: last.finished_at,
          attempts: last.attempts ?? 0,
          model: last.result?.model ?? last.payload?.model ?? null,
          tokens_in: last.result?.tokens_in ?? null,
          tokens_out: last.result?.tokens_out ?? null,
          duration_ms: last.result?.duration_ms ?? null,
          error: last.error ?? null,
        }
      : null,
  }
}
