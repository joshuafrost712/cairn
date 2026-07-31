import { describe, it, expect } from 'vitest'
import { classifySetupChange, type SetupChange, type WorkshopState } from '../src/setup/impact'
import { fillTokens, findChromeNode } from '../src/lib/content/chrome'

/**
 * Does every warning the classifier can produce actually have words?
 *
 * This exists because of how the content layer fails. `c()` returns the ID when a
 * node is missing, so a forgotten string does not crash and does not blank: it puts
 * `setup.impact.question.code` on screen inside a confirmation dialog, which is worse
 * than either. And `fillTokens` leaves an unknown `{token}` in place, so a renamed
 * token surfaces as "detaches {observations} observation(s)" in the one dialog whose
 * entire value is that its numbers are real.
 *
 * So this walks every consequence the classifier can emit across every entity,
 * operation and state, and asserts both halves: the node exists, and every placeholder
 * in it was given a value.
 */

const ENTITIES: SetupChange[] = [
  { entity: 'question', operation: 'create', entityId: 'k', label: 'Q9' },
  {
    entity: 'question',
    operation: 'update',
    entityId: 'k',
    label: 'Q3',
    fields: [
      { field: 'code', before: 'Q3', after: 'Q4' },
      { field: 'evidence_levels', before: { '1': 'a' }, after: { '1': 'b' } },
      { field: 'evaluator_facing_prompt', before: 'a', after: 'b' },
      { field: 'description', before: 'a', after: 'b' },
      { field: 'guiding_questions', before: [], after: ['x'] },
    ],
  },
  { entity: 'question', operation: 'delete', entityId: 'k', label: 'Q3' },
  { entity: 'event', operation: 'create', entityId: 'a', label: 'Day 1' },
  {
    entity: 'event',
    operation: 'update',
    entityId: 'a',
    label: 'Day 1',
    fields: [{ field: 'title', before: 'a', after: 'b' }],
  },
  {
    entity: 'event',
    operation: 'update',
    entityId: 'a',
    label: 'Day 1',
    // A field the classifier has no rule for: the over-warning branch still needs copy.
    fields: [{ field: 'invented_later', before: 'a', after: 'b' }],
  },
  { entity: 'event', operation: 'delete', entityId: 'a', label: 'Day 1' },
  {
    entity: 'wiring',
    operation: 'update',
    entityId: 'a',
    label: 'Day 1',
    fields: [{ field: 'questions', before: [], after: ['k'] }],
  },
  { entity: 'participant', operation: 'create', entityId: null, label: 'Amos' },
  {
    entity: 'participant',
    operation: 'update',
    entityId: 'p',
    label: 'Amos',
    fields: [{ field: 'invented_later', before: 'a', after: 'b' }],
  },
  { entity: 'participant', operation: 'delete', entityId: 'p', label: 'Amos' },
  { entity: 'team', operation: 'create', entityId: 't', label: 'Team B' },
  { entity: 'team', operation: 'delete', entityId: 't', label: 'Team B' },
  { entity: 'workshop', operation: 'create', entityId: null, label: 'Crash Course' },
  {
    entity: 'workshop',
    operation: 'update',
    entityId: 'w',
    label: 'Bali',
    fields: [
      { field: 'end_date', before: '2026-01-01', after: '2026-02-01' },
      { field: 'invented_later', before: 'a', after: 'b' },
    ],
  },
  { entity: 'workshop', operation: 'delete', entityId: 'w', label: 'Bali' },
  {
    entity: 'threshold',
    operation: 'update',
    entityId: null,
    label: 'the verification bar',
    fields: [{ field: 'required_confirmations', before: 2, after: 3 }],
  },
  {
    entity: 'threshold',
    operation: 'update',
    entityId: null,
    label: 'the verification bar',
    fields: [{ field: 'required_confirmations', before: 3, after: 2 }],
  },
  {
    entity: 'scale',
    operation: 'update',
    entityId: null,
    label: 'the grading scale',
    fields: [{ field: 'points', before: 4, after: 5 }],
  },
  {
    entity: 'setting',
    operation: 'update',
    entityId: 'review_quota_default',
    label: 'the default review quota',
    fields: [{ field: 'value', before: 1, after: 2 }],
  },
]

const STATES: WorkshopState[] = ['draft', 'in_progress', 'closed']

/**
 * Both count shapes, because the branch taken depends on them: zero counts take the
 * "nothing was affected" copy and non-zero counts take the copy with the numbers in.
 * Testing only one of them would leave half the strings unverified.
 */
const COUNT_SHAPES = [
  {},
  {
    observations: 23,
    scored: 23,
    participants: 6,
    reports: 6,
    verdicts: 41,
    captures: 9,
    wiredEvents: 2,
    teamMembers: 4,
    crossing: 17,
    events: 5,
    questions: 8,
  },
]

describe('every warning the classifier can emit has words and no blanks', () => {
  it('resolves every headline and consequence through chrome.json', () => {
    const missing: string[] = []
    const unresolved: string[] = []

    for (const base of ENTITIES) {
      for (const counts of COUNT_SHAPES) {
        for (const state of STATES) {
          const impact = classifySetupChange({ ...base, counts }, state)

          const headline = findChromeNode(impact.headlineId)?.label
          if (!headline) missing.push(impact.headlineId)

          for (const consequence of impact.consequences) {
            const label = findChromeNode(consequence.id)?.label
            if (!label) {
              missing.push(consequence.id)
              continue
            }
            const filled = fillTokens(label, consequence.tokens)
            if (/\{\w+\}/.test(filled)) {
              unresolved.push(`${consequence.id}: ${filled.match(/\{\w+\}/g)?.join(', ')}`)
            }
          }
        }
      }
    }

    expect(missing).toEqual([])
    expect(unresolved).toEqual([])
  })

  it('every severity pill and workshop-state chip has a label', () => {
    const ids = [
      'setup.severity.safe',
      'setup.severity.affects-future',
      'setup.severity.invalidates-evidence',
      'setup.severity.destructive',
      'setup.state.draft',
      'setup.state.in-progress',
      'setup.state.closed',
      'setup.dialog.subject',
      'setup.dialog.type-name',
      'setup.dialog.cancel',
      'setup.dialog.commit',
      'setup.dialog.commit-destructive',
      'setup.dialog.local-scope',
    ]
    expect(ids.filter((id) => !findChromeNode(id)?.label)).toEqual([])
  })
})
