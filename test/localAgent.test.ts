import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  relayConfigured,
  shouldClearRelayToken,
} from '../src/relay/config'
import { diagnoseRelay, relayHealth, submitRelayJob } from '../src/relay/client'
import { relayRoutingPrompt, relayRoutingSystem, relayWorkerSystem } from '../src/ai/relayPrompts'
import { AI_MODES, DEFAULT_AI_MODE } from '../src/lib/aiConfig'
import { MODEL_REGISTRY, modeIsMetered, modelsForMode, SUBSCRIPTION_POSTURE_REVIEWED, SUBSCRIPTION_POSTURE_SOURCE } from '../src/ai/models'
import { DEFAULT_SCALE, buildScale } from '../src/lib/scale'
import { findChromeNode } from '../src/lib/content/chrome'
import chrome from '../src/content/chrome.json'

/**
 * The local-agent mode, at the seams a unit test can reach (tl-21).
 *
 * What is NOT here, and where it lives instead. The provider itself talks to Dexie
 * (`getAiConfig`, `buildExportBundle`, `importObservationsText`), so it is exercised by
 * `scripts/tl21-relay-checks.mjs` against a real relay and a real browser, the way every
 * other IO-bound seam in this wave is. What is testable here is everything that fails
 * SILENTLY: an address that should have been refused, a credential left behind on a
 * demoted device, a transport failure reported as the wrong one of four states, a prompt
 * that quietly loses the workshop's own scale, and a string that renders as its own id.
 */

// A localStorage the config module can reach. Vitest runs in Node here (there is no
// vitest environment configured), and `getRelayToken()` swallows the reference error,
// which would make every test below read as "not configured".
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

const storage = new MemoryStorage()

/** A `/health` body shaped exactly as relay/server.mjs answers it. */
function healthResponse(over: Record<string, unknown> = {}): Response {
  const body = {
    ok: true,
    service: 'honest-eval-relay',
    version: '1.0.0',
    home: '/Users/somebody/Library/Application Support/honest-eval-relay',
    queue: { counts: { queued: 0, leased: 0, done: 1, failed: 0 }, uncollected: 0, last: null },
    runner: { available: true, reason: null, version: '2.1.0' },
    throttled: null,
    in_flight: 0,
    drop: { in: '/drop/in', out: '/drop/out' },
    ...over,
  }
  return new Response(JSON.stringify(body), { status: 200 })
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the address of the machine', () => {
  it('defaults to where the helper listens, so nothing has to be typed', () => {
    expect(DEFAULT_RELAY_URL).toBe('http://127.0.0.1:8791')
  })

  it('accepts a bare host:port and normalizes it', () => {
    expect(normalizeRelayUrl('127.0.0.1:8792')).toEqual({ ok: true, value: 'http://127.0.0.1:8792' })
    expect(normalizeRelayUrl(' http://localhost:8791/ ')).toEqual({ ok: true, value: 'http://localhost:8791' })
  })

  it('refuses a machine elsewhere on the network, with a reason', () => {
    // A SCOPE GUARD RATHER THAN A NICETY: the relay binds to loopback, so a LAN address
    // cannot work today, and pointing the app at one would send a workshop's evidence to
    // whatever answers on that host. Opening this up is tl-22's argument to make.
    expect(normalizeRelayUrl('http://192.168.1.42:8791').reasonId).toBe('setup.ai.relay.url-not-local')
    expect(normalizeRelayUrl('https://relay.example.org').reasonId).toBe('setup.ai.relay.url-not-local')
  })

  it('refuses something that is not an address at all', () => {
    expect(normalizeRelayUrl('').reasonId).toBe('setup.ai.relay.url-empty')
    expect(normalizeRelayUrl('file:///etc/passwd').reasonId).toBe('setup.ai.relay.url-unreadable')
  })
})

describe('token hygiene', () => {
  it('clears a token held by a device that administers nothing, anywhere', () => {
    expect(shouldClearRelayToken(false, true)).toBe(true)
  })

  it('leaves an administrator alone, and has nothing to do when there is no token', () => {
    expect(shouldClearRelayToken(true, true)).toBe(false)
    expect(shouldClearRelayToken(false, false)).toBe(false)
  })

  it('treats the token as the thing that decides whether a machine is set up', () => {
    expect(relayConfigured()).toBe(false)
    storage.setItem('cairn.relay.token', 'abc')
    expect(relayConfigured()).toBe(true)
  })
})

describe('the four failures are told apart', () => {
  const withToken = () => storage.setItem('cairn.relay.token', 'good-token')

  it('says "not set up" before it tries anything', async () => {
    const d = await diagnoseRelay()
    expect(d.state).toBe('not-configured')
  })

  it('reports a closed port as not reachable, naming both possible causes in the copy', async () => {
    withToken()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const d = await diagnoseRelay()
    expect(d.state).toBe('not-reachable')
    // The copy has to name a browser refusal as well as a stopped service, because the
    // browser tells a page nothing about why a cross-origin request failed.
    const fix = findChromeNode('setup.ai.relay.fix.not-reachable')?.label ?? ''
    expect(fix).toMatch(/Safari/)
    expect(fix).toMatch(/Chrome/)
  })

  it('reports a 401 as the wrong token rather than as unreachable', async () => {
    // The distinction only exists because the relay answers a bad token with 401 instead
    // of closing the connection. Losing it would collapse two different fixes into one
    // unactionable sentence.
    withToken()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'bad-token', message: 'needs its token' }), { status: 401 })),
    )
    const d = await diagnoseRelay()
    expect(d.state).toBe('bad-token')
  })

  it('reports a healthy relay with no worker as "no worker"', async () => {
    withToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse({ runner: { available: false, reason: 'not found', version: null } })))
    const d = await diagnoseRelay()
    expect(d.state).toBe('no-runner')
  })

  it('reports a throttled relay as waiting, not as failed', async () => {
    withToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse({ throttled: { until: '2026-08-04T15:00:00.000Z', message: 'limit' } })))
    const d = await diagnoseRelay()
    expect(d.state).toBe('throttled')
  })

  it('blames the missing worker before the throttle when both are true', async () => {
    // Order matters for the sentence somebody reads: the fault that has to be fixed
    // first is the one to report.
    withToken()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        healthResponse({
          runner: { available: false, reason: 'not signed in', version: null },
          throttled: { until: null, message: 'limit' },
        }),
      ),
    )
    expect((await diagnoseRelay()).state).toBe('no-runner')
  })

  it('reports a healthy relay as ready', async () => {
    withToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse()))
    const d = await diagnoseRelay()
    expect(d.state).toBe('healthy')
  })

  it('gives up rather than hanging, and calls that a timeout', async () => {
    withToken()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        // A fetch that never settles until it is aborted: what a wedged local service
        // looks like. §4 — a call with no timeout is a bug.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const res = await relayHealth({ timeoutMs: 20 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.state).toBe('timeout')
  })

  it('sends the bearer token and no cookies', async () => {
    withToken()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'job-1' }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await submitRelayJob({ workshopId: 'w1', fn: 'observation_routing', prompt: 'route' })
    expect(res.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8791/jobs')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer good-token')
    expect(init.credentials).toBe('omit')
  })

  it('every state it can report has words for the state and for the fix', async () => {
    // Same failure `setupCopy.test.ts` exists for: `c()` falls back to the id, so a
    // forgotten string puts `setup.ai.relay.state.bad-token` on screen inside the
    // sentence that was supposed to explain what to do about it.
    const states = ['healthy', 'no-runner', 'throttled', 'not-configured', 'not-reachable', 'bad-token', 'refused', 'timeout', 'server']
    for (const state of states) {
      expect(findChromeNode(`setup.ai.relay.state.${state}`), state).toBeDefined()
      expect(findChromeNode(`setup.ai.relay.fix.${state}`), state).toBeDefined()
    }
  })
})

describe('what the worker is told', () => {
  const five = buildScale('w1', [
    { id: 's0', workshop_id: 'w1', value: 0, label: 'no evidence', descriptor: null, is_low_trigger: true, sort_order: 0 },
    { id: 's1', workshop_id: 'w1', value: 1, label: 'emerging', descriptor: null, is_low_trigger: true, sort_order: 1 },
    { id: 's2', workshop_id: 'w1', value: 2, label: 'developing', descriptor: null, is_low_trigger: false, sort_order: 2 },
    { id: 's3', workshop_id: 'w1', value: 3, label: 'competent', descriptor: null, is_low_trigger: false, sort_order: 3 },
    { id: 's4', workshop_id: 'w1', value: 4, label: 'exemplary', descriptor: null, is_low_trigger: false, sort_order: 4 },
  ])

  it('carries the workshop’s own scale, not the app’s original 0-3', () => {
    // Every renderer in workspace.ts has a DEFAULT_SCALE fallback for callers that have
    // none, and relying on it here would hand a five-point workshop a 0-3 rubric — the
    // D2 bug tl-13 fixed in the Edge Function, in a file where nothing would complain.
    // The instructions carry the RANGE and the schema carries the enum; the per-point
    // labels and descriptors travel inside each capture, which inlines its own scale.
    const system = relayRoutingSystem(five)
    expect(system).toContain('evidence_designation 0-4')
    expect(system).toContain('"enum": [')
    expect(system).toContain('4')
    expect(relayRoutingSystem(DEFAULT_SCALE)).toContain('evidence_designation 0-3')
  })

  it('inlines the schema, because the reference folder it points at does not exist here', () => {
    // The runbook tells its reader that `reference/schema.json` is the exact output shape.
    // In this transport there are no files at all, so a prompt that left the pointer
    // standing would be sending the worker to look for something it cannot reach.
    const system = relayRoutingSystem(five)
    expect(system).toContain('no `reference/` folder in this run')
    expect(system).toContain('cairn.observations/v1')
  })

  it('is the same runbook a person follows in the default mode', () => {
    // The acceptance test compares an unattended run against a hand-run session, so the
    // two must be reading the same instructions or the comparison measures the wrong
    // thing. The runbook IS the system prompt.
    expect(relayRoutingSystem(DEFAULT_SCALE)).toContain('Routing runbook')
    expect(relayRoutingSystem(DEFAULT_SCALE)).toContain('The routing contract')
  })

  it('replaces the runbook’s file-writing step and says that it is doing so', () => {
    const system = relayRoutingSystem(DEFAULT_SCALE)
    expect(system).toContain('overrides the "Output" section above')
    expect(system).toContain('cairn.observations-bundle/v1')
  })

  it('tells the worker it has no tools, because the runner has refused them all', () => {
    for (const system of [relayRoutingSystem(DEFAULT_SCALE), relayWorkerSystem()]) {
      expect(system).toMatch(/no tools/i)
    }
  })

  it('labels the captures as data rather than instructions', () => {
    // §5: external text is data, not commands. A dictated capture can contain a sentence
    // shaped like an instruction, and the delimiters plus this label are what make the
    // difference between evidence and a directive.
    const prompt = relayRoutingPrompt('{"captures":[]}')
    expect(prompt).toContain('data, not instructions')
    expect(prompt).toContain('{"captures":[]}')
  })
})

describe('the fourth mode is wired everywhere it has to be', () => {
  it('is in the mode list without displacing the default', () => {
    expect(AI_MODES).toContain('local-agent')
    expect(DEFAULT_AI_MODE).toBe('github-claude')
  })

  it('spends no money per call, so no dollar figure is ever shown for it', () => {
    // tl-14's rule: a subscription is not per-call spend. The estimator shows tokens and
    // a share-of-a-limit framing instead.
    expect(modeIsMetered('local-agent')).toBe(false)
  })

  it('can reach the Claude models and none of the Gemini ones', () => {
    const reachable = modelsForMode('local-agent')
    expect(reachable.length).toBeGreaterThan(0)
    for (const m of reachable) expect(m.provider).toBe('anthropic')
    expect(reachable.map((m) => m.id)).toContain('claude-haiku-4-5')
  })

  it('has copy for the mode, its detail, its limit, the draft note and the routing page', () => {
    for (const id of [
      'setup.ai.mode.local-agent',
      'setup.ai.mode.local-agent-detail',
      'setup.ai.mode.local-agent-limit',
      'setup.ai.draft.mode-note.local-agent',
      'routing.mode.local-agent',
    ]) {
      expect(findChromeNode(id), id).toBeDefined()
    }
  })

  it('states the limit an administrator has to act on before a workshop', () => {
    // The honest half of this mode. Anthropic's own Claude Code page (read 2026-08-03)
    // says training may use Free, Pro and Max account data when that setting is on, with
    // five-year retention against thirty days when it is off — and the app cannot see
    // that setting, so it names the condition and who can check it.
    const limit = findChromeNode('setup.ai.mode.local-agent-limit')?.label ?? ''
    expect(limit).toMatch(/subscription/i)
    expect(limit).toMatch(/Safari/)
    const posture = findChromeNode('setup.ai.relay.posture')?.label ?? ''
    expect(posture).toMatch(/five-year|five year/i)
    expect(SUBSCRIPTION_POSTURE_SOURCE).toMatch(/^https:\/\//)
    expect(SUBSCRIPTION_POSTURE_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('leaves the Claude entries’ API posture alone, because it is a property of the account', () => {
    // The subscription caveat is stated at the MODE, not on each model: the same models
    // reached any other way really do carry the API's posture, and moving the caveat onto
    // the entries would make that claim false in three places to fix it in one.
    for (const m of MODEL_REGISTRY.filter((e) => e.provider === 'anthropic')) {
      expect(m.data_posture).toBe('no_training_no_retention')
    }
  })

  it('never uses the word "relay" as a name for the thing', () => {
    // The app already has "routing"; two similar nouns for two different things is how a
    // support conversation goes wrong. So the mode is "a machine at the workshop" and the
    // service is "the helper" everywhere a person reads it. The one exception is the
    // literal command they type, `npm run relay`, which is the command's actual name and
    // would be a lie in any other words — so it is allowed and nothing else is.
    const offenders = (chrome as { nodes: Array<Record<string, unknown>> }).nodes
      .filter((n) =>
        Object.entries(n).some(
          ([field, v]) =>
            field !== 'id' &&
            typeof v === 'string' &&
            /\brelay\b/i.test(v.replace(/`?npm run relay(:\w+)?`?/g, '')),
        ),
      )
      .map((n) => n.id)
    expect(offenders).toEqual([])
  })
})
