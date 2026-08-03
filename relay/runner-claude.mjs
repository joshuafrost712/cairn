/**
 * One job becomes one `claude` invocation (tl-21).
 *
 * FOUR RULES THIS FILE IS THE ENFORCEMENT OF, each of them from the protocol rather
 * than from taste.
 *
 * **The payload goes on stdin and the process is spawned with an argument array.** A
 * dictated capture is arbitrary text; building a command line out of it is a shell
 * injection waiting for the first participant who says something with a quote in it.
 * There is no shell here at all — `spawn` with `shell: false`, which is the default and
 * is stated explicitly below so a later edit cannot flip it by accident.
 *
 * **Every tool is disallowed.** The worker's job is text in, JSON out. With no Bash, no
 * Read and no WebFetch, the worst a prompt-injected capture can achieve is a bad JSON
 * document, which the app's contract validator rejects. This is §5's answer for
 * untrusted input, and it is cheap here precisely because the job needs no tools.
 *
 * **The system prompt is the function's runbook, replacing the harness default.** Not
 * appended: `--system-prompt` plus `--setting-sources ""` and `--strict-mcp-config` is
 * what takes the per-call overhead from 13,694 tokens to a flat ~3,500, measured on
 * 2026-08-03 and confirmed again on the first real invocation of this build.
 *
 * **No metered key, ever.** `ANTHROPIC_API_KEY` is deleted from the child's environment.
 * The whole premise of this mode is a subscription that is already paid for, and a key
 * sitting in the operator's shell profile would silently bill them per call instead —
 * the same posture as `coach_api.py`'s `os.environ.pop`, for the same reason. `--bare`
 * is the flag that looks purpose-built for this and is the one flag that breaks
 * subscription auth ("OAuth and keychain are never read"), so it is not used.
 */

import { spawn } from 'node:child_process'
import { detectAuthFailure, detectThrottle, extractJson, parseEnvelope } from './extract.mjs'

/** Every tool the harness offers, refused. `permission_denials` proves it at run time. */
export const DISALLOWED_TOOLS =
  'Bash,Edit,Write,Read,WebFetch,WebSearch,Task,Glob,Grep,TodoWrite,NotebookEdit'

/**
 * The wall-clock allowance for one invocation.
 *
 * Ten minutes because a job is a BATCH: the measured overhead is ~3,500 tokens per call,
 * which is why captures are routed together rather than one at a time, and a batch of ten
 * takes minutes rather than the 1.3 to 3.3 seconds a ten-token prompt took. It must stay
 * comfortably below `DEFAULT_LEASE_MS` in queue.mjs, for the reason stated there.
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function claudeBin() {
  return process.env.HONEST_EVAL_RELAY_CLAUDE_BIN || 'claude'
}

/**
 * The argument vector, as a pure function so a test can assert on it.
 *
 * The prompt is NOT here. That is the point of the function existing.
 */
export function claudeArgs({ system, model }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disallowed-tools',
    DISALLOWED_TOOLS,
  ]
  if (system) args.push('--system-prompt', system)
  if (model) args.push('--model', model)
  return args
}

/** The child's environment: the parent's, minus anything that would meter the call. */
export function childEnv(base = process.env) {
  const env = { ...base }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

function spawnClaude({ prompt, system, model, timeoutMs, bin }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, claudeArgs({ system, model }), {
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (err) {
      resolve({ spawnFailed: true, reason: err.message })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    // A wall-clock timeout on the only outbound call in this process. §4: a call with
    // no timeout is a bug, and a hung worker at a workshop looks exactly like a queue
    // that has stopped for no reason.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ timedOut: true, stdout, stderr, timeoutMs })
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ spawnFailed: true, reason: err.message, stdout, stderr })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })

    child.stdin.on('error', () => {
      /* the child exited before reading: reported through `close` */
    })
    child.stdin.end(prompt)
  })
}

/**
 * Run one job. Never throws; every path returns an outcome the queue can act on.
 *
 * `{ ok: true, result }` — the extracted value and what it cost.
 * `{ ok: false, reason, retryable, raw?, throttle? }` — with `retryable` false for the
 * failures that will never succeed on a second attempt: an unauthenticated CLI, a
 * missing binary, a reply that is not the shape asked for.
 */
export async function runClaudeJob(job, { timeoutMs = DEFAULT_TIMEOUT_MS, bin = claudeBin() } = {}) {
  const payload = job?.payload ?? {}
  const prompt = String(payload.prompt ?? '')
  if (!prompt.trim()) {
    return { ok: false, reason: 'The job carried no prompt.', retryable: false }
  }

  const started = Date.now()
  const run = await spawnClaude({
    prompt,
    system: payload.system ? String(payload.system) : null,
    model: payload.model ? String(payload.model) : null,
    timeoutMs,
    bin,
  })
  const wall = Date.now() - started

  if (run.spawnFailed) {
    const missing = /ENOENT/i.test(run.reason ?? '')
    return {
      ok: false,
      retryable: false,
      reason: missing
        ? `The \`claude\` command was not found (looked for "${bin}"). Install Claude Code on this machine, or set HONEST_EVAL_RELAY_CLAUDE_BIN.`
        : `The worker could not be started: ${run.reason}`,
      runnerMissing: true,
    }
  }

  if (run.timedOut) {
    // Retryable: a timeout is the one failure here that is genuinely transient.
    return { ok: false, retryable: true, reason: `The worker did not finish within ${Math.round(run.timeoutMs / 1000)}s.` }
  }

  const combined = `${run.stdout}\n${run.stderr}`
  const auth = detectAuthFailure(combined)
  if (auth.unauthenticated) {
    return {
      ok: false,
      retryable: false,
      unauthenticated: true,
      reason: `The \`claude\` CLI on this machine is not signed in: ${auth.message}`,
    }
  }
  const throttled = detectThrottle(combined)
  if (throttled.throttled) {
    // Retryable AND a state: the queue keeps the job, the server stops dispatching, and
    // the app is told the difference between "this failed" and "this is waiting".
    return {
      ok: false,
      retryable: true,
      throttle: { until: throttled.resumeAt, message: throttled.message ?? null },
      reason: throttled.resumeAt
        ? `The subscription's usage limit was reached. It resumes at ${throttled.resumeAt}.`
        : "The subscription's usage limit was reached.",
    }
  }

  const env = parseEnvelope(run.stdout)
  if (!env.ok) {
    return {
      ok: false,
      retryable: run.code === 0 ? false : true,
      reason:
        run.code === 0
          ? env.reason
          : `The worker exited with code ${run.code}. ${firstLine(run.stderr) || env.reason}`,
      raw: truncate(combined),
    }
  }

  const apiThrottle = detectThrottle(env.result, { apiErrorStatus: env.apiErrorStatus })
  if (apiThrottle.throttled) {
    return {
      ok: false,
      retryable: true,
      throttle: { until: apiThrottle.resumeAt, message: apiThrottle.message ?? null },
      reason: "The subscription's usage limit was reached.",
    }
  }

  if (env.isError || run.code !== 0) {
    return {
      ok: false,
      // An API status we recognise as transient is worth one more attempt; anything
      // else is the model telling us this request does not work.
      retryable: env.apiErrorStatus === 429 || env.apiErrorStatus === 500 || env.apiErrorStatus === 503,
      reason: env.apiErrorStatus
        ? `The model call failed (status ${env.apiErrorStatus}).`
        : `The worker reported an error: ${firstLine(env.result) || `exit ${run.code}`}`,
      raw: truncate(env.result || combined),
    }
  }

  const expect = payload.expect === 'text' ? 'text' : 'json'
  const usage = {
    model: env.model,
    tokens_in: env.tokensIn,
    tokens_out: env.tokensOut,
    metered_equivalent_usd: env.meteredEquivalentUsd,
    duration_ms: env.durationMs ?? wall,
    permission_denials: env.permissionDenials.length,
  }

  if (expect === 'text') {
    const text = stripFence(env.result)
    if (!text.trim()) {
      return { ok: false, retryable: false, reason: 'The worker returned nothing.', raw: truncate(env.result) }
    }
    return { ok: true, result: { text, ...usage } }
  }

  const got = extractJson(env.result)
  if (!got.ok) {
    // NOT retryable, and the raw reply is kept. Three more identical attempts would
    // produce three more non-answers; what a person needs is to read what came back.
    return { ok: false, retryable: false, reason: got.reason, raw: truncate(env.result) }
  }
  return { ok: true, result: { text: got.text, ...usage } }
}

/** Is there a usable worker on this machine? Health asks this; nothing else does. */
export async function probeRunner({ bin = claudeBin(), timeoutMs = 15_000 } = {}) {
  const run = await new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, ['--version'], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (err) {
      resolve({ spawnFailed: true, reason: err.message })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ spawnFailed: true, reason: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
  if (run.spawnFailed) return { available: false, reason: run.reason, version: null }
  if (run.timedOut) return { available: false, reason: 'The version check timed out.', version: null }
  if (run.code !== 0) return { available: false, reason: firstLine(run.err) || `exit ${run.code}`, version: null }
  return { available: true, reason: null, version: firstLine(run.out) }
}

function stripFence(text) {
  const body = String(text ?? '').trim()
  const fenced = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : body
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].slice(0, 300)
}

/** Kept for reading, not for logging: bounded so one bad run cannot fill the disk. */
function truncate(text, max = 20_000) {
  const body = String(text ?? '')
  return body.length > max ? `${body.slice(0, max)}\n[...truncated]` : body
}
