import { describe, it, expect } from 'vitest'
import {
  CLASSIFIED_QUESTION_FIELDS,
  classifySetupChange,
  diffFields,
  observationsCrossingThreshold,
  sameValue,
  type ImpactCounts,
  type SetupChange,
  type WorkshopState,
} from '../src/setup/impact'
import { deriveWorkshopState } from '../src/setup/state'
import { KSA_AREAS, type Ksa } from '../src/lib/types'

/**
 * The change-impact classifier.
 *
 * What is worth pinning here is not that a delete is dangerous; it is the BOUNDARY
 * PAIRS, the ones that are easy to get backwards and that look identical on screen:
 * renaming an event against deleting it, adding an unwired question against rewiring
 * a captured event, editing a guiding question against editing the descriptor it sits
 * under. Each pair is one test, so a change that collapses the distinction fails
 * rather than quietly warning about the wrong thing.
 *
 * The other thing under test is the counts. A dialog whose entire value is that its
 * numbers are real is worthless if a number can go missing, so the tokens are asserted
 * on directly rather than through the rendered sentence.
 */

const IN_PROGRESS: WorkshopState = 'in_progress'

const classify = (change: SetupChange, state: WorkshopState = IN_PROGRESS) =>
  classifySetupChange(change, state)

/** A question as the seed data holds one, for the field-completeness check. */
const question: Ksa = {
  id: 'k1',
  code: 'Q3',
  area: KSA_AREAS[0],
  short_label: 'CLAT facilitation',
  description: 'How the participant runs the CLAT process.',
  evaluator_facing_prompt: 'How did they facilitate?',
  ai_facing_rubric: null,
  evidence_levels: { '0': 'absent', '1': 'weak', '2': 'solid', '3': 'exemplary' },
  cbc_subpoint_refs: [],
  guiding_questions: ['Did they invite the community in?'],
}

/** The spec's own example: 23 observations across 6 participants on one question. */
const HEAVY: ImpactCounts = {
  observations: 23,
  scored: 23,
  participants: 6,
  reports: 6,
  verdicts: 41,
  captures: 9,
  wiredEvents: 2,
}

describe('every field of every entity is classified', () => {
  // The one test that catches the failure this module is most likely to suffer:
  // somebody adds a field to a question and it silently takes the default class.
  it('a question has no field the classifier has never heard of', () => {
    const unclassified = Object.keys(question).filter(
      (field) => !CLASSIFIED_QUESTION_FIELDS.includes(field),
    )
    expect(unclassified).toEqual([])
  })
})

describe('boundary pairs', () => {
  it('renaming an event is safe; deleting one with captures is destructive', () => {
    const rename = classify({
      entity: 'event',
      operation: 'update',
      entityId: 'a1',
      label: 'Day 2 drafting',
      fields: [{ field: 'title', before: 'Day 2', after: 'Day 2 drafting' }],
    })
    expect(rename.severity).toBe('safe')
    expect(rename.silent).toBe(true)

    const remove = classify({
      entity: 'event',
      operation: 'delete',
      entityId: 'a1',
      label: 'Day 2 drafting',
      counts: { captures: 9, observations: 23, participants: 6 },
    })
    expect(remove.severity).toBe('destructive')
    expect(remove.requiresTypedName).toBe(true)
  })

  it('adding an unwired question is safe; rewiring a captured event invalidates evidence', () => {
    const add = classify({
      entity: 'question',
      operation: 'create',
      entityId: 'k9',
      label: 'Q9',
    })
    expect(add.severity).toBe('safe')

    const rewire = classify({
      entity: 'wiring',
      operation: 'update',
      entityId: 'a1',
      label: 'Day 2 drafting',
      fields: [{ field: 'questions', before: ['k1'], after: ['k1', 'k2'] }],
      counts: { captures: 9, observations: 23, participants: 6 },
    })
    expect(rewire.severity).toBe('invalidates_evidence')
    expect(rewire.requiresTypedName).toBe(false)
  })

  it('rewiring an event nobody has captured only affects future work', () => {
    const rewire = classify({
      entity: 'wiring',
      operation: 'update',
      entityId: 'a2',
      label: 'Day 5 checking',
      fields: [{ field: 'questions', before: [], after: ['k1'] }],
      counts: { captures: 0 },
    })
    expect(rewire.severity).toBe('affects_future')
  })

  it('editing a guiding question is safe; editing the descriptor under it is not', () => {
    const guiding = classify({
      entity: 'question',
      operation: 'update',
      entityId: 'k1',
      label: 'Q3',
      fields: [{ field: 'guiding_questions', before: ['a'], after: ['a', 'b'] }],
      counts: HEAVY,
    })
    expect(guiding.severity).toBe('safe')

    const descriptor = classify({
      entity: 'question',
      operation: 'update',
      entityId: 'k1',
      label: 'Q3',
      fields: [
        { field: 'evidence_levels', before: { '2': 'solid' }, after: { '2': 'solid and cited' } },
      ],
      counts: HEAVY,
    })
    expect(descriptor.severity).toBe('invalidates_evidence')
  })

  it('editing the evaluator-facing prompt affects future captures only', () => {
    const impact = classify({
      entity: 'question',
      operation: 'update',
      entityId: 'k1',
      label: 'Q3',
      fields: [{ field: 'evaluator_facing_prompt', before: 'How?', after: 'How did they?' }],
      counts: HEAVY,
    })
    expect(impact.severity).toBe('affects_future')
    expect(impact.consequences[0].tokens).toMatchObject({ captures: 9 })
  })

  it('renaming a question CODE detaches the observations recorded under it', () => {
    // The trap: observations join on ksa_code, not on the row id, so this reads as a
    // rename and behaves like a detach.
    const impact = classify({
      entity: 'question',
      operation: 'update',
      entityId: 'k1',
      label: 'Q3',
      fields: [{ field: 'code', before: 'Q3', after: 'Q4' }],
      counts: HEAVY,
    })
    expect(impact.severity).toBe('invalidates_evidence')
    expect(impact.consequences[0].tokens).toMatchObject({
      before: 'Q3',
      after: 'Q4',
      observations: 23,
      participants: 6,
    })
  })
})

describe('the counts are the whole value', () => {
  it('a question delete names the observations, participants and reports', () => {
    const impact = classify({
      entity: 'question',
      operation: 'delete',
      entityId: 'k1',
      label: 'Q3 — CLAT facilitation',
      counts: HEAVY,
    })
    expect(impact.severity).toBe('destructive')
    expect(impact.consequences[0].tokens).toMatchObject({
      observations: 23,
      participants: 6,
      reports: 6,
    })
    // The verdicts line only appears when there are verdicts to strand.
    expect(impact.consequences.some((con) => con.id.endsWith('delete-verdicts'))).toBe(true)
  })

  it('a severity that claims recorded work is affected drops a tier when the count is zero', () => {
    // This is what stops the layer from crying wolf, and it is the reason a caller
    // that forgets to gather counts under-warns rather than over-warns.
    const impact = classify({
      entity: 'question',
      operation: 'delete',
      entityId: 'k1',
      label: 'Q3',
      counts: { observations: 0, wiredEvents: 2 },
    })
    expect(impact.severity).toBe('affects_future')
    expect(impact.requiresTypedName).toBe(false)
    expect(impact.consequences[0].tokens).toMatchObject({ events: 2 })
  })

  it('a threshold move quotes how many observations cross the line', () => {
    const impact = classify({
      entity: 'threshold',
      operation: 'update',
      entityId: null,
      label: 'the verification bar',
      fields: [{ field: 'required_confirmations', before: 2, after: 3 }],
      counts: { crossing: 17, participants: 5 },
    })
    expect(impact.severity).toBe('invalidates_evidence')
    expect(impact.consequences[0].id).toContain('threshold.raise')
    expect(impact.consequences[0].tokens).toMatchObject({ before: 2, after: 3, crossing: 17 })
  })

  it('a threshold move that crosses nothing is not dressed up as one that does', () => {
    const impact = classify({
      entity: 'threshold',
      operation: 'update',
      entityId: null,
      label: 'the verification bar',
      fields: [{ field: 'required_confirmations', before: 2, after: 3 }],
      counts: { crossing: 0 },
    })
    expect(impact.severity).toBe('affects_future')
  })
})

describe('observationsCrossingThreshold', () => {
  it('counts the observations between the old bar and the new one', () => {
    // Confirm counts: two observations at 2, one at 1, one at 3.
    const counts = [2, 2, 1, 3]
    // 2 -> 3: the two at exactly 2 lose verified status. The one at 3 keeps it, the
    // one at 1 never had it.
    expect(observationsCrossingThreshold(counts, 2, 3)).toBe(2)
    // Symmetric: lowering 3 -> 2 gains the same two.
    expect(observationsCrossingThreshold(counts, 3, 2)).toBe(2)
    expect(observationsCrossingThreshold(counts, 2, 2)).toBe(0)
    // 1 -> 3 crosses everything at 1 and 2.
    expect(observationsCrossingThreshold(counts, 1, 3)).toBe(3)
  })
})

describe('workshop state modulates everything', () => {
  const deleteWithEvidence: SetupChange = {
    entity: 'question',
    operation: 'delete',
    entityId: 'k1',
    label: 'Q3',
    counts: HEAVY,
  }

  it('the same delete in a draft workshop classifies lower and demands no typed name', () => {
    const inProgress = classify(deleteWithEvidence, 'in_progress')
    const draft = classify(deleteWithEvidence, 'draft')
    expect(inProgress.severity).toBe('destructive')
    expect(draft.severity).toBe('affects_future')
    expect(draft.requiresTypedName).toBe(false)
  })

  it('a non-delete edit in a draft workshop saves with no dialog at all', () => {
    // A warning layer that fires over an empty database is one people learn to click
    // through, which is how the layer stops working on the day it matters.
    const impact = classify(
      {
        entity: 'question',
        operation: 'update',
        entityId: 'k1',
        label: 'Q3',
        fields: [{ field: 'evidence_levels', before: { '1': 'a' }, after: { '1': 'b' } }],
        counts: { scored: 0 },
      },
      'draft',
    )
    expect(impact.severity).toBe('safe')
    expect(impact.silent).toBe(true)
    expect(impact.consequences).toEqual([])
  })

  it('a closed workshop says so, on top of the change itself', () => {
    const impact = classify(deleteWithEvidence, 'closed')
    expect(impact.severity).toBe('destructive')
    expect(impact.consequences.some((con) => con.id === 'setup.impact.state.closed')).toBe(true)
  })
})

describe('one case per severity per entity', () => {
  const cases: Array<[string, SetupChange, string]> = [
    [
      'event create',
      { entity: 'event', operation: 'create', entityId: 'a1', label: 'Day 1' },
      'affects_future',
    ],
    [
      'participant create',
      { entity: 'participant', operation: 'create', entityId: null, label: 'Amos' },
      'affects_future',
    ],
    [
      'participant delete with evidence',
      {
        entity: 'participant',
        operation: 'delete',
        entityId: 'p1',
        label: 'Amos',
        counts: { observations: 14, verdicts: 20 },
      },
      'destructive',
    ],
    [
      'participant delete with nothing recorded',
      {
        entity: 'participant',
        operation: 'delete',
        entityId: 'p1',
        label: 'Amos',
        counts: { observations: 0 },
      },
      'affects_future',
    ],
    [
      'participant rename',
      {
        entity: 'participant',
        operation: 'update',
        entityId: 'p1',
        label: 'Amos',
        fields: [{ field: 'name', before: 'Amos', after: 'Amos K' }],
      },
      'safe',
    ],
    [
      'participant team move',
      {
        entity: 'participant',
        operation: 'update',
        entityId: 'p1',
        label: 'Amos',
        fields: [{ field: 'team_id', before: null, after: 't2' }],
      },
      'safe',
    ],
    [
      'team create',
      { entity: 'team', operation: 'create', entityId: 't1', label: 'Team B' },
      'safe',
    ],
    [
      'team delete with members',
      {
        entity: 'team',
        operation: 'delete',
        entityId: 't1',
        label: 'Team B',
        counts: { teamMembers: 4 },
      },
      'affects_future',
    ],
    [
      'workshop rename',
      {
        entity: 'workshop',
        operation: 'update',
        entityId: 'w1',
        label: 'Bali',
        fields: [{ field: 'name', before: 'Bali', after: 'Bali 2026' }],
      },
      'safe',
    ],
    [
      'workshop end date moved',
      {
        entity: 'workshop',
        operation: 'update',
        entityId: 'w1',
        label: 'Bali',
        fields: [{ field: 'end_date', before: '2026-03-01', after: '2026-03-08' }],
      },
      'affects_future',
    ],
    [
      'workshop delete with evidence',
      {
        entity: 'workshop',
        operation: 'delete',
        entityId: 'w1',
        label: 'Bali',
        counts: { observations: 200, captures: 60, participants: 20, verdicts: 300 },
      },
      'destructive',
    ],
    [
      'scale change under scored evidence',
      {
        entity: 'scale',
        operation: 'update',
        entityId: null,
        label: 'the grading scale',
        fields: [{ field: 'points', before: 4, after: 5 }],
        counts: { scored: 88, participants: 12, reports: 12 },
      },
      'invalidates_evidence',
    ],
    [
      'a quota, which affects only who is asked next',
      {
        entity: 'setting',
        operation: 'update',
        entityId: 'review_quota_default',
        label: 'the default review quota',
        fields: [{ field: 'value', before: 4, after: 5 }],
      },
      'safe',
    ],
  ]

  for (const [name, change, expected] of cases) {
    it(`${name} is ${expected}`, () => {
      expect(classify(change).severity).toBe(expected)
    })
  }

  it('a destructive change is the only one that demands a typed name', () => {
    for (const [, change] of cases) {
      const impact = classify(change)
      expect(impact.requiresTypedName).toBe(impact.severity === 'destructive')
    }
  })

  it('every non-safe classification says something, and every safe one says nothing', () => {
    // A dialog with a severity and no sentence is the "this may affect existing data"
    // failure the whole module exists to avoid.
    for (const [, change] of cases) {
      const impact = classify(change)
      if (impact.severity === 'safe') expect(impact.consequences).toEqual([])
      else expect(impact.consequences.length).toBeGreaterThan(0)
    }
  })
})

describe('diffFields', () => {
  it('reports only what changed, comparing objects by value', () => {
    const before = { ...question }
    const after = { ...question, short_label: 'CLAT facilitation & drafting' }
    expect(diffFields(before, after).map((f) => f.field)).toEqual(['short_label'])
  })

  it('does not report a jsonb field that was rebuilt with the same contents', () => {
    // The Builder's editors spread objects on every keystroke, so identity comparison
    // would report every field as edited and every save as risky.
    const after = { ...question, evidence_levels: { ...question.evidence_levels } }
    expect(diffFields(question, after)).toEqual([])
  })

  it('sameValue treats null and undefined as the same absence', () => {
    expect(sameValue(null, undefined)).toBe(true)
    expect(sameValue('', null)).toBe(false)
  })
})

describe('deriveWorkshopState', () => {
  it('is draft while nothing has been submitted, whatever the calendar says', () => {
    expect(
      deriveWorkshopState({
        submittedEvaluations: 0,
        endDate: '2020-01-01',
        now: '2026-07-30T09:00:00.000Z',
      }),
    ).toBe('draft')
  })

  it('is in progress once a capture is submitted', () => {
    expect(
      deriveWorkshopState({
        submittedEvaluations: 1,
        endDate: '2026-08-30',
        now: '2026-07-30T09:00:00.000Z',
      }),
    ).toBe('in_progress')
  })

  it('treats an end date as the END of that day, not its midnight', () => {
    // The same trap as a bare git --since date: comparing against 00:00 would make the
    // final afternoon of every workshop read as closed.
    expect(
      deriveWorkshopState({
        submittedEvaluations: 1,
        endDate: '2026-07-30',
        now: '2026-07-30T16:00:00.000Z',
      }),
    ).toBe('in_progress')
    expect(
      deriveWorkshopState({
        submittedEvaluations: 1,
        endDate: '2026-07-30',
        now: '2026-07-31T09:00:00.000Z',
      }),
    ).toBe('closed')
  })
})
