/**
 * Reading what the CLI said (tl-21). Pure string work, no IO, so every case below is a
 * unit test rather than a live run.
 *
 * THE HEADLINE FINDING THIS FILE EXISTS FOR: the model's answer may come back inside a
 * fence, and whether it does is not stable. Three trials of "Reply with only this JSON and
 * nothing else" on 2026-08-03 returned ```json\n{...}\n``` every time, and a fourth on the
 * real invocation did the same; with `--tools ''` added at pre-merge review the same prompt
 * came back BARE. So "every time" was a property of one configuration, not of the model.
 * Which changes nothing here, and that is the point: the runner EXTRACTS the first balanced
 * JSON object rather than parsing `result`, so both shapes work and neither is relied on. A
 * build that had trusted the instruction would have failed on its first real job; a build
 * that had trusted the FENCE would have failed the day this flag was added.
 */

/**
 * The first balanced JSON object or array in a string, as text, or null.
 *
 * Brace counting with string awareness, not a regex: a capture's dictated text can
 * contain a brace, and a routed observation's `source_excerpt` regularly does. Escapes
 * inside strings are honoured so a `\"` cannot end a string early.
 */
export function extractJsonValue(text) {
  if (typeof text !== 'string') return null
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** The same, parsed. Returns `{ ok, value }` or `{ ok: false, reason }`. */
export function extractJson(text) {
  const slice = extractJsonValue(text)
  if (slice === null) return { ok: false, reason: 'The reply contained no JSON.' }
  try {
    return { ok: true, value: JSON.parse(slice), text: slice }
  } catch (err) {
    return { ok: false, reason: `The reply's JSON did not parse: ${err.message}` }
  }
}

/**
 * Read the CLI's `--output-format json` envelope.
 *
 * TREATED AS UNSTABLE ON PURPOSE. Unknown fields are ignored, missing ones do not
 * throw, and a stdout that is not JSON at all is a readable failure rather than an
 * exception: this is one tool's undocumented output shape, and it will change.
 */
export function parseEnvelope(stdout) {
  const got = extractJson(stdout)
  if (!got.ok) return { ok: false, reason: 'The CLI did not return a JSON envelope.', raw: stdout }
  const env = got.value
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, reason: 'The CLI envelope was not an object.', raw: stdout }
  }
  const usage = (env.usage && typeof env.usage === 'object' ? env.usage : {}) || {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    ok: true,
    envelope: env,
    isError: env.is_error === true,
    apiErrorStatus: typeof env.api_error_status === 'number' ? env.api_error_status : null,
    stopReason: typeof env.stop_reason === 'string' ? env.stop_reason : null,
    result: typeof env.result === 'string' ? env.result : '',
    model: firstModel(env),
    /**
     * Everything the request was charged for, cache included. A prompt that reads
     * 9,000 tokens from cache cost the subscription those tokens; reporting only
     * `input_tokens` would make the second call of a batch look four times cheaper
     * than the first, which is the opposite of the truth the estimator needs.
     */
    tokensIn:
      num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens),
    tokensOut: num(usage.output_tokens),
    /**
     * `total_cost_usd` is what the same work would have cost on the metered API. It is
     * recorded under a name that says so and is NEVER rendered as money in this mode,
     * which is tl-14's rule: a subscription is not per-call spend.
     */
    meteredEquivalentUsd:
      typeof env.total_cost_usd === 'number' && Number.isFinite(env.total_cost_usd)
        ? env.total_cost_usd
        : null,
    durationMs: typeof env.duration_ms === 'number' ? env.duration_ms : null,
    /**
     * The field that proves the tools were REFUSED rather than merely absent, which is
     * the negative test the spec asks for on a prompt-injected capture.
     */
    permissionDenials: Array.isArray(env.permission_denials) ? env.permission_denials : [],
  }
}

/**
 * Which model actually ran. `modelUsage` carries one key per model the harness touched
 * — a real run showed two, the worker's model and a small internal call — so the one
 * with the most input tokens is the one that did the job.
 */
function firstModel(env) {
  const usage = env.modelUsage
  if (!usage || typeof usage !== 'object') return null
  const entries = Object.entries(usage)
  if (entries.length === 0) return null
  entries.sort((a, b) => (b[1]?.inputTokens ?? 0) - (a[1]?.inputTokens ?? 0))
  return entries[0][0]
}

const THROTTLE = /usage limit|rate limit|limit reached|too many requests|quota|overloaded/i
const AUTH = /not logged in|please (?:run |use )?.?claude (?:login|setup-token)|invalid api key|authentication_error|unauthorized|oauth token (?:has )?expired|credentials? (?:not found|expired)/i

/**
 * Whether this failure is the subscription's usage limit, and when it lifts.
 *
 * THROTTLE IS A STATE, NOT AN ERROR, and this is where the state is recognised. A
 * workshop day that hits the limit needs to be told that is what happened, because the
 * answer — wait, or attach another subscription — depends on knowing it. The size of
 * the limit is deliberately never quoted: it is measured by hitting it, and a number
 * in the copy would be a fabricated figure.
 *
 * Deliberately loose matching over several unrelated shapes (a 429, a message, an
 * envelope subtype), because this is one tool's error text and the cost of a false
 * negative is a workshop being told "the request failed" when the truthful answer was
 * available.
 */
export function detectThrottle(text, { apiErrorStatus = null, now = Date.now() } = {}) {
  const body = String(text ?? '')
  const hit = apiErrorStatus === 429 || THROTTLE.test(body)
  if (!hit) return { throttled: false, resumeAt: null }
  return { throttled: true, resumeAt: parseResumeAt(body, now), message: firstLine(body) }
}

/** Whether the CLI is not usable at all: no login, no credentials, a rejected key. */
export function detectAuthFailure(text) {
  const body = String(text ?? '')
  if (!AUTH.test(body)) return { unauthenticated: false }
  return { unauthenticated: true, message: firstLine(body) }
}

/**
 * When the limit lifts, from whatever the message happens to carry: a unix timestamp,
 * an ISO instant, or a clock time like "3pm". Null when it says nothing, which is a
 * legitimate answer — "throttled, resume time unknown" is honest and "throttled until
 * a time I invented" is not.
 */
export function parseResumeAt(body, now = Date.now()) {
  const unix = body.match(/\b(1[6-9]\d{8}|2\d{9})\b/)
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString()

  const isoMatch = body.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/)
  if (isoMatch) {
    const at = Date.parse(isoMatch[0].endsWith('Z') ? isoMatch[0] : `${isoMatch[0]}Z`)
    if (Number.isFinite(at)) return new Date(at).toISOString()
  }

  const clock = body.match(/reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (clock) {
    const base = new Date(now)
    let hour = Number(clock[1]) % 24
    const minute = clock[2] ? Number(clock[2]) : 0
    const mer = clock[3]?.toLowerCase()
    if (mer === 'pm' && hour < 12) hour += 12
    if (mer === 'am' && hour === 12) hour = 0
    const at = new Date(base)
    at.setHours(hour, minute, 0, 0)
    // A time already past means tomorrow: "resets at 3pm" read at 4pm is the next 3pm.
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.toISOString()
  }
  return null
}

function firstLine(body) {
  return String(body).split('\n')[0].slice(0, 300)
}
