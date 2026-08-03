import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AI_FUNCTION_BUILT,
  AI_FUNCTION_DEFAULTS,
  AI_FUNCTIONS,
  AI_MODES,
  defaultAiConfig,
  functionsValue,
  modeUnavailableReason,
  resolveAiConfig,
  type AiConfigRow,
} from '../src/lib/aiConfig'
import { aiEnabled, aiUnavailableReason, BUILT_AI_FUNCTIONS } from '../src/ai/aiEnabled'
import { findChromeNode } from '../src/lib/content/chrome'

/**
 * tl-13's decisions, isolated from their IO.
 *
 * The permission itself is server-side and is verified over HTTP against the deployed
 * function (scripts/tl13-function-tests.mjs), because a check the client performs
 * cannot be proved by the client. What is testable here is everything that would fail
 * SILENTLY: a default that quietly turns a live feature off, a stored value this build
 * cannot service being believed, an unbuilt function reporting itself as working, and
 * the two copies of the default map — TypeScript's and Postgres's — drifting apart.
 */

const row = (over: Partial<AiConfigRow> = {}): AiConfigRow => ({
  workshop_id: 'w1',
  mode: 'github-claude',
  functions: {},
  ...over,
})

describe('the defaults', () => {
  it('leaves the two functions the app already depends on switched on', () => {
    // The spec says "off by default except observation routing". Scenario draft-fill
    // is on for the same stated reason — it is a live, working button today — and
    // defaulting it off would have failed this spec's own regression criterion on
    // every existing workshop, all of which have no ai_config row.
    const config = defaultAiConfig('w1')
    expect(aiEnabled('observation_routing', config)).toBe(true)
    expect(aiEnabled('scenario_draft', config)).toBe(true)
  })

  it('leaves the three unbuilt functions off', () => {
    const config = defaultAiConfig('w1')
    expect(aiEnabled('narrative_prose', config)).toBe(false)
    expect(aiEnabled('email_drafting', config)).toBe(false)
    expect(aiEnabled('conversation_guidance', config)).toBe(false)
  })

  it('starts a workshop on the mode that spends nothing', () => {
    expect(defaultAiConfig('w1').mode).toBe('github-claude')
  })

  it('behaves identically for a workshop with no row at all', () => {
    // The load-bearing regression: "a workshop with no configuration behaves as
    // today" is the spec's own acceptance line, and every existing workshop is in
    // exactly that state.
    expect(resolveAiConfig('w1', [])).toEqual(defaultAiConfig('w1'))
  })
})

describe('aiEnabled', () => {
  it('refuses an unbuilt function even when the stored value says on', () => {
    // A newer client could switch something on that this build has no code for.
    // Attempting it would fail somewhere less honest than here.
    const config = resolveAiConfig('w1', [
      row({ functions: { narrative_prose: { enabled: true, model: null } } }),
    ])
    expect(config.functions.narrative_prose.enabled).toBe(true)
    expect(aiEnabled('narrative_prose', config)).toBe(false)
    expect(aiUnavailableReason('narrative_prose', config)).toBe('setup.ai.fn.not-built')
  })

  it('distinguishes "switched off" from "not built"', () => {
    const off = resolveAiConfig('w1', [
      row({ functions: { scenario_draft: { enabled: false, model: null } } }),
    ])
    expect(aiUnavailableReason('scenario_draft', off)).toBe('setup.ai.fn.disabled')
    expect(aiUnavailableReason('observation_routing', off)).toBeNull()
  })

  it('names only functions this build can actually service', () => {
    expect(BUILT_AI_FUNCTIONS).toEqual([
      'observation_routing',
      'scenario_draft',
      'conversation_guidance',
    ])
  })
})

describe('resolveAiConfig', () => {
  it('ignores a row belonging to another workshop', () => {
    // A configuration silently assembled from another workshop's row would decide
    // where THIS workshop's evidence gets sent, and nothing on screen would look wrong.
    const other = row({ workshop_id: 'w2', mode: 'byo-agent' })
    expect(resolveAiConfig('w1', [other]).mode).toBe('github-claude')
  })

  it('falls back to the default mode when the stored one is not one it can service', () => {
    expect(resolveAiConfig('w1', [row({ mode: 'quantum-oracle' })]).mode).toBe('github-claude')
  })

  it('drops an unknown function key rather than storing it', () => {
    const config = resolveAiConfig('w1', [
      row({ functions: { telepathy: { enabled: true }, scenario_draft: { enabled: false } } }),
    ])
    expect(Object.keys(config.functions).sort()).toEqual([...AI_FUNCTIONS].sort())
    expect(config.functions.scenario_draft.enabled).toBe(false)
  })

  it('takes the default for a malformed entry instead of reading it as off', () => {
    for (const bad of [null, 'yes', 42, [], { enabled: 'yes' }]) {
      const config = resolveAiConfig('w1', [row({ functions: { observation_routing: bad } }) ])
      expect(config.functions.observation_routing.enabled).toBe(true)
    }
  })

  it('reads a model only when it is a non-empty string', () => {
    const config = resolveAiConfig('w1', [
      row({
        functions: {
          scenario_draft: { enabled: true, model: '  gemini-2.5-flash  ' },
          observation_routing: { enabled: true, model: '   ' },
        },
      }),
    ])
    expect(config.functions.scenario_draft.model).toBe('gemini-2.5-flash')
    expect(config.functions.observation_routing.model).toBeNull()
  })

  it('round-trips through functionsValue with every function named', () => {
    const config = resolveAiConfig('w1', [row({ functions: { scenario_draft: { enabled: false } } })])
    const stored = functionsValue(config)
    expect(Object.keys(stored).sort()).toEqual([...AI_FUNCTIONS].sort())
    expect(resolveAiConfig('w1', [row({ functions: stored })])).toEqual(config)
  })
})

describe('mode availability', () => {
  it('never blocks the two modes that spend nothing', () => {
    for (const mode of AI_MODES.filter((m) => m !== 'hosted-api')) {
      expect(
        modeUnavailableReason(mode, { supabaseConfigured: false, hostedAiEnabled: false }),
      ).toBeNull()
    }
  })

  it('blames the missing backend before the deployment switch', () => {
    // Order matters for the sentence a person reads: with no backend at all, "the
    // owner has not enabled this" would send them to ask the wrong question.
    expect(
      modeUnavailableReason('hosted-api', { supabaseConfigured: false, hostedAiEnabled: true }),
    ).toBe('setup.ai.mode.hosted-needs-backend')
    expect(
      modeUnavailableReason('hosted-api', { supabaseConfigured: true, hostedAiEnabled: false }),
    ).toBe('setup.ai.mode.hosted-not-enabled-here')
    expect(
      modeUnavailableReason('hosted-api', { supabaseConfigured: true, hostedAiEnabled: true }),
    ).toBeNull()
  })
})

describe('every reason and label this layer can produce has words', () => {
  // Same failure mode setupCopy.test.ts exists for: `c()` returns the ID when a node
  // is missing, so a forgotten string puts `setup.ai.fn.not-built` on screen inside
  // the sentence that was supposed to explain why a control is dead.
  const ids = [
    'setup.ai.fn.not-built',
    'setup.ai.fn.disabled',
    'setup.ai.mode.hosted-needs-backend',
    'setup.ai.mode.hosted-not-enabled-here',
    ...AI_MODES.flatMap((m) => [
      `setup.ai.mode.${m}`,
      `setup.ai.mode.${m}-detail`,
      `setup.ai.mode.${m}-limit`,
      `setup.ai.draft.mode-note.${m}`,
    ]),
    ...AI_FUNCTIONS.flatMap((fn) => [`setup.ai.fn.${fn}`, `setup.ai.fn.${fn}-help`]),
  ]
  it.each(ids)('%s exists', (id) => {
    expect(findChromeNode(id), id).toBeDefined()
  })
})

describe('the two copies of the default map agree', () => {
  /**
   * `ai_call_permitted()` in the migration hardcodes which functions default to on,
   * because an Edge Function cannot import this module. That duplication is
   * deliberate and it is exactly the kind that rots: the client would go on saying a
   * function is available while the server refused it, or worse, the reverse.
   *
   * So this reads the migration and asserts the two lists match. Cheap, and it fails
   * on the commit that introduces the drift rather than in a workshop.
   */
  const sql = readFileSync('supabase/migrations/20260802000100_ai_config.sql', 'utf8')

  it('names the same functions as on-by-default in SQL as in TypeScript', () => {
    const onByDefault = AI_FUNCTIONS.filter((fn) => AI_FUNCTION_DEFAULTS[fn])
    // The line in ai_call_permitted() that supplies the fallback.
    const match = sql.match(/_function in \(([^)]*)\)\s*\n?\s*\);/)
    expect(match, 'the default-on list in ai_call_permitted() moved').toBeTruthy()
    const namedInSql = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(namedInSql).toEqual([...onByDefault].sort())
  })

  it('declares every function this build knows in the SQL shape check', () => {
    for (const fn of AI_FUNCTIONS) {
      expect(sql.includes(`'${fn}'`), `${fn} is missing from the migration`).toBe(true)
    }
  })

  it('keeps the built list honest against the providers that exist', () => {
    // AI_FUNCTION_BUILT is a claim about code, and the claim is checkable: a function
    // marked built with no provider handling it would show a working switch over
    // nothing at all.
    expect(AI_FUNCTIONS.filter((fn) => AI_FUNCTION_BUILT[fn])).toEqual(BUILT_AI_FUNCTIONS)
  })
})
