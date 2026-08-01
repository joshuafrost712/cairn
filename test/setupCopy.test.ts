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
  // tl-08: the per-event wording branch, which is a different sentence from a rewire.
  {
    entity: 'wiring',
    operation: 'update',
    entityId: 'a::k',
    label: 'Day 1 · Q3',
    fields: [
      { field: 'prompt_override', before: null, after: 'asked this way here' },
      { field: 'guiding_questions_override', before: null, after: [] },
    ],
  },
  // tl-08: goals, and moving a question between them.
  { entity: 'goal', operation: 'create', entityId: 'g', label: 'G9' },
  {
    entity: 'goal',
    operation: 'update',
    entityId: 'g',
    label: 'G1 — Exegesis',
    fields: [{ field: 'title', before: 'Exegesis', after: 'Psalms Exegesis' }],
  },
  { entity: 'goal', operation: 'delete', entityId: 'g', label: 'G1 — Exegesis' },
  {
    entity: 'question',
    operation: 'update',
    entityId: 'k',
    label: 'Q3',
    fields: [{ field: 'goal_id', before: 'g1', after: 'g2' }],
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
  // tl-10: a whole spreadsheet, and the undo of one. Both directions, because the
  // undo's copy is the one nobody reads until the day it matters.
  {
    entity: 'roster_import',
    operation: 'create',
    entityId: null,
    label: 'bali-roster.csv',
  },
  {
    entity: 'roster_import',
    operation: 'delete',
    entityId: 'rosterimport_1',
    label: 'bali-roster.csv',
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
    regrouped: 6,
    // tl-10's counts. Every one of them appears as a token in an import sentence,
    // so a renamed key surfaces here as a literal `{created}` in a dialog.
    created: 28,
    updated: 11,
    unchanged: 3,
    contactChanges: 4,
    refused: 2,
    teams: 3,
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
      // tl-08's section copy, checked by id here rather than only being rendered:
      // c() prints the id when a node is missing, so a typo in a section becomes a
      // heading that reads "setup.goals.title" instead of a heading.
      'setup.goals.title',
      'setup.goals.add',
      'setup.goals.help',
      'setup.goals.empty',
      'setup.goals.label-field',
      'setup.goals.label-save',
      'setup.goals.code',
      'setup.goals.heading',
      'setup.goals.description',
      'setup.goals.holds',
      'setup.goals.save',
      'setup.goals.untitled',
      'setup.questions.scoped-note',
      'setup.questions.no-goals',
      'setup.questions.ungrouped',
      'setup.questions.group-empty',
      'setup.questions.no-goal',
      'setup.questions.code',
      'setup.questions.short-label',
      'setup.questions.description',
      'setup.questions.prompt',
      'setup.questions.prompt-override-note',
      'setup.questions.levels',
      'setup.questions.guiding',
      'setup.questions.guiding-add',
      'setup.questions.guiding-remove',
      'setup.questions.rubric',
      'setup.questions.cbc',
      'setup.questions.regroup-warning',
      'setup.wiring.wording',
      'setup.wiring.remove',
      'setup.wiring.overridden',
      'setup.wiring.override-help',
      'setup.wiring.override-prompt',
      'setup.wiring.override-blank',
      'setup.wiring.override-guiding',
      'setup.wiring.override-guiding-inherited',
      'setup.wiring.override-save',
      'setup.wiring.override-clear',
    ]
    expect(ids.filter((id) => !findChromeNode(id)?.label)).toEqual([])
  })
})
