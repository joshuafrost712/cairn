import { describe, it, expect } from 'vitest'
import {
  GOAL_LABEL_DEFAULT,
  UNGROUPED_TITLE,
  goalLabel,
  groupByGoal,
  hasOverride,
  nextGoalCode,
  nextQuestionCode,
  normalizeGuidingOverride,
  normalizeOverride,
  resolveForActivity,
  withGoalTitles,
} from '../src/lib/goals'
import type { Goal, Ksa } from '../src/lib/types'

/**
 * The two resolutions tl-08 introduced, tested where they live.
 *
 * Both are the kind of thing that is easy to get subtly wrong and impossible to
 * notice afterwards: a question grouped under the wrong heading still renders, and a
 * per-event prompt that silently falls back to the question's own still shows an
 * evaluator a sensible-looking question. The failure mode is a plausible screen, so
 * the tests have to pin the behaviour rather than the absence of a crash.
 */

const goal = (partial: Partial<Goal> & { id: string }): Goal => ({
  workshop_id: 'w-1',
  code: 'G1',
  title: 'A goal',
  description: null,
  sort_order: 0,
  ...partial,
})

const question = (partial: Partial<Ksa> & { id: string; code: string }): Ksa => ({
  workshop_id: 'w-1',
  goal_id: null,
  short_label: partial.code,
  description: '',
  evaluator_facing_prompt: 'the question’s own prompt',
  ai_facing_rubric: null,
  evidence_levels: null,
  cbc_subpoint_refs: [],
  guiding_questions: ['own one', 'own two'],
  ...partial,
})

describe('goalLabel', () => {
  it('falls back to the app default when the workshop has not renamed the level', () => {
    expect(goalLabel(null)).toBe(GOAL_LABEL_DEFAULT)
    expect(goalLabel({})).toBe(GOAL_LABEL_DEFAULT)
    expect(goalLabel({ goal_label: null })).toBe(GOAL_LABEL_DEFAULT)
    // A field somebody cleared to spaces is not a label.
    expect(goalLabel({ goal_label: '   ' })).toBe(GOAL_LABEL_DEFAULT)
  })

  it('uses the workshop’s own word, trimmed', () => {
    expect(goalLabel({ goal_label: ' KSA area ' })).toBe('KSA area')
  })
})

describe('withGoalTitles', () => {
  const goals = [goal({ id: 'g-1', title: 'Exegesis', sort_order: 1 })]

  it('takes the group heading from the goal', () => {
    const [resolved] = withGoalTitles([question({ id: 'k-1', code: 'Q1', goal_id: 'g-1' })], goals)
    expect(resolved.goal_title).toBe('Exegesis')
    expect(resolved.goal_sort).toBe(1)
  })

  it('says "Ungrouped" rather than blank for a question with no goal', () => {
    const [resolved] = withGoalTitles([question({ id: 'k-1', code: 'Q1' })], goals)
    expect(resolved.goal_title).toBe(UNGROUPED_TITLE)
  })

  it('says "Ungrouped" for a goal_id that points at nothing, rather than throwing', () => {
    // The state a device is in between deleting a goal and its next sync. A report
    // that crashed here would be worse than one that prints a heading.
    const [resolved] = withGoalTitles([question({ id: 'k-1', code: 'Q1', goal_id: 'gone' })], goals)
    expect(resolved.goal_title).toBe(UNGROUPED_TITLE)
  })

  it('NEVER falls back to the legacy area column', () => {
    // The one regression that would quietly undo the spec: reviving `area` as a
    // fallback puts the two copies of the group label back into disagreement.
    const legacy = question({ id: 'k-1', code: 'Q1', area: 'The old free-text area' })
    const [resolved] = withGoalTitles([legacy], goals)
    expect(resolved.goal_title).toBe(UNGROUPED_TITLE)
    expect(resolved.goal_title).not.toBe('The old free-text area')
  })
})

describe('groupByGoal', () => {
  const goals = [
    goal({ id: 'g-2', code: 'G2', title: 'Second', sort_order: 1 }),
    goal({ id: 'g-1', code: 'G1', title: 'First', sort_order: 0 }),
  ]

  it('orders goals by sort_order and questions by code inside one', () => {
    const groups = groupByGoal(
      [
        question({ id: 'k-10', code: 'Q10', goal_id: 'g-1' }),
        question({ id: 'k-2', code: 'Q2', goal_id: 'g-1' }),
        question({ id: 'k-3', code: 'Q3', goal_id: 'g-2' }),
      ],
      goals,
    )
    expect(groups.map((g) => g.goal?.code)).toEqual(['G1', 'G2'])
    // Numeric collation, so Q2 precedes Q10 rather than following it.
    expect(groups[0].ksas.map((k) => k.code)).toEqual(['Q2', 'Q10'])
  })

  it('keeps an empty goal in the list', () => {
    // A goal somebody just created is empty for as long as it takes to add a
    // question. Dropping it would make the editor forget it exists.
    const groups = groupByGoal([], goals)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.ksas.length === 0)).toBe(true)
  })

  it('puts ungrouped questions in a trailing group with a null goal', () => {
    const groups = groupByGoal(
      [question({ id: 'k-1', code: 'Q1' }), question({ id: 'k-2', code: 'Q2', goal_id: 'gone' })],
      goals,
    )
    expect(groups[groups.length - 1].goal).toBeNull()
    expect(groups[groups.length - 1].ksas.map((k) => k.code)).toEqual(['Q1', 'Q2'])
  })

  it('adds no ungrouped group when every question has a goal', () => {
    const groups = groupByGoal([question({ id: 'k-1', code: 'Q1', goal_id: 'g-1' })], goals)
    expect(groups.some((g) => g.goal === null)).toBe(false)
  })
})

describe('next codes are scoped, not global', () => {
  it('fills the first gap rather than counting', () => {
    expect(nextGoalCode([goal({ id: 'a', code: 'G1' }), goal({ id: 'b', code: 'G3' })])).toBe('G2')
    expect(
      nextQuestionCode([
        question({ id: 'a', code: 'Q1' }),
        question({ id: 'b', code: 'Q2' }),
      ]),
    ).toBe('Q3')
  })

  it('is case-insensitive, so q1 does not become a second Q1', () => {
    expect(nextQuestionCode([question({ id: 'a', code: 'q1' })])).toBe('Q2')
  })

  it('starts at 1 on an empty workshop', () => {
    expect(nextGoalCode([])).toBe('G1')
    expect(nextQuestionCode([])).toBe('Q1')
  })
})

describe('per-event prompt overrides', () => {
  const [resolved] = withGoalTitles([question({ id: 'k-1', code: 'Q1', goal_id: 'g-1' })], [
    goal({ id: 'g-1', title: 'Exegesis' }),
  ])

  it('uses the question’s own wording when nothing is overridden', () => {
    const out = resolveForActivity(resolved, { sort_order: 0 })
    expect(out.evaluator_facing_prompt).toBe('the question’s own prompt')
    expect(out.guiding_questions).toEqual(['own one', 'own two'])
    expect(out.overridden).toBe(false)
  })

  it('uses the event’s wording when it has one, and says it is overridden', () => {
    const out = resolveForActivity(resolved, {
      sort_order: 0,
      prompt_override: 'how did they do it in the practice session?',
    })
    expect(out.evaluator_facing_prompt).toBe('how did they do it in the practice session?')
    // The guiding questions were not overridden, so they still come from the question.
    expect(out.guiding_questions).toEqual(['own one', 'own two'])
    expect(out.overridden).toBe(true)
  })

  it('treats a blank override as no override, so clearing the box falls back', () => {
    // The spec's acceptance criterion: "clearing an override falls back with no
    // residue". A stored empty string would render a question with nothing asked.
    const out = resolveForActivity(resolved, { sort_order: 0, prompt_override: '   ' })
    expect(out.evaluator_facing_prompt).toBe('the question’s own prompt')
    expect(out.overridden).toBe(false)
  })

  it('treats an EMPTY guiding-questions array as a real instruction', () => {
    // "Show no guiding questions on this event" differs from "show the question's
    // own", which is why the empty array is an override and the empty string is not.
    const out = resolveForActivity(resolved, { sort_order: 0, guiding_questions_override: [] })
    expect(out.guiding_questions).toEqual([])
    expect(out.overridden).toBe(true)
  })

  it('carries the link’s sort order through', () => {
    expect(resolveForActivity(resolved, { sort_order: 4 }).sort_order).toBe(4)
  })

  it('hasOverride sees either field', () => {
    expect(hasOverride({})).toBe(false)
    expect(hasOverride({ prompt_override: null, guiding_questions_override: null })).toBe(false)
    expect(hasOverride({ prompt_override: 'x' })).toBe(true)
    expect(hasOverride({ guiding_questions_override: [] })).toBe(true)
  })

  it('normalizes what a form produced', () => {
    expect(normalizeOverride('  ')).toBeNull()
    expect(normalizeOverride(null)).toBeNull()
    expect(normalizeOverride(' asked this way ')).toBe('asked this way')
    // Null in, null out: the admin never opened the field.
    expect(normalizeGuidingOverride(null)).toBeNull()
    // Blank lines are dropped; an all-blank list becomes "none on this event".
    expect(normalizeGuidingOverride([' a ', '', '  '])).toEqual(['a'])
    expect(normalizeGuidingOverride(['', ' '])).toEqual([])
  })
})
