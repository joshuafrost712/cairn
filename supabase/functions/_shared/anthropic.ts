/**
 * The Anthropic Messages call, shared by Edge Functions (tl-23).
 *
 * Lives in _shared rather than inline in route-captures because `draft-scenario`
 * will need it the moment anyone wants scenario drafting on this key — the spec's
 * own out-of-scope note says this file is what closes that gap in a small
 * follow-on. Deliberately dependency-free (fetch + AbortSignal only, no Deno.*,
 * no supabase-js) so `test/hostedRouting.test.ts` can import it under vitest and
 * pin the allowlist, the extraction, and the usage summing without a Deno
 * runtime.
 *
 * MODEL IDS. The Anthropic API's own identifiers for these models are exactly the
 * registry ids in src/ai/models.ts — `claude-sonnet-5` etc., no date suffix —
 * verified against the API reference on 2026-08-04, so the registry id IS the
 * wire id and no mapping layer exists to drift. A unit test keeps this list equal
 * to the registry's Anthropic entries; adding a model means editing both, which
 * is the same both-lists discipline AI_FUNCTION_DEFAULTS uses.
 */

/** The models this endpoint knows how to call. Mirrors the registry's Anthropic ids. */
export const ANTHROPIC_CALLABLE_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
] as const

/** Joshua's stated choice for routing (2026-08-04), used when a workshop names none. */
export const DEFAULT_ROUTING_MODEL = 'claude-sonnet-5'

/**
 * Output headroom per call. Not a target: a routed capture's observations ran
 * ~231 output tokens through the relay, but Sonnet 5 thinks adaptively by
 * default and thinking counts against max_tokens, so a tight cap would truncate
 * the answer mid-JSON with no error worth reading.
 */
export const ANTHROPIC_MAX_TOKENS = 8192

/** No outbound call is unbounded (Agent-Engineering-Protocol §4). */
export const ANTHROPIC_TIMEOUT_MS = 90_000

export interface AnthropicUsage {
  tokens_in: number | null
  tokens_out: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

export interface AnthropicReply {
  text: string
  model: string
  usage: AnthropicUsage
}

/**
 * All four usage fields, kept apart. `input_tokens` EXCLUDES the cache read —
 * tl-21's measurement was wrong by a factor of sixty because of exactly this —
 * and the cache fields bill at different rates, so folding them into tokens_in
 * would misprice the call in whichever direction the reader assumed.
 */
export function readUsage(usage: unknown): AnthropicUsage {
  const u = (usage ?? {}) as Record<string, unknown>
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    tokens_in: int(u.input_tokens),
    tokens_out: int(u.output_tokens),
    cache_read_tokens: int(u.cache_read_input_tokens),
    cache_write_tokens: int(u.cache_creation_input_tokens),
  }
}

/** What one call spent, all fields counted, for the ceiling and the trace. */
export function totalTokens(usage: AnthropicUsage): number {
  return (
    (usage.tokens_in ?? 0) +
    (usage.tokens_out ?? 0) +
    (usage.cache_read_tokens ?? 0) +
    (usage.cache_write_tokens ?? 0)
  )
}

/**
 * One Messages call. The system prompt goes in a cacheable block: every capture
 * in a fan-out shares the same workshop rubric, so the second call onward should
 * read it at ~0.1x. Whether it actually does depends on the prompt clearing the
 * model's minimum cacheable length (1024 tokens on Sonnet 5, 4096 on Haiku 4.5)
 * — the spec asks for that to be measured, not assumed, and the cache columns on
 * ai_call_log are how. No sampling parameters: Sonnet 5 rejects non-default
 * temperature/top_p outright.
 */
export async function callAnthropic(args: {
  apiKey: string
  model: string
  system: string
  prompt: string
  maxTokens?: number
  timeoutMs?: number
}): Promise<AnthropicReply> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': args.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens ?? ANTHROPIC_MAX_TOKENS,
      system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: args.prompt }],
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? ANTHROPIC_TIMEOUT_MS),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new AnthropicHttpError(res.status, detail.slice(0, 500))
  }

  const data = (await res.json()) as {
    model?: string
    stop_reason?: string
    content?: Array<{ type?: string; text?: string }>
    usage?: unknown
  }
  const text = (data.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  return {
    text,
    model: typeof data.model === 'string' ? data.model : args.model,
    usage: readUsage(data.usage),
  }
}

/** A non-2xx from the API, with enough of the body to say why. */
export class AnthropicHttpError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(`Anthropic request failed (${status}): ${detail}`)
    this.status = status
  }
}

/**
 * Pull the JSON object out of a model reply: strip a fence if there is one,
 * otherwise take the first balanced object. The relay's rule, not a new one —
 * tl-21 learned that the fence is a property of one configuration rather than of
 * the model, so neither shape may be assumed. Returns null when the text holds
 * no object; the caller decides whether that is an error or a `{ raw }` reply.
 */
export function extractJsonObject(text: string): string | null {
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()

  const start = raw.indexOf('{')
  if (start < 0) return null

  // Balanced-brace scan that respects strings and escapes, because an
  // observation's quote can legally contain every brace and bracket there is.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}
