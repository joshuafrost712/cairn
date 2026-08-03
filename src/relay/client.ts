/**
 * The browser's side of the relay (tl-21): enqueue, poll, collect, health.
 *
 * EVERY FETCH HAS A TIMEOUT. A relay that is not running answers nothing at all, and a
 * `fetch` to a closed port on loopback fails fast in Chrome but not in every browser or
 * every network stack; §4's rule is that a call with no timeout is a bug, and the button
 * this sits behind is one an administrator presses when they are already unsure whether
 * anything is working.
 *
 * THE FOUR FAILURES ARE TOLD APART, because they have different fixes and an
 * administrator cannot guess which one they have: not reachable, reachable with the
 * wrong token, reachable and healthy with no worker, and healthy but throttled. That
 * distinction is the whole value of the Test button, and it is why the relay answers a
 * bad token with 401 rather than closing the connection.
 */

import { getRelayToken, getRelayUrl, relayConfigured } from './config'

export interface RelayJobResult {
  text: string
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  metered_equivalent_usd: number | null
  duration_ms: number | null
  permission_denials?: number
}

export interface RelayJob {
  id: string
  workshop_id: string | null
  fn: string
  status: 'queued' | 'leased' | 'done' | 'failed'
  attempts: number
  transport: 'http' | 'drop'
  created_at: string
  finished_at: string | null
  collected_at: string | null
  result: RelayJobResult | null
  error: string | null
  raw_excerpt: string | null
}

export interface RelayHealth {
  ok: true
  service: string
  version: string
  home: string
  queue: {
    counts: { queued: number; leased: number; done: number; failed: number }
    uncollected: number
    last: {
      id: string
      fn: string
      status: string
      at: string
      attempts: number
      model: string | null
      tokens_in: number | null
      tokens_out: number | null
      duration_ms: number | null
      error: string | null
    } | null
  }
  runner: { available: boolean; reason: string | null; version: string | null }
  throttled: { until: string | null; message: string | null; at?: string } | null
  in_flight: number
  drop: { in: string; out: string }
}

/** Every way this can go wrong, as a state with a chrome id and a fix. */
export type RelayFailureState =
  | 'not-configured'
  | 'not-reachable'
  | 'bad-token'
  | 'refused'
  | 'timeout'
  | 'server'

export interface RelayFailure {
  ok: false
  state: RelayFailureState
  /** A chrome node id naming the state. */
  reasonId: string
  /** The relay's own words, where it had any. Never a stack trace. */
  message: string | null
}

const REASON_ID: Record<RelayFailureState, string> = {
  'not-configured': 'setup.ai.relay.state.not-configured',
  'not-reachable': 'setup.ai.relay.state.not-reachable',
  'bad-token': 'setup.ai.relay.state.bad-token',
  refused: 'setup.ai.relay.state.refused',
  timeout: 'setup.ai.relay.state.timeout',
  server: 'setup.ai.relay.state.server',
}

const fail = (state: RelayFailureState, message: string | null = null): RelayFailure => ({
  ok: false,
  state,
  reasonId: REASON_ID[state],
  message,
})

async function relayFetch(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; status: number; body: unknown } | RelayFailure> {
  const token = getRelayToken()
  if (!token) return fail('not-configured')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8_000)
  // A caller's own cancellation (a component unmounting) aborts this one too.
  init.signal?.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    const res = await fetch(`${getRelayUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      // No cookies, no credentials: the bearer token is the whole authorization story.
      credentials: 'omit',
      cache: 'no-store',
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { message: text.slice(0, 300) }
    }
    if (res.status === 401) return fail('bad-token', readMessage(body))
    if (res.status === 400 || res.status === 404 || res.status === 413) {
      return fail('refused', readMessage(body))
    }
    if (!res.ok) return fail('server', readMessage(body))
    return { ok: true, status: res.status, body }
  } catch (err) {
    if (controller.signal.aborted) return fail('timeout')
    /**
     * A network error here is indistinguishable from a permission denial by design:
     * the browser tells a page nothing about why a cross-origin request failed. So the
     * copy for this state names BOTH causes — the relay not running, and a browser
     * that has decided not to allow it — because Chrome's local-network work is
     * mid-rollout and a later version that starts asking would otherwise present as an
     * unexplained failure at a workshop.
     */
    return fail('not-reachable', err instanceof Error ? err.message : null)
  } finally {
    clearTimeout(timer)
  }
}

function readMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') {
    return (body as { message: string }).message
  }
  return null
}

export async function relayHealth(options: { timeoutMs?: number } = {}): Promise<
  { ok: true; health: RelayHealth } | RelayFailure
> {
  const res = await relayFetch('/health', { timeoutMs: options.timeoutMs ?? 6_000 })
  if (!res.ok) return res
  return { ok: true, health: res.body as RelayHealth }
}

/** What the Test button reports: one state, and enough detail to act on it. */
export type RelayDiagnosis =
  | { state: 'healthy'; health: RelayHealth }
  | { state: 'no-runner'; health: RelayHealth }
  | { state: 'throttled'; health: RelayHealth }
  | { state: RelayFailureState; failure: RelayFailure }

export async function diagnoseRelay(): Promise<RelayDiagnosis> {
  if (!relayConfigured()) return { state: 'not-configured', failure: fail('not-configured') }
  const res = await relayHealth()
  if (!res.ok) return { state: res.state, failure: res }
  const { health } = res
  // Order matters for the sentence somebody reads. A throttled relay with no worker is
  // reported as no worker, because that is the fault that has to be fixed first.
  if (!health.runner?.available) return { state: 'no-runner', health }
  if (health.throttled) return { state: 'throttled', health }
  return { state: 'healthy', health }
}

export interface RelayJobRequest {
  workshopId: string | null
  fn: string
  prompt: string
  system?: string | null
  model?: string | null
  expect?: 'json' | 'text'
}

function wireBody(req: RelayJobRequest) {
  return {
    workshop_id: req.workshopId,
    fn: req.fn,
    prompt: req.prompt,
    system: req.system ?? null,
    model: req.model ?? null,
    expect: req.expect ?? 'json',
  }
}

export async function submitRelayJob(req: RelayJobRequest): Promise<{ ok: true; id: string } | RelayFailure> {
  const res = await relayFetch('/jobs', { method: 'POST', body: wireBody(req), timeoutMs: 15_000 })
  if (!res.ok) return res
  const id = (res.body as { id?: unknown })?.id
  if (typeof id !== 'string') return fail('server', 'The relay accepted the job but did not name it.')
  return { ok: true, id }
}

export async function getRelayJob(id: string): Promise<{ ok: true; job: RelayJob } | RelayFailure> {
  const res = await relayFetch(`/jobs/${encodeURIComponent(id)}`)
  if (!res.ok) return res
  const job = (res.body as { job?: RelayJob })?.job
  if (!job) return fail('server', 'The relay did not return that job.')
  return { ok: true, job }
}

/**
 * Wait for a job to finish.
 *
 * THE RELAY IS THE DURABLE RECORD OF AN IN-FLIGHT JOB, NOT THE APP. If this poll times
 * out — the tab closed, the administrator navigated away, a batch took longer than the
 * window — the work carries on and the result waits in `/results`, which is what
 * `collectRelayResults` is for. So a timeout here is reported as "still running" rather
 * than as a failure, because the two are not the same thing and only one of them needs
 * doing again.
 */
export async function awaitRelayJob(
  id: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; job: RelayJob } | (RelayFailure & { stillRunning?: boolean })> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  const pollMs = options.pollMs ?? 1_500
  for (;;) {
    const res = await getRelayJob(id)
    if (!res.ok) return res
    if (res.job.status === 'done' || res.job.status === 'failed') return { ok: true, job: res.job }
    if (options.signal?.aborted) return { ...fail('timeout'), stillRunning: true }
    if (Date.now() >= deadline) return { ...fail('timeout'), stillRunning: true }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function collectRelayResults(
  workshopId: string | null,
): Promise<{ ok: true; jobs: RelayJob[] } | RelayFailure> {
  const query = workshopId ? `?workshop_id=${encodeURIComponent(workshopId)}` : ''
  const res = await relayFetch(`/results${query}`)
  if (!res.ok) return res
  const jobs = (res.body as { jobs?: RelayJob[] })?.jobs
  return { ok: true, jobs: Array.isArray(jobs) ? jobs : [] }
}

export async function markRelayCollected(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await relayFetch('/results/collect', { method: 'POST', body: { ids } })
  if (!res.ok) return 0
  const n = (res.body as { collected?: unknown })?.collected
  return typeof n === 'number' ? n : 0
}

/**
 * The same job as a file, for the folder exchange.
 *
 * The transport that always works: an untested browser, a locked-down profile, a phone,
 * or Safari, which refuses loopback as insecure content with no prompt and no setting to
 * change. Identical payload, identical validation on both sides — the relay's
 * `validateJobRequest` reads this file and the HTTP body through the same function.
 */
export function buildRelayJobFile(req: RelayJobRequest): string {
  return JSON.stringify(wireBody(req), null, 2) + '\n'
}
