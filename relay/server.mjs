#!/usr/bin/env node
/**
 * The workshop's AI machine: one small service, no dependencies (tl-21).
 *
 * Three jobs and no others: hold a queue, hand jobs to a runner, hold results until the
 * app collects them. It knows nothing about workshops, participants, evaluations or
 * Supabase. Every payload it receives is opaque to it except the envelope fields it
 * routes and logs on, which is what lets tl-22 pool a second machine's subscription
 * against the same queue without this file learning anything new.
 *
 * IT BINDS TO LOOPBACK. Reaching it from another machine is out of scope by design and
 * is tl-22's decision to argue with its own security section.
 *
 * ON THE CORS HEADERS. The deployed HTTPS app reaches a service on 127.0.0.1 in real
 * Chrome with no permission and no prompt — measured in Joshua's own Chrome 150 on
 * 2026-08-03, including the preflighted shape this relay actually receives (an
 * `Authorization: Bearer` header forces the preflight). Headless Chromium refuses the
 * same request with "Permission was denied for this", which is a harness artifact and
 * not the browser's behaviour: a permission auto-denied in headless is not evidence
 * that a real browser asks. Chrome's local-network work is mid-rollout, so the four
 * headers below are all sent — they cost nothing, and which of them were load-bearing
 * was never isolated. Safari refuses outright as insecure content, with no prompt and
 * no setting, so Chrome is a requirement of this feature rather than a preference.
 *
 * Usage: `npm run relay` (add `-- --port 8792` to move it).
 */

import { createServer } from 'node:http'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  annotate,
  complete,
  claimNext,
  dropDoneDir,
  dropInDir,
  dropOutDir,
  enqueue,
  ensureState,
  fail,
  isJobId,
  listUncollected,
  loadOrCreateToken,
  logLine,
  markCollected,
  purge,
  readJob,
  readThrottle,
  relayHome,
  release,
  stats,
  writeThrottle,
} from './state.mjs'
import { probeRunner, runClaudeJob, DEFAULT_TIMEOUT_MS } from './runner-claude.mjs'
import { DEFAULT_LEASE_MS } from './queue.mjs'

export const RELAY_VERSION = '1.0.0'

const DEFAULTS = {
  port: Number(process.env.HONEST_EVAL_RELAY_PORT || 8791),
  host: '127.0.0.1',
  /** One at a time. A subscription is one queue; pooling several is tl-22. */
  concurrency: 1,
  tickMs: 1_000,
  dropPollMs: 2_000,
  purgeEveryMs: 5 * 60_000,
  jobTimeoutMs: Number(process.env.HONEST_EVAL_RELAY_JOB_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
}

/** What a request may carry. A prompt beyond this is refused rather than truncated. */
const MAX_PROMPT_CHARS = 400_000
const MAX_SYSTEM_CHARS = 200_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--host') out.host = String(argv[++i])
    else if (arg === '--job-timeout-ms') out.jobTimeoutMs = Number(argv[++i])
  }
  return out
}

// ---- HTTP plumbing ---------------------------------------------------------

/**
 * Any origin is reflected, and the bearer token is what actually guards the service.
 *
 * Said out loud because a reflected `Access-Control-Allow-Origin` reads like a hole. It is
 * not one here, for two reasons that must both stay true: every worker route requires the
 * token, and the app sends `credentials: 'omit'` (see `src/relay/client.ts`), so there is no
 * ambient cookie a random tab could ride. The token itself lives in that origin's
 * localStorage, which another origin cannot read. A tab on any site can therefore reach
 * this port and get a 401, which is the intended answer.
 *
 * What would break the reasoning: adding a route that acts without checking the token, or
 * ever answering with `Access-Control-Allow-Credentials`. Raised as a nit by the pre-merge
 * review on 2026-08-03 on the grounds that the reasoning existed only in someone's head.
 */
function corsHeaders(req) {
  const origin = req.headers.origin
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

function send(req, res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  })
  res.end(text)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Constant-time-ish comparison. The token is a local secret rather than a password, but
 * a length-leaking `===` in the one authorization check in the file is not worth
 * keeping just because the threat is small.
 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

function bearer(req) {
  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(header))
  return match ? match[1].trim() : null
}

/** The wire shape of a job: everything except the prompt it was given. */
function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    workshop_id: job.workshop_id,
    fn: job.fn,
    status: job.status,
    attempts: job.attempts,
    transport: job.transport,
    created_at: job.created_at,
    finished_at: job.finished_at,
    collected_at: job.collected_at,
    result: job.result,
    error: job.error,
    /**
     * The raw reply, on failure only and bounded.
     *
     * The app already holds the evidence this came from, so showing it back is not a
     * disclosure; and "the reply was not JSON" with no way to see the reply is the
     * shape of failure an administrator cannot act on.
     */
    raw_excerpt: job.status === 'failed' && job.result_raw ? String(job.result_raw).slice(0, 2_000) : null,
  }
}

// ---- the dispatcher --------------------------------------------------------

/**
 * The margin the lease must keep over the runner's timeout.
 *
 * Not zero, because the reap and the runner's own clock are different clocks: a job that
 * times out at exactly the lease boundary would be reaped in the same instant it fails,
 * and which write lands first would decide the record.
 */
export const LEASE_MARGIN_MS = 60_000

/**
 * The invariant `queue.mjs` documents and nothing used to check.
 *
 * `jobTimeoutMs` is operator-settable (`--job-timeout-ms`, or the env var in DEFAULTS)
 * and `DEFAULT_LEASE_MS` is a compile-time constant, so an operator lengthening the
 * timeout for a big batch could put the runner's allowance ABOVE the lease. The queue's
 * whole double-spend argument rests on the opposite. What happens then is not a clean
 * failure either: at 20 minutes the reap returns the job to `queued` while the runner is
 * still working, and when it finishes `complete()` writes `done` over that, so the record
 * disagrees with itself. `concurrency: 1` is what stops it also being billed twice today,
 * which means the guard matters most for the case tl-22 exists to add. Refusing to boot is
 * right: an unbootable relay is noticed in the first minute at a workshop, and a
 * silently-wrong lease is noticed never. Found by this spec's pre-merge review, 2026-08-03.
 */
export function assertLeaseCoversTimeout(jobTimeoutMs, leaseMs = DEFAULT_LEASE_MS) {
  if (!Number.isFinite(jobTimeoutMs) || jobTimeoutMs <= 0) {
    throw new Error(`Job timeout must be a positive number of milliseconds; got ${jobTimeoutMs}.`)
  }
  if (jobTimeoutMs + LEASE_MARGIN_MS > leaseMs) {
    throw new Error(
      `Job timeout ${jobTimeoutMs}ms leaves no margin under the ${leaseMs}ms lease. ` +
        `A runner allowed to outlive its lease can have its job reaped and handed out again. ` +
        `Lower --job-timeout-ms to at most ${leaseMs - LEASE_MARGIN_MS}ms, or raise DEFAULT_LEASE_MS in queue.mjs.`,
    )
  }
}

export function createRelay(options = {}) {
  const config = { ...DEFAULTS, ...options }
  assertLeaseCoversTimeout(config.jobTimeoutMs)
  let token = null
  let inFlight = 0
  let throttle = null
  let stopping = false
  let leased = new Set()
  let runnerCache = { at: 0, value: { available: false, reason: 'not checked yet', version: null } }
  /**
   * A worker fault the version probe cannot see, and the harness is what found it.
   *
   * `claude --version` SUCCEEDS on a machine where nobody has signed in. So a relay that
   * answered "worker available" from the probe alone would report itself ready while every
   * job failed with an authentication error — which is precisely the state the Test
   * button's "reachable and healthy but no worker" answer exists to name. It is sticky
   * rather than cached: once a job has failed for a reason no probe can detect, health
   * says so until a job actually succeeds.
   */
  let runnerFault = null

  const runner = async () => {
    if (runnerFault) return { available: false, reason: runnerFault, version: runnerCache.value?.version ?? null }
    if (Date.now() - runnerCache.at < 60_000) return runnerCache.value
    runnerCache = { at: Date.now(), value: await probeRunner() }
    return runnerCache.value
  }

  const throttleState = () => {
    if (throttle?.until && Date.parse(throttle.until) <= Date.now()) throttle = null
    return throttle
  }

  async function runOne() {
    if (stopping || inFlight >= config.concurrency || throttleState()) return
    const job = await claimNext()
    if (!job) return
    inFlight++
    leased.add(job.id)
    await logLine('job.claimed', { id: job.id, fn: job.fn, attempt: job.attempts })
    try {
      const outcome = await runClaudeJob(job, { timeoutMs: config.jobTimeoutMs })
      if (outcome.ok) {
        await complete(job.id, outcome.result)
        await logLine('job.done', {
          id: job.id,
          fn: job.fn,
          tokens_in: outcome.result.tokens_in,
          tokens_out: outcome.result.tokens_out,
          ms: outcome.result.duration_ms,
          denials: outcome.result.permission_denials,
        })
        // A job that worked is the only evidence that clears either fault.
        runnerFault = null
        if (throttle) {
          throttle = null
          await writeThrottle(null)
        }
      } else {
        if (outcome.throttle) {
          throttle = { until: outcome.throttle.until ?? null, message: outcome.throttle.message ?? null, at: new Date().toISOString() }
          await writeThrottle(throttle)
          await logLine('relay.throttled', { until: throttle.until ?? 'unknown' })
        }
        if (outcome.unauthenticated || outcome.runnerMissing) runnerFault = outcome.reason
        await fail(job.id, outcome.reason, { retryable: outcome.retryable !== false, raw: outcome.raw ?? null })
        await logLine('job.failed', { id: job.id, fn: job.fn, retryable: outcome.retryable !== false })
      }
    } catch (err) {
      // A runner is contracted never to throw; this is the belt, and it fails loud to
      // the log rather than losing the job to a leased state nobody reaps for ten
      // minutes.
      await fail(job.id, `The worker crashed: ${err.message}`, { retryable: true })
      await logLine('job.crashed', { id: job.id })
    } finally {
      leased.delete(job.id)
      inFlight--
    }
  }

  // ---- the folder exchange ------------------------------------------------
  //
  // THE FLOOR, AND IT IS NOT A CONSOLATION PRIZE. It is the only version of this that
  // certainly works at the workshop — an untested browser, a locked-down profile, a
  // phone, Safari — and it still removes the thing this spec exists to remove: nobody
  // sits in a Claude session running the runbook by hand. Same payloads, same
  // validation, two clicks instead of none.
  async function scanDrop() {
    if (stopping) return
    let names = []
    try {
      names = await readdir(dropInDir())
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const from = join(dropInDir(), name)
      try {
        const request = JSON.parse(await readFile(from, 'utf8'))
        const checked = validateJobRequest(request)
        if (!checked.ok) {
          await writeFile(join(dropOutDir(), `${name}.error.json`), JSON.stringify({ error: checked.reason }, null, 2))
        } else {
          const job = await enqueue({ ...checked.value, transport: 'drop' })
          await annotate(job.id, { drop_name: name })
          await logLine('drop.queued', { id: job.id, fn: job.fn, file: name })
        }
      } catch (err) {
        await writeFile(join(dropOutDir(), `${name}.error.json`), JSON.stringify({ error: `That file is not a readable job: ${err.message}` }, null, 2))
      }
      // Moved out of `in/` whatever happened, so one bad file cannot be re-read forever.
      try {
        await rename(from, join(dropDoneDir(), name))
      } catch {
        /* already gone */
      }
    }
    await writeDropResults()
  }

  async function writeDropResults() {
    const finished = (await listUncollected(null)).filter((j) => j.transport === 'drop' && j.drop_name)
    for (const job of finished) {
      const base = String(job.drop_name).replace(/\.json$/, '')
      if (job.status === 'done') {
        await writeFile(join(dropOutDir(), `${base}.result.json`), (job.result?.text ?? '') + '\n')
      } else {
        await writeFile(
          join(dropOutDir(), `${base}.error.json`),
          JSON.stringify({ error: job.error, raw: job.result_raw ? String(job.result_raw).slice(0, 20_000) : null }, null, 2),
        )
      }
      await markCollected([job.id])
      await logLine('drop.written', { id: job.id, file: `${base}.${job.status === 'done' ? 'result' : 'error'}.json` })
    }
  }

  // ---- routes -------------------------------------------------------------

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)

    if (req.method === 'OPTIONS') {
      // The preflight carries no Authorization header by definition, so it is answered
      // without one. Answering it with 401 is the commonest way a local service looks
      // unreachable to a browser that could in fact reach it.
      res.writeHead(204, corsHeaders(req))
      res.end()
      return
    }

    if (!tokenMatches(bearer(req), token)) {
      // 401 rather than 404: "reachable but the token is wrong" is one of the four
      // states the app's Test button must be able to tell apart, and it can only do
      // that if the refusal is distinguishable from a closed port.
      send(req, res, 401, { error: 'bad-token', message: 'This relay needs its bearer token.' })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const [queue, runnerState] = await Promise.all([stats(), runner()])
        send(req, res, 200, {
          ok: true,
          service: 'honest-eval-relay',
          version: RELAY_VERSION,
          home: relayHome(),
          queue,
          runner: runnerState,
          throttled: throttleState(),
          in_flight: inFlight,
          drop: { in: dropInDir(), out: dropOutDir() },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/jobs') {
        const body = await readBody(req)
        const checked = validateJobRequest(body)
        if (!checked.ok) {
          send(req, res, 400, { error: 'bad-request', message: checked.reason })
          return
        }
        const job = await enqueue(checked.value)
        await logLine('job.queued', { id: job.id, fn: job.fn, chars: String(checked.value.payload.prompt).length })
        void runOne()
        send(req, res, 202, { id: job.id, status: job.status })
        return
      }

      const jobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && jobMatch) {
        const id = decodeURIComponent(jobMatch[1])
        if (!isJobId(id)) {
          send(req, res, 400, { error: 'bad-request', message: 'That is not a job id.' })
          return
        }
        const job = await readJob(id)
        if (!job) {
          send(req, res, 404, { error: 'not-found', message: 'No such job. It may have been purged.' })
          return
        }
        send(req, res, 200, { job: publicJob(job), throttled: throttleState() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/results') {
        const workshopId = url.searchParams.get('workshop_id')
        const jobs = await listUncollected(workshopId)
        send(req, res, 200, { jobs: jobs.filter((j) => j.transport !== 'drop').map(publicJob) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/results/collect') {
        const body = await readBody(req)
        const ids = Array.isArray(body?.ids) ? body.ids.filter(isJobId) : []
        const collected = await markCollected(ids)
        send(req, res, 200, { collected })
        return
      }

      send(req, res, 404, { error: 'not-found', message: 'No such endpoint on this relay.' })
    } catch (err) {
      if (err.message === 'too-large') {
        send(req, res, 413, { error: 'too-large', message: 'That request is larger than this relay accepts.' })
        return
      }
      // Readable, never a stack trace (§7).
      send(req, res, 400, { error: 'bad-request', message: `That request could not be read: ${err.message}` })
    }
  }

  const server = createServer((req, res) => {
    void handler(req, res)
  })

  let tickTimer = null
  let dropTimer = null
  let purgeTimer = null

  async function start() {
    await ensureState()
    token = await loadOrCreateToken()
    throttle = await readThrottle()
    // A previous run may have died holding leases. They are reaped by their expiry on
    // the first claim, so nothing is needed here beyond saying so in the log.
    await logLine('relay.start', { port: config.port, host: config.host, home: relayHome(), version: RELAY_VERSION })
    await new Promise((resolve) => server.listen(config.port, config.host, resolve))
    tickTimer = setInterval(() => void runOne(), config.tickMs)
    dropTimer = setInterval(() => void scanDrop(), config.dropPollMs)
    purgeTimer = setInterval(() => void purge(), config.purgeEveryMs)
    void purge()
    return { token, port: config.port }
  }

  async function stop() {
    stopping = true
    clearInterval(tickTimer)
    clearInterval(dropTimer)
    clearInterval(purgeTimer)
    // Hand back anything in flight WITHOUT spending an attempt, so a deliberate restart
    // costs nothing. The spec's negative test is this: a job killed mid-run returns to
    // the queue and completes on restart, and it cannot duplicate observations because
    // the app's import replaces a capture's observations rather than appending them.
    for (const id of leased) await release(id)
    await logLine('relay.stop', { released: leased.size })
    await new Promise((resolve) => server.close(resolve))
  }

  return { start, stop, server, config, get token() { return token } }
}

/**
 * What a job request must look like.
 *
 * TIGHT TYPES AND A NAMED SPACE, per §2: the relay is a tool with a contract, and the
 * caller is a browser this file does not control. `fn` is a slug it will log and route
 * on, `expect` is a two-value enum, and the two text fields are bounded. Anything else
 * in the object is dropped rather than stored, so a caller cannot smuggle a field past
 * the runner by adding it here.
 */
export function validateJobRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'A job must be a JSON object.' }
  const fn = body.fn
  if (typeof fn !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(fn)) {
    return { ok: false, reason: 'A job needs an `fn` like "observation_routing".' }
  }
  const prompt = body.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, reason: 'A job needs a non-empty `prompt`.' }
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, reason: `That prompt is ${prompt.length} characters; this relay accepts ${MAX_PROMPT_CHARS}.` }
  }
  const system = body.system
  if (system !== undefined && system !== null && typeof system !== 'string') {
    return { ok: false, reason: '`system` must be a string when present.' }
  }
  if (typeof system === 'string' && system.length > MAX_SYSTEM_CHARS) {
    return { ok: false, reason: `That system prompt is ${system.length} characters; this relay accepts ${MAX_SYSTEM_CHARS}.` }
  }
  const model = body.model
  if (model !== undefined && model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(model))) {
    return { ok: false, reason: '`model` must be a model id like "claude-haiku-4-5".' }
  }
  const workshopId = body.workshop_id
  if (workshopId !== undefined && workshopId !== null && typeof workshopId !== 'string') {
    return { ok: false, reason: '`workshop_id` must be a string when present.' }
  }
  return {
    ok: true,
    value: {
      workshop_id: workshopId ?? null,
      fn,
      payload: {
        prompt,
        system: typeof system === 'string' ? system : null,
        model: typeof model === 'string' ? model : null,
        expect: body.expect === 'text' ? 'text' : 'json',
      },
    },
  }
}

// ---- run as a program ------------------------------------------------------

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  const config = parseArgs(process.argv.slice(2))
  const relay = createRelay(config)
  const { token } = await relay.start()
  process.stdout.write(
    [
      '',
      `Honest Eval relay ${RELAY_VERSION} listening on http://${config.host}:${config.port}`,
      `State:  ${relayHome()}`,
      `Token:  ${token}`,
      '',
      'Paste the address and token into Setup → AI → this machine, in Chrome.',
      'Drop folder (the transport that always works):',
      `  in:   ${dropInDir()}`,
      `  out:  ${dropOutDir()}`,
      '',
      'Ctrl-C to stop. Jobs in flight are handed back to the queue.',
      '',
    ].join('\n'),
  )
  const shutdown = async () => {
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
