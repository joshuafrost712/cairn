import { describe, it, expect } from 'vitest'
import { validateScenarioDraft, type ScenarioDraft } from '../src/ai/scenarioContract'
import { parseDraftReply } from '../src/ai/scenarioDraft'

const good: ScenarioDraft = {
  workshop: { name: 'Test Workshop' },
  activities: [{ title: 'Morning teaching', sort_order: 0 }],
  ksas: [
    {
      code: 'EXEG',
      area: 'Exegesis',
      short_label: 'Exegesis',
      evaluator_facing_prompt: 'How did they handle the source text?',
      evidence_levels: { '0': 'none', '1': 'weak', '2': 'solid', '3': 'strong' },
      guiding_questions: ['Did they check the meaning?'],
    },
  ],
  wiring: [{ activity_title: 'Morning teaching', ksa_codes: ['EXEG'] }],
}

describe('validateScenarioDraft', () => {
  it('accepts a well-formed draft', () => {
    const r = validateScenarioDraft(good)
    expect(r.ok).toBe(true)
  })

  it('rejects a non-object', () => {
    expect(validateScenarioDraft('nope').ok).toBe(false)
    expect(validateScenarioDraft(null).ok).toBe(false)
  })

  it('rejects an activity without a title', () => {
    const r = validateScenarioDraft({ ...good, activities: [{ sort_order: 0 }] })
    expect(r.ok).toBe(false)
  })

  it('rejects a ksa missing required fields', () => {
    const r = validateScenarioDraft({ ...good, ksas: [{ code: 'X' }] })
    expect(r.ok).toBe(false)
  })

  it('rejects wiring that references an unknown activity title', () => {
    const r = validateScenarioDraft({
      ...good,
      wiring: [{ activity_title: 'Nonexistent', ksa_codes: ['EXEG'] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown activity/)
  })

  it('rejects wiring that references an unknown ksa code', () => {
    const r = validateScenarioDraft({
      ...good,
      wiring: [{ activity_title: 'Morning teaching', ksa_codes: ['GHOST'] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown ksa/)
  })
})

describe('parseDraftReply', () => {
  it('parses a bare JSON reply', () => {
    const r = parseDraftReply(JSON.stringify(good))
    expect(r.ok).toBe(true)
  })

  it('recovers JSON wrapped in a markdown code fence', () => {
    const r = parseDraftReply('```json\n' + JSON.stringify(good) + '\n```')
    expect(r.ok).toBe(true)
  })

  it('recovers JSON with surrounding prose', () => {
    const r = parseDraftReply('Here is your scenario:\n' + JSON.stringify(good) + '\nHope that helps!')
    expect(r.ok).toBe(true)
  })

  it('fails gracefully on non-JSON', () => {
    const r = parseDraftReply('I could not do that.')
    expect(r.ok).toBe(false)
  })
})
