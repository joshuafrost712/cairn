import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ANTHROPIC_CALLABLE_MODELS,
  DEFAULT_ROUTING_MODEL,
  extractJsonObject,
  readUsage,
  totalTokens,
} from '../supabase/functions/_shared/anthropic'
import { MODEL_REGISTRY, modelById } from '../src/ai/models'
import { findChromeNode } from '../src/lib/content/chrome'

/**
 * The hosted routing path (tl-23), at the seams a unit test can reach.
 *
 * What is NOT here, and where it lives instead: the Edge Function's refusals run
 * against the deployed function in `scripts/tl23-hosted-routing.mjs`, and the
 * ceiling arithmetic runs against the live RPC in `scripts/tl23-schema-checks.mjs`
 * — SQL is tested where SQL runs. What is testable here is everything that fails
 * silently: a forked prompt, a registry the server's allowlist has drifted from,
 * an extraction that loses an observation whose quote contains a brace, a token
 * sum that forgets the cache fields (tl-21's factor-of-sixty), and a provider
 * that reports spend twice.
 */

// ---------------------------------------------------------------------------
// The generated prompt bundle: one text, by construction and by tripwire.
// ---------------------------------------------------------------------------

describe('the Edge Function routes on the same prompt the relay uses', () => {
  const bundlePath = path.resolve(__dirname, '../supabase/functions/_shared/relayPrompts.gen.mjs')

  it('the committed bundle matches a fresh build of the chain', async () => {
    // An edit to relayPrompts.ts (or anything in its chain) without
    // `npm run bundle:relay-prompts` fails here instead of quietly forking the
    // prompt the server routes on.
    const { buildRelayPromptsBundle } = await import('../scripts/bundle-relay-prompts.mjs')
    const fresh = await buildRelayPromptsBundle()
    const committed = readFileSync(bundlePath, 'utf8')
    expect(committed).toBe(fresh)
  })

  it('renders byte-identical routing prompts from both copies', async () => {
    const bundled = await import(/* @vite-ignore */ bundlePath)
    const source = await import('../src/ai/relayPrompts')
    const { DEFAULT_SCALE } = await import('../src/lib/scale')
    expect(bundled.relayRoutingSystem(bundled.DEFAULT_SCALE)).toBe(
      source.relayRoutingSystem(DEFAULT_SCALE),
    )
    expect(bundled.relayRoutingPrompt('{"x":1}')).toBe(source.relayRoutingPrompt('{"x":1}'))
  })

  it("carries the schema id the import boundary actually accepts, not a retyped one", () => {
    const operations = readFileSync(path.resolve(__dirname, '../src/routing/operations.ts'), 'utf8')
    const id = operations.match(/export const OBSERVATIONS_BUNDLE_SCHEMA_ID = '([^']+)'/)?.[1]
    expect(id).toBeTruthy()
    expect(readFileSync(bundlePath, 'utf8')).toContain(`"${id}"`)
  })

  it('reaches the server free of the client-only module graph', () => {
    const text = readFileSync(bundlePath, 'utf8')
    for (const forbidden of ['dexie', 'Dexie', 'supabase', 'localStorage', 'indexedDB']) {
      expect(text, `bundle must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// The model allowlist: the server's list and the registry cannot drift apart.
// ---------------------------------------------------------------------------

describe('the model allowlist', () => {
  it('is exactly the registry’s Anthropic entries', () => {
    const registryAnthropicIds = MODEL_REGISTRY.filter((m) => m.provider === 'anthropic').map(
      (m) => m.id,
    )
    expect([...ANTHROPIC_CALLABLE_MODELS].sort()).toEqual([...registryAnthropicIds].sort())
  })

  it('marks every callable model reachable in hosted-api mode', () => {
    for (const id of ANTHROPIC_CALLABLE_MODELS) {
      expect(modelById(id)?.reachable_in, id).toContain('hosted-api')
    }
  })

  it('defaults to Joshua’s stated choice, and the default is callable', () => {
    expect(DEFAULT_ROUTING_MODEL).toBe('claude-sonnet-5')
    expect(ANTHROPIC_CALLABLE_MODELS).toContain(DEFAULT_ROUTING_MODEL)
  })

  it('refuses what it does not know how to call', () => {
    const list = ANTHROPIC_CALLABLE_MODELS as readonly string[]
    expect(list.includes('gemini-2.5-flash-lite')).toBe(false)
    expect(list.includes('claude-sonnet-5-20260101')).toBe(false)
    expect(list.includes('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Extraction: the relay's rule — fence, bare, or buried, never assumed.
// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  const obj = '{"schema":"x","results":[{"capture_client_id":"c1","observations":[]}]}'

  it('takes a bare object whole', () => {
    expect(extractJsonObject(obj)).toBe(obj)
  })

  it('strips a fence, with or without the language tag', () => {
    expect(extractJsonObject('```json\n' + obj + '\n```')).toBe(obj)
    expect(extractJsonObject('```\n' + obj + '\n```')).toBe(obj)
  })

  it('finds the object inside prose', () => {
    expect(extractJsonObject(`Here are the results:\n${obj}\nLet me know!`)).toBe(obj)
  })

  it('is not fooled by braces and escapes inside strings', () => {
    // An observation's quote can legally contain every brace there is.
    const tricky = '{"quote":"he said \\"use { and } freely\\" today","n":1}'
    expect(extractJsonObject(`reply: ${tricky} end`)).toBe(tricky)
    expect(JSON.parse(extractJsonObject(tricky) as string).quote).toContain('{ and }')
  })

  it('skips a non-JSON brace group and finds the real object behind it', () => {
    // "I routed {this} capture: {...}" — the first balanced group is not JSON,
    // and an extractor that stops there loses a perfectly good reply.
    expect(extractJsonObject(`I routed {this} capture: ${obj}`)).toBe(obj)
    // A fenced non-JSON example followed by the real object outside the fence.
    expect(extractJsonObject('```\n{not json}\n```\n' + obj)).toBe(obj)
  })

  it('returns null when there is no object to find', () => {
    expect(extractJsonObject('I could not route these captures.')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('{"unclosed": true')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Usage: four fields, kept apart, all counted. tl-21 was wrong by a factor of
// sixty because input_tokens excludes the cache read; these pins are the scar.
// ---------------------------------------------------------------------------

describe('usage accounting', () => {
  it('reads all four fields and keeps the cache pair separate', () => {
    const usage = readUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 500,
    })
    expect(usage).toEqual({
      tokens_in: 100,
      tokens_out: 20,
      cache_read_tokens: 3000,
      cache_write_tokens: 500,
    })
  })

  it('reports absent or malformed fields as null, never zero', () => {
    // Null is "not reported"; zero is a claim. The trace columns are nullable for
    // exactly this distinction.
    expect(readUsage({})).toEqual({
      tokens_in: null,
      tokens_out: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    })
    expect(readUsage(undefined).tokens_in).toBeNull()
    expect(readUsage({ input_tokens: 'lots' }).tokens_in).toBeNull()
  })

  it('sums all four fields for the ceiling, with nulls as zero', () => {
    expect(
      totalTokens({ tokens_in: 100, tokens_out: 20, cache_read_tokens: 3000, cache_write_tokens: 500 }),
    ).toBe(3620)
    expect(
      totalTokens({ tokens_in: null, tokens_out: 20, cache_read_tokens: null, cache_write_tokens: null }),
    ).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// The client fan-out, with the network and the store mocked at their seams.
// ---------------------------------------------------------------------------

const invoke = vi.fn()
vi.mock('../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}))

const buildExportBundle = vi.fn()
const importObservationsText = vi.fn()
vi.mock('../src/routing/operations', () => ({
  // The literal is pinned to the source of truth by the bundle test above.
  OBSERVATIONS_BUNDLE_SCHEMA_ID: 'cairn.observations-bundle/v1',
  buildExportBundle: (...args: unknown[]) => buildExportBundle(...args),
  importObservationsText: (...args: unknown[]) => importObservationsText(...args),
}))

const getAiConfig = vi.fn()
vi.mock('../src/db/aiConfig', () => ({
  getAiConfig: (...args: unknown[]) => getAiConfig(...args),
  hostedAiEnabled: () => true,
}))

const file = (id: string) => ({ capture_client_id: id, observations: [] })
const bundleOf = (...ids: string[]) =>
  JSON.stringify({ schema: 'cairn.capture-bundle/v1', captures: ids.map((id) => ({ capture_client_id: id })) })

/** A FunctionsHttpError as supabase-js delivers one: message generic, body in context. */
const httpError = (status: number, body: Record<string, unknown>) => ({
  message: 'Edge Function returned a non-2xx status code',
  context: new Response(JSON.stringify(body), { status }),
})

describe('routeCapturesHosted', () => {
  beforeEach(() => {
    invoke.mockReset()
    buildExportBundle.mockReset()
    importObservationsText.mockReset()
    getAiConfig.mockReset()
    importObservationsText.mockResolvedValue({ files: 0, stored: 0, rejected: 0, shared: 0 })
  })

  it('refuses when nothing is pending, before any network call', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf(), count: 0 })
    const outcome = await routeCapturesHosted('w1')
    expect(outcome).toEqual({ kind: 'refused', reason: 'setup.ai.hosted.nothing-pending' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('routes, imports once, and reports null token counts', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1', 'c2'), count: 2 })
    invoke.mockResolvedValueOnce({ data: { observations_file: file('c1'), model: 'claude-sonnet-5' } })
    invoke.mockResolvedValueOnce({ data: { observations_file: file('c2'), model: 'claude-sonnet-5' } })
    importObservationsText.mockResolvedValue({ files: 2, stored: 5, rejected: 1, shared: 5 })

    const outcome = await routeCapturesHosted('w1')
    expect(outcome.kind).toBe('result')
    expect(outcome.value).toEqual({ captures: 2, routed: 2, failed: 0, stored: 5, rejected: 1, shared: 5 })
    expect(outcome.model).toBe('claude-sonnet-5')
    // THE PIN THE SPEC ASKS FOR: the Edge Function is the only writer of the token
    // counts. A number here would sit beside the server's rows as a second copy of
    // the same spend, reading to an administrator as having spent twice.
    expect(outcome.tokensIn).toBeNull()
    expect(outcome.tokensOut).toBeNull()
    // One bundle through the import boundary, in the shape it already accepts.
    expect(importObservationsText).toHaveBeenCalledTimes(1)
    const imported = JSON.parse(importObservationsText.mock.calls[0][0] as string)
    expect(imported.schema).toBe('cairn.observations-bundle/v1')
    expect(imported.results).toHaveLength(2)
  })

  it('sends one capture per invocation, addressed to the workshop', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1', 'c2'), count: 2 })
    invoke.mockResolvedValue({ data: { observations_file: file('c1'), model: 'm' } })
    await routeCapturesHosted('w1')
    expect(invoke).toHaveBeenCalledTimes(2)
    for (const call of invoke.mock.calls) {
      expect(call[0]).toBe('route-captures')
      const body = (call[1] as { body: { workshop_id: string; capture: unknown } }).body
      expect(body.workshop_id).toBe('w1')
      expect(body.capture).toHaveProperty('capture_client_id')
    }
  })

  it('reports partial success honestly: routed N of M, failures stay pending', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1', 'c2', 'c3'), count: 3 })
    invoke.mockResolvedValueOnce({ data: { observations_file: file('c1'), model: 'm' } })
    invoke.mockResolvedValueOnce({ error: httpError(502, { error: 'Anthropic request failed (529)' }) })
    invoke.mockResolvedValueOnce({ data: { observations_file: file('c3'), model: 'm' } })
    importObservationsText.mockResolvedValue({ files: 2, stored: 4, rejected: 0, shared: 4 })

    const outcome = await routeCapturesHosted('w1')
    expect(outcome.kind).toBe('result')
    expect(outcome.value).toMatchObject({ captures: 3, routed: 2, failed: 1 })
  })

  it('accepts the bundle-wrapped reply the routing prompt actually instructs', async () => {
    // relayRoutingSystem tells the model to return {schema, results: [...]} even
    // for one capture, so the WRAPPER is the expected shape and the bare file is
    // the tolerated one. The first draft only accepted the bare shape and would
    // have failed every keyed run while spending the tokens (stage-6 finding #1).
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1'), count: 1 })
    invoke.mockResolvedValueOnce({
      data: {
        observations_file: { schema: 'cairn.observations-bundle/v1', results: [file('c1')] },
        model: 'claude-sonnet-5',
      },
    })
    importObservationsText.mockResolvedValue({ files: 1, stored: 3, rejected: 0, shared: 3 })
    const outcome = await routeCapturesHosted('w1')
    expect(outcome.kind).toBe('result')
    expect(outcome.value).toMatchObject({ routed: 1, failed: 0, stored: 3 })
    const imported = JSON.parse(importObservationsText.mock.calls[0][0] as string)
    expect(imported.results).toEqual([file('c1')])
  })

  it('recovers an observations file the server returned as raw text', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1'), count: 1 })
    invoke.mockResolvedValueOnce({ data: { raw: JSON.stringify(file('c1')), model: 'm' } })
    importObservationsText.mockResolvedValue({ files: 1, stored: 2, rejected: 0, shared: 2 })
    const outcome = await routeCapturesHosted('w1')
    expect(outcome.kind).toBe('result')
    expect(outcome.value).toMatchObject({ routed: 1, failed: 0 })
  })

  it('ends the run on a deployment-wide refusal instead of rediscovering it per capture', async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1', 'c2', 'c3'), count: 3 })
    invoke.mockResolvedValue({
      error: httpError(403, {
        error: 'This deployment has spent its daily AI token allowance.',
        reason: 'tl23.daily_token_ceiling_reached',
      }),
    })
    const outcome = await routeCapturesHosted('w1')
    expect(outcome).toEqual({ kind: 'refused', reason: 'setup.ai.hosted.ceiling-reached' })
    // The first call learned the answer; the fan-out never started.
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(importObservationsText).not.toHaveBeenCalled()
  })

  it("surfaces the server's own sentence for a permission refusal", async () => {
    const { routeCapturesHosted } = await import('../src/ai/hostedRouting')
    buildExportBundle.mockResolvedValue({ json: bundleOf('c1'), count: 1 })
    invoke.mockResolvedValue({
      error: httpError(403, {
        error: 'You do not administer that workshop, so you cannot spend its AI budget.',
        reason: 'tl13.not_an_admin_of_this_workshop',
      }),
    })
    const outcome = await routeCapturesHosted('w1')
    expect(outcome.kind).toBe('error')
    expect(outcome.reason).toMatch(/do not administer/)
  })
})

// ---------------------------------------------------------------------------
// The provider's routing branch: refusals before any network call.
// ---------------------------------------------------------------------------

describe('hostedApiProvider routing', () => {
  beforeEach(() => {
    invoke.mockReset()
    buildExportBundle.mockReset()
    getAiConfig.mockReset()
    getAiConfig.mockResolvedValue({ mode: 'hosted-api', functions: {} })
  })

  const job = (intent: 'copy' | 'push' | 'run') =>
    ({ fn: 'observation_routing', workshopId: 'w1', intent }) as const

  it('refuses push with a reason naming the limitation', async () => {
    const { hostedApiProvider } = await import('../src/ai/providers/hostedApi')
    const outcome = await hostedApiProvider.run(job('push'))
    expect(outcome).toEqual({ kind: 'refused', reason: 'setup.ai.hosted.never-pushes' })
  })

  it('refuses a stored model this path cannot reach, rather than silently substituting', async () => {
    const { hostedApiProvider } = await import('../src/ai/providers/hostedApi')
    // Gemini is reachable in this MODE (scenario drafting) and not on this PATH:
    // route-captures calls Anthropic models only.
    getAiConfig.mockResolvedValue({
      mode: 'hosted-api',
      functions: { observation_routing: { enabled: true, model: 'gemini-2.5-flash-lite' } },
    })
    const outcome = await hostedApiProvider.run(job('run'))
    expect(outcome).toEqual({ kind: 'refused', reason: 'setup.ai.hosted.model-unreachable' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('accepts a stored Claude model and proceeds to the fan-out', async () => {
    const { hostedApiProvider } = await import('../src/ai/providers/hostedApi')
    getAiConfig.mockResolvedValue({
      mode: 'hosted-api',
      functions: { observation_routing: { enabled: true, model: 'claude-sonnet-5' } },
    })
    buildExportBundle.mockResolvedValue({ json: bundleOf(), count: 0 })
    const outcome = await hostedApiProvider.run(job('run'))
    expect(outcome).toEqual({ kind: 'refused', reason: 'setup.ai.hosted.nothing-pending' })
  })

  it('hands the copy intent back as the bundle even when the stored model is Gemini', async () => {
    // The hand-off calls no model, so the model check must not gate it — the
    // registry itself recommends Gemini Flash-Lite for routing on unit cost.
    const { hostedApiProvider } = await import('../src/ai/providers/hostedApi')
    getAiConfig.mockResolvedValue({
      mode: 'hosted-api',
      functions: { observation_routing: { enabled: true, model: 'gemini-2.5-flash-lite' } },
    })
    buildExportBundle.mockResolvedValue({ json: '{"captures":[1]}', count: 1 })
    const outcome = await hostedApiProvider.run(job('copy'))
    expect(outcome.kind).toBe('operator_action')
    expect(outcome.instructionsId).toBe('setup.ai.op.fallback-prompt')
    expect(outcome.prompt).toBe('{"captures":[1]}')
    expect(outcome.value).toEqual({ count: 1 })
  })
})

// ---------------------------------------------------------------------------
// The copy: every id this spec writes resolves, and the sentence tl-23 made
// false is actually gone.
// ---------------------------------------------------------------------------

describe('the strings', () => {
  it('has a node for every id the hosted routing path can show', () => {
    for (const id of [
      'setup.ai.hosted.nothing-pending',
      'setup.ai.hosted.never-pushes',
      'setup.ai.hosted.model-unreachable',
      'setup.ai.hosted.ceiling-reached',
      'setup.ai.hosted.no-key',
      'routing.hosted.title',
      'routing.hosted.intro',
      'routing.hosted.run',
      'routing.hosted.working',
      'routing.hosted.result',
    ]) {
      expect(findChromeNode(id)?.label, id).toBeTruthy()
    }
  })

  it('no longer claims routing has no hosted endpoint', () => {
    expect(findChromeNode('routing.mode.hosted-api')?.label).not.toMatch(/no hosted endpoint/i)
    expect(findChromeNode('setup.ai.mode.hosted-api-limit')?.label).not.toMatch(
      /only the scenario draft-fill/i,
    )
  })

  it('the partial report carries every count it promises', () => {
    const label = findChromeNode('routing.hosted.result')?.label ?? ''
    for (const token of ['{captures}', '{routed}', '{failed}', '{stored}', '{rejected}', '{shared}']) {
      expect(label).toContain(token)
    }
  })
})
