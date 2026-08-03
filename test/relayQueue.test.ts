import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LEASE_MS,
  MAX_ATTEMPTS,
  completePatch,
  failurePatch,
  isLeaseExpired,
  leasePatch,
  pickNext,
  purgeIds,
  reapExpired,
  summarize,
  uncollected,
} from '../relay/queue.mjs'
import {
  detectAuthFailure,
  detectThrottle,
  extractJson,
  extractJsonValue,
  parseEnvelope,
  parseResumeAt,
} from '../relay/extract.mjs'
import { claudeArgs, childEnv, DISALLOWED_TOOLS, DEFAULT_TIMEOUT_MS } from '../relay/runner-claude.mjs'
import { validateJobRequest } from '../relay/server.mjs'
import { buildRelayJobFile } from '../src/relay/client'

/**
 * The relay's queue and its reading of the CLI (tl-21).
 *
 * Everything here is a pure function of `(jobs, now)` or of a string, which is the reason
 * the queue policy lives in its own module: every interesting case is about time — a lease
 * that expired, an attempt that was the last one, a completed job old enough to purge —
 * and time is exactly what a test cannot wait for.
 *
 * The disk half gets one real round trip at the end, against a temp directory, because
 * "written by atomic rename" is a claim about the filesystem rather than about a function.
 */

const T0 = Date.parse('2026-08-04T09:00:00.000Z')
const at = (ms: number) => new Date(ms).toISOString()

interface Job {
  id: string
  status: string
  attempts: number
  lease_until: string | null
  created_at: string
  updated_at?: string
  finished_at?: string | null
  collected_at?: string | null
  workshop_id?: string | null
  fn?: string
  payload?: Record<string, unknown>
  result?: Record<string, unknown> | null
  error?: string | null
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  status: 'queued',
  attempts: 0,
  lease_until: null,
  created_at: at(T0),
  updated_at: at(T0),
  finished_at: null,
  collected_at: null,
  workshop_id: 'w1',
  fn: 'observation_routing',
  payload: { prompt: 'route these', system: 'runbook', model: null, expect: 'json' },
  result: null,
  error: null,
  ...over,
})

describe('leases', () => {
  it('does not expire a lease that is still running', () => {
    const j = job({ status: 'leased', lease_until: at(T0 + 60_000) })
    expect(isLeaseExpired(j, T0)).toBe(false)
  })

  it('expires a lease at its stated moment, not after it', () => {
    const j = job({ status: 'leased', lease_until: at(T0) })
    expect(isLeaseExpired(j, T0)).toBe(true)
  })

  it('treats a leased job with no expiry as expired', () => {
    // Not a state this code can write, which is why it is worth handling: a
    // hand-edited job file at a workshop is a documented recovery path, and a leased
    // job with no lease would otherwise be stuck forever with nothing to reap it.
    expect(isLeaseExpired(job({ status: 'leased', lease_until: null }), T0)).toBe(true)
  })

  it('ignores queued, done and failed jobs', () => {
    for (const status of ['queued', 'done', 'failed']) {
      expect(isLeaseExpired(job({ status, lease_until: at(T0 - 1) }), T0)).toBe(false)
    }
  })

  it('leaves the lease comfortably longer than the runner is allowed to take', () => {
    // THE INVARIANT THAT PREVENTS DOUBLE SPEND. A lease shorter than a job's
    // wall-clock allowance lets the queue reap a job that is still running, hand it to
    // a second worker, and bill the subscription twice for one batch.
    expect(DEFAULT_LEASE_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS)
  })
})

describe('reaping an abandoned job', () => {
  it('returns it to the queue with its attempt already counted', () => {
    const jobs = [job({ status: 'leased', attempts: 1, lease_until: at(T0 - 1) })]
    const [patch] = reapExpired(jobs, T0)
    expect(patch.patch.status).toBe('queued')
    expect(patch.patch.lease_until).toBeNull()
  })

  it('fails it for good once its attempts are spent', () => {
    const jobs = [job({ status: 'leased', attempts: MAX_ATTEMPTS, lease_until: at(T0 - 1) })]
    const [patch] = reapExpired(jobs, T0)
    expect(patch.patch.status).toBe('failed')
    expect(patch.patch.error).toMatch(/lease expired/)
    expect(patch.patch.finished_at).toBe(at(T0))
  })

  it('counts the attempt at claim time, so a crash that wrote nothing still costs one', () => {
    const claimed = { ...job(), ...leasePatch(job(), T0) }
    expect(claimed.attempts).toBe(1)
    expect(claimed.status).toBe('leased')
    expect(Date.parse(claimed.lease_until as string)).toBe(T0 + DEFAULT_LEASE_MS)
  })

  it('reaps nothing when everything is healthy', () => {
    expect(reapExpired([job(), job({ id: 'j2', status: 'done' })], T0)).toEqual([])
  })
})

describe('picking the next job', () => {
  it('takes the oldest queued job, so a batch keeps its order', () => {
    const jobs = [
      job({ id: 'later', created_at: at(T0 + 5_000) }),
      job({ id: 'earlier', created_at: at(T0) }),
    ]
    expect(pickNext(jobs, T0)?.id).toBe('earlier')
  })

  it('never picks a leased, done or failed job', () => {
    const jobs = [
      job({ id: 'a', status: 'leased', lease_until: at(T0 + 60_000) }),
      job({ id: 'b', status: 'done' }),
      job({ id: 'c', status: 'failed' }),
    ]
    expect(pickNext(jobs, T0)).toBeNull()
  })
})

describe('failure policy', () => {
  it('requeues a transient failure while attempts remain', () => {
    const patch = failurePatch(job({ attempts: 1 }), T0, 'the worker timed out')
    expect(patch.status).toBe('queued')
    expect(patch.finished_at).toBeUndefined()
  })

  it('fails a non-transient failure immediately, whatever the attempt count', () => {
    // §4: never retry a non-transient error at all. Three more attempts at an
    // unauthenticated CLI only delay the honest answer.
    const patch = failurePatch(job({ attempts: 0 }), T0, 'not signed in', { retryable: false })
    expect(patch.status).toBe('failed')
    expect(patch.finished_at).toBe(at(T0))
  })

  it('keeps the raw reply on a failure, and drops it on success', () => {
    expect(failurePatch(job(), T0, 'not JSON', { retryable: false, raw: 'I think that…' }).result_raw).toBe(
      'I think that…',
    )
    expect(completePatch(T0, { text: '{}' }).result_raw).toBeNull()
  })

  it('gives up after the third attempt', () => {
    const patch = failurePatch(job({ attempts: MAX_ATTEMPTS }), T0, 'the worker timed out')
    expect(patch.status).toBe('failed')
  })
})

describe('collection and purging', () => {
  it('offers finished work for one workshop only, oldest first', () => {
    const jobs = [
      job({ id: 'mine-2', status: 'done', created_at: at(T0 + 1000) }),
      job({ id: 'mine-1', status: 'done', created_at: at(T0) }),
      job({ id: 'theirs', status: 'done', workshop_id: 'w2' }),
      job({ id: 'running', status: 'leased' }),
      job({ id: 'collected', status: 'done', collected_at: at(T0) }),
    ]
    expect(uncollected(jobs, 'w1').map((j) => j.id)).toEqual(['mine-1', 'mine-2'])
  })

  it('offers failed jobs too, because a failure nobody has read is the one worth reading', () => {
    expect(uncollected([job({ status: 'failed' })], 'w1')).toHaveLength(1)
  })

  it('purges completed work after a day and failures after a week', () => {
    const day = 24 * 60 * 60_000
    const jobs = [
      job({ id: 'fresh-done', status: 'done', finished_at: at(T0 - 60_000) }),
      job({ id: 'old-done', status: 'done', finished_at: at(T0 - day) }),
      job({ id: 'old-failed', status: 'failed', finished_at: at(T0 - day) }),
      job({ id: 'ancient-failed', status: 'failed', finished_at: at(T0 - 8 * day) }),
      job({ id: 'queued', status: 'queued' }),
    ]
    expect(purgeIds(jobs, T0).sort()).toEqual(['ancient-failed', 'old-done'])
  })

  it('purges an uncollected result on the same clock as a collected one', () => {
    // Deliberate: the alternative keeps participant evidence on a laptop indefinitely
    // because nobody pressed a button, and the captures themselves are still in the app.
    const jobs = [job({ status: 'done', finished_at: at(T0 - 48 * 60 * 60_000), collected_at: null })]
    expect(purgeIds(jobs, T0)).toHaveLength(1)
  })
})

describe('the health summary', () => {
  it('counts by status and names the last finished job', () => {
    const jobs = [
      job({ id: 'a', status: 'queued' }),
      job({ id: 'b', status: 'leased' }),
      job({
        id: 'c',
        status: 'done',
        finished_at: at(T0 + 1000),
        result: { model: 'claude-haiku-4-5', tokens_in: 3496, tokens_out: 71, duration_ms: 1300 },
      }),
    ]
    const s = summarize(jobs)
    expect(s.counts).toEqual({ queued: 1, leased: 1, done: 1, failed: 0 })
    expect(s.last?.tokens_in).toBe(3496)
    expect(s.uncollected).toBe(1)
  })

  it('never carries payload text or a raw reply into the summary', () => {
    // The log and the health endpoint are both built from this, and the log is the file
    // most likely to be pasted into a support conversation.
    const jobs = [
      job({
        status: 'failed',
        finished_at: at(T0),
        payload: { prompt: 'PARTICIPANT SAID SOMETHING PRIVATE' },
        error: 'not JSON',
      }),
    ]
    const s = summarize(jobs)
    expect(JSON.stringify(s)).not.toContain('PRIVATE')
    expect(s.last?.error).toBe('not JSON')
  })
})

describe('extracting the answer from the reply', () => {
  it('reads a fenced JSON object, which is what the CLI actually returns', () => {
    // Measured on 2026-08-03 and again on this build's first real invocation: three
    // trials of "Reply with only this JSON and nothing else" all came back fenced.
    const reply = '```json\n{"ok":true,"n":7}\n```'
    expect(extractJson(reply)).toEqual({ ok: true, value: { ok: true, n: 7 }, text: '{"ok":true,"n":7}' })
  })

  it('survives braces inside a quoted string, which dictated evidence contains', () => {
    const reply = 'Here you go: {"text":"he said {this} out loud","n":1} — done'
    expect(extractJson(reply).value).toEqual({ text: 'he said {this} out loud', n: 1 })
  })

  it('is not fooled by an escaped quote', () => {
    const reply = '{"text":"she said \\"no\\" firmly","n":2}'
    expect(extractJson(reply).value).toEqual({ text: 'she said "no" firmly', n: 2 })
  })

  it('reads a bare array as well as an object', () => {
    expect(extractJsonValue('note: [1,2,3]')).toBe('[1,2,3]')
  })

  it('says so when there is no JSON at all, rather than throwing', () => {
    expect(extractJson('I am unable to help with that.')).toEqual({
      ok: false,
      reason: 'The reply contained no JSON.',
    })
  })

  it('reports unbalanced JSON as a failure rather than a partial parse', () => {
    expect(extractJson('{"a":1').ok).toBe(false)
  })
})

describe('reading the CLI envelope', () => {
  const envelope = {
    type: 'result',
    is_error: false,
    api_error_status: null,
    duration_ms: 1300,
    result: '```json\n{"ok":true}\n```',
    stop_reason: 'end_turn',
    total_cost_usd: 0.004267,
    usage: {
      input_tokens: 3496,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 71,
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 356, outputTokens: 12 },
      'claude-haiku-4-5': { inputTokens: 3496, outputTokens: 71 },
    },
    permission_denials: [],
  }

  it('reads the fields this build depends on', () => {
    const env = parseEnvelope(JSON.stringify(envelope))
    expect(env.ok).toBe(true)
    expect(env.tokensIn).toBe(3496)
    expect(env.tokensOut).toBe(71)
    expect(env.meteredEquivalentUsd).toBeCloseTo(0.004267)
    expect(env.isError).toBe(false)
  })

  it('counts cache reads and creations as tokens the subscription spent', () => {
    // A prompt that reads 9,000 tokens from cache cost those tokens. Reporting only
    // input_tokens would make the second call of a batch look four times cheaper than
    // the first, which is the opposite of the truth the estimator needs.
    const env = parseEnvelope(
      JSON.stringify({
        ...envelope,
        usage: { input_tokens: 10, cache_creation_input_tokens: 4769, cache_read_input_tokens: 8925, output_tokens: 5 },
      }),
    )
    expect(env.tokensIn).toBe(13_704)
  })

  it('names the model that did the work, not the internal side call', () => {
    expect(parseEnvelope(JSON.stringify(envelope)).model).toBe('claude-haiku-4-5')
  })

  it('treats the envelope as unstable: missing fields do not throw', () => {
    const env = parseEnvelope(JSON.stringify({ result: 'hello' }))
    expect(env.ok).toBe(true)
    expect(env.tokensIn).toBe(0)
    expect(env.meteredEquivalentUsd).toBeNull()
    expect(env.model).toBeNull()
  })

  it('reports non-JSON stdout as a readable failure', () => {
    const env = parseEnvelope('command not found: claude')
    expect(env.ok).toBe(false)
    expect(env.reason).toMatch(/did not return a JSON envelope/)
  })
})

describe('throttle is a state, not an error', () => {
  it('recognises a usage limit and keeps the resume time it was given', () => {
    const got = detectThrottle('Claude usage limit reached. Your limit will reset at 3pm.', {
      now: Date.parse('2026-08-04T09:00:00.000Z'),
    })
    expect(got.throttled).toBe(true)
    expect(got.resumeAt).not.toBeNull()
  })

  it('recognises a 429 with no words at all', () => {
    expect(detectThrottle('', { apiErrorStatus: 429 }).throttled).toBe(true)
  })

  it('reads a unix timestamp and an ISO instant', () => {
    expect(parseResumeAt('resets at 1786000000')).toBe(new Date(1786000000 * 1000).toISOString())
    expect(parseResumeAt('limit resets 2026-08-04T15:30:00Z')).toBe('2026-08-04T15:30:00.000Z')
  })

  it('reads a clock time as the NEXT such time', () => {
    const now = Date.parse('2026-08-04T16:00:00.000Z')
    const resume = parseResumeAt('resets at 3pm', now)
    expect(Date.parse(resume as string)).toBeGreaterThan(now)
  })

  it('answers null rather than inventing a resume time', () => {
    // "Throttled, resume time unknown" is honest; "throttled until a time I invented"
    // is the no-fabricated-numbers criterion being broken where nobody would check.
    expect(detectThrottle('usage limit reached').resumeAt).toBeNull()
  })

  it('does not read an ordinary refusal as a throttle', () => {
    expect(detectThrottle('I cannot help with that request.').throttled).toBe(false)
  })

  it('recognises an unauthenticated CLI, which is permanent rather than transient', () => {
    expect(detectAuthFailure('Invalid API key · Please run /login').unauthenticated).toBe(true)
    expect(detectAuthFailure('OAuth token has expired').unauthenticated).toBe(true)
    expect(detectAuthFailure('routed 4 captures').unauthenticated).toBe(false)
  })
})

describe('the invocation', () => {
  it('never puts the payload on the command line', () => {
    // A dictated capture is arbitrary text; building a command line out of it is a shell
    // injection waiting for the first participant who says something with a quote in it.
    const args = claudeArgs({ system: 'runbook', model: 'claude-haiku-4-5' })
    expect(args.join(' ')).not.toContain('route these')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
  })

  it('replaces the harness system prompt and cuts its configuration sources', () => {
    // This is the difference between 13,694 input tokens per call and a flat ~3,500.
    const args = claudeArgs({ system: 'runbook', model: null })
    expect(args).toContain('--system-prompt')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--setting-sources')
    expect(args).not.toContain('--bare')
  })

  it('disallows every tool the harness offers', () => {
    const args = claudeArgs({ system: null, model: null })
    const i = args.indexOf('--disallowed-tools')
    expect(i).toBeGreaterThan(-1)
    for (const tool of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) {
      expect(args[i + 1]).toContain(tool)
    }
    expect(DISALLOWED_TOOLS.split(',')).toHaveLength(11)
  })

  it('strips any metered credential from the child environment', () => {
    const env = childEnv({ ANTHROPIC_API_KEY: 'sk-ant-real', PATH: '/usr/bin' })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('one contract for both transports', () => {
  it('accepts the job file the browser writes for the folder exchange', () => {
    // The floor and the direct path are validated by the SAME function on the relay
    // side, which is what makes "same payloads, same validation" true rather than
    // asserted.
    const file = buildRelayJobFile({
      workshopId: 'w1',
      fn: 'observation_routing',
      prompt: 'route these',
      system: 'runbook',
      model: 'claude-haiku-4-5',
    })
    const checked = validateJobRequest(JSON.parse(file))
    expect(checked.ok).toBe(true)
    expect(checked.value.payload.expect).toBe('json')
  })

  it('refuses a job with no prompt, a silly fn, or an invented model id', () => {
    expect(validateJobRequest({ fn: 'observation_routing' }).ok).toBe(false)
    expect(validateJobRequest({ fn: 'DROP TABLE', prompt: 'x' }).ok).toBe(false)
    expect(validateJobRequest({ fn: 'observation_routing', prompt: 'x', model: 'rm -rf /' }).ok).toBe(false)
  })

  it('drops a field it does not know rather than storing it', () => {
    const checked = validateJobRequest({ fn: 'scenario_draft', prompt: 'x', sneaky: 'tool_use' })
    expect(checked.ok).toBe(true)
    expect(JSON.stringify(checked.value)).not.toContain('sneaky')
  })

  it('refuses a prompt beyond its cap rather than truncating it into a half-request', () => {
    const checked = validateJobRequest({ fn: 'scenario_draft', prompt: 'x'.repeat(400_001) })
    expect(checked.ok).toBe(false)
    expect(checked.reason).toMatch(/400000/)
  })
})

describe('the queue on disk', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tl21-relay-'))
    process.env.HONEST_EVAL_RELAY_HOME = home
  })

  afterEach(async () => {
    delete process.env.HONEST_EVAL_RELAY_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('round-trips a job through queued, leased and done', async () => {
    const state = await import('../relay/state.mjs')
    const queued = await state.enqueue({ workshop_id: 'w1', fn: 'observation_routing', payload: { prompt: 'p' } })
    expect(queued.status).toBe('queued')

    const claimed = await state.claimNext()
    expect(claimed?.id).toBe(queued.id)
    expect(claimed?.status).toBe('leased')
    expect(await state.claimNext()).toBeNull()

    await state.complete(queued.id, { text: '{"ok":true}', tokens_in: 10, tokens_out: 2 })
    const waiting = await state.listUncollected('w1')
    expect(waiting.map((j) => j.id)).toEqual([queued.id])

    expect(await state.markCollected([queued.id])).toBe(1)
    expect(await state.listUncollected('w1')).toHaveLength(0)
  })

  it('hands a released job straight back without spending an attempt', async () => {
    const state = await import('../relay/state.mjs')
    const j = await state.enqueue({ fn: 'observation_routing', payload: { prompt: 'p' } })
    const claimed = await state.claimNext()
    expect(claimed?.attempts).toBe(1)
    await state.release(j.id)
    const again = await state.readJob(j.id)
    expect(again?.status).toBe('queued')
    expect(again?.attempts).toBe(1)
  })

  it('skips a hand-edited file that no longer parses instead of failing the whole queue', async () => {
    // Reading and fixing a stuck job with a text editor at a workshop is a documented
    // recovery path, so a half-saved file must not take the queue down with it.
    const state = await import('../relay/state.mjs')
    await state.enqueue({ fn: 'observation_routing', payload: { prompt: 'p' } })
    await writeFile(join(home, 'jobs', 'broken.json'), '{ not json')
    expect(await state.readJobs()).toHaveLength(1)
  })

  it('refuses a job id that is not one of ours, because it indexes a filename', async () => {
    const state = await import('../relay/state.mjs')
    expect(await state.readJob('../../etc/passwd')).toBeNull()
    expect(state.isJobId('a/b')).toBe(false)
  })

  it('keeps its state out of /tmp by default', async () => {
    // The standing persistence rule: an in-flight job is the only durable record that
    // the work was asked for, and /tmp is wiped on reboot.
    delete process.env.HONEST_EVAL_RELAY_HOME
    const state = await import('../relay/state.mjs')
    expect(state.relayHome()).not.toMatch(/^\/tmp/)
    expect(state.relayHome()).toMatch(/honest-eval-relay/)
    process.env.HONEST_EVAL_RELAY_HOME = home
  })

  it('writes a log line with no payload text in it', async () => {
    const state = await import('../relay/state.mjs')
    await state.ensureState()
    await state.logLine('job.done', { id: 'j1', tokens_in: 10 })
    const files = await readdir(home)
    expect(files).toContain('relay.log')
  })
})
