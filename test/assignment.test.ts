import { describe, expect, it } from 'vitest'
import {
  assigneesByParticipant,
  autoAssign,
  buildBoard,
  coverageOf,
  fairShare,
  loadByEvaluator,
  quotaFor,
  underCovered,
  type EvaluatorRef,
  type ParticipantRef,
} from '../src/lib/assignment'
import { SETTINGS_DEFAULTS } from '../src/lib/settings'
import { assignmentPk } from '../src/db/local'
import type { AssignmentKind, ReportAssignment, WorkshopSettings } from '../src/lib/types'

const WS = 'w1'

const person = (id: string, name: string): ParticipantRef => ({ id, name })
const evaluator = (email: string, name = email): EvaluatorRef => ({ email, name })

function assignment(
  participant_id: string,
  evaluator_email: string,
  kind: AssignmentKind = 'review',
): ReportAssignment {
  return {
    pk: assignmentPk(WS, participant_id, evaluator_email, kind),
    workshop_id: WS,
    participant_id,
    evaluator_email,
    kind,
    source: 'manual',
  }
}

/** email -> participant -> observation count */
function affinityOf(spec: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  return new Map(Object.entries(spec).map(([email, m]) => [email, new Map(Object.entries(m))]))
}

const uncapped = () => null

describe('fairShare', () => {
  it('divides the TOTAL work, not the headcount', () => {
    // 10 participants needing 2 assignees each is 20 assignments, so 4
    // evaluators carry 5 apiece. Dividing 10 by 4 would say 3, which would stop
    // auto-assignment before anyone was covered twice.
    expect(fairShare(10, 4, 2)).toBe(5)
  })

  it('rounds up, because a remainder still has to be carried by somebody', () => {
    expect(fairShare(26, 4, 2)).toBe(13)
    expect(fairShare(7, 2, 1)).toBe(4)
  })

  it('is null when there is nobody to divide among', () => {
    expect(fairShare(10, 0, 2)).toBeNull()
  })

  it('treats a threshold below 1 as 1 rather than producing 0', () => {
    expect(fairShare(4, 2, 0)).toBe(2)
  })
})

describe('quotaFor', () => {
  const settings: WorkshopSettings = {
    ...SETTINGS_DEFAULTS,
    reviewQuotaDefault: 5,
    reviewQuotaOverrides: { 'keen@sil.org': 9 },
    observationQuotaOverrides: { 'keen@sil.org': 2 },
  }

  it('prefers the personal override', () => {
    expect(quotaFor('keen@sil.org', 'review', settings, 3)).toBe(9)
  })

  it('falls back to the workshop default', () => {
    expect(quotaFor('other@sil.org', 'review', settings, 3)).toBe(5)
  })

  it('falls back to the fair share when no default is set', () => {
    expect(quotaFor('other@sil.org', 'observation', settings, 3)).toBe(3)
  })

  it('keeps the two kinds independent for the same person', () => {
    expect(quotaFor('keen@sil.org', 'observation', settings, 3)).toBe(2)
  })

  it('matches case-insensitively, since emails arrive in both', () => {
    expect(quotaFor('KEEN@SIL.org', 'review', settings, 3)).toBe(9)
  })

  it('returns null when nothing caps them at all', () => {
    expect(quotaFor('x@y.org', 'review', SETTINGS_DEFAULTS, null)).toBeNull()
  })
})

describe('coverageOf', () => {
  it('separates nobody-assigned from not-enough-assigned', () => {
    expect(coverageOf(0, 2)).toBe('unassigned')
    expect(coverageOf(1, 2)).toBe('under')
    expect(coverageOf(2, 2)).toBe('met')
    expect(coverageOf(3, 2)).toBe('over')
  })
})

describe('indexes', () => {
  const rows = [
    assignment('p1', 'a@x.org'),
    assignment('p1', 'b@x.org'),
    assignment('p2', 'a@x.org'),
    assignment('p3', 'a@x.org', 'observation'),
  ]

  it('groups by participant within one kind only', () => {
    const idx = assigneesByParticipant(rows, 'review')
    expect(idx.get('p1')).toEqual(['a@x.org', 'b@x.org'])
    expect(idx.get('p3')).toBeUndefined()
  })

  it('counts load within one kind only', () => {
    expect(loadByEvaluator(rows, 'review').get('a@x.org')).toBe(2)
    expect(loadByEvaluator(rows, 'observation').get('a@x.org')).toBe(1)
  })
})

describe('autoAssign', () => {
  const participants = [person('p1', 'Amos'), person('p2', 'Ruth'), person('p3', 'Daniel')]
  const evaluators = [evaluator('a@x.org'), evaluator('b@x.org')]

  it('fills every participant to the requirement', () => {
    const out = autoAssign({
      participants,
      evaluators,
      affinity: new Map(),
      existing: [],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(out).toHaveLength(6)
    for (const p of participants) {
      expect(out.filter((o) => o.participant_id === p.id)).toHaveLength(2)
    }
  })

  it('prefers whoever observed the participant most', () => {
    const out = autoAssign({
      participants: [person('p1', 'Amos')],
      evaluators,
      affinity: affinityOf({ 'b@x.org': { p1: 5 } }),
      existing: [],
      kind: 'review',
      required: 1,
      quotaOf: uncapped,
    })
    expect(out).toEqual([
      { participant_id: 'p1', participant_name: 'Amos', evaluator_email: 'b@x.org', observedCount: 5 },
    ])
  })

  it('never proposes somebody who already has the participant', () => {
    const out = autoAssign({
      participants: [person('p1', 'Amos')],
      evaluators,
      affinity: affinityOf({ 'a@x.org': { p1: 9 } }),
      existing: [assignment('p1', 'a@x.org')],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(out.map((o) => o.evaluator_email)).toEqual(['b@x.org'])
  })

  it('proposes nothing when everyone is already covered', () => {
    const out = autoAssign({
      participants: [person('p1', 'Amos')],
      evaluators,
      affinity: new Map(),
      existing: [assignment('p1', 'a@x.org'), assignment('p1', 'b@x.org')],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(out).toEqual([])
  })

  it('is additive: an existing assignment is never proposed away', () => {
    const existing = [assignment('p1', 'a@x.org')]
    const out = autoAssign({
      participants,
      evaluators,
      affinity: new Map(),
      existing,
      kind: 'review',
      required: 1,
      quotaOf: uncapped,
    })
    // p1 is satisfied by the manual row and gets nothing new.
    expect(out.some((o) => o.participant_id === 'p1')).toBe(false)
  })

  it('respects a quota and stops rather than overfilling', () => {
    const out = autoAssign({
      participants,
      evaluators: [evaluator('a@x.org')],
      affinity: new Map(),
      existing: [],
      kind: 'review',
      required: 1,
      quotaOf: () => 2,
    })
    // Three participants, one evaluator capped at two: the third is left short,
    // which is the honest signal that the workshop is under-staffed.
    expect(out).toHaveLength(2)
  })

  it('spreads load when history is equal', () => {
    const out = autoAssign({
      participants,
      evaluators,
      affinity: new Map(),
      existing: [],
      kind: 'review',
      required: 1,
      quotaOf: uncapped,
    })
    const counts = loadByEvaluator(
      out.map((o) => assignment(o.participant_id, o.evaluator_email)),
      'review',
    )
    expect(Math.abs((counts.get('a@x.org') ?? 0) - (counts.get('b@x.org') ?? 0))).toBeLessThanOrEqual(1)
  })

  it('serves the neediest participant first when capacity is scarce', () => {
    const out = autoAssign({
      participants: [person('p1', 'Amos'), person('p2', 'Ruth')],
      evaluators: [evaluator('a@x.org'), evaluator('b@x.org')],
      // p1 already has one; p2 has none. One slot of capacity left in total.
      existing: [assignment('p1', 'a@x.org')],
      affinity: new Map(),
      kind: 'review',
      required: 2,
      quotaOf: (e) => (e === 'a@x.org' ? 1 : 2),
    })
    // b's two slots go to the participant with nobody before topping up p1.
    expect(out[0].participant_id).toBe('p2')
  })

  it('is deterministic across runs on identical input', () => {
    const input = {
      participants,
      evaluators,
      affinity: affinityOf({ 'a@x.org': { p1: 1 }, 'b@x.org': { p1: 1 } }),
      existing: [],
      kind: 'review' as const,
      required: 2,
      quotaOf: uncapped,
    }
    expect(autoAssign(input)).toEqual(autoAssign(input))
  })

  it('only considers assignments of the kind it is filling', () => {
    const out = autoAssign({
      participants: [person('p1', 'Amos')],
      evaluators,
      affinity: new Map(),
      // An observation assignment must not satisfy a review requirement.
      existing: [assignment('p1', 'a@x.org', 'observation')],
      kind: 'review',
      required: 1,
      quotaOf: uncapped,
    })
    expect(out).toHaveLength(1)
  })
})

describe('buildBoard', () => {
  const participants = [person('p1', 'Amos'), person('p2', 'Ruth')]
  const evaluators = [evaluator('b@x.org', 'Beth'), evaluator('a@x.org', 'Ann')]

  it('leads with the unassigned column', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(cols[0].evaluator).toBeNull()
    expect(cols[0].cards.map((c) => c.participant_name)).toEqual(['Amos', 'Ruth'])
  })

  it('orders evaluator columns by name, not by email', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(cols.slice(1).map((c) => c.evaluator?.name)).toEqual(['Ann', 'Beth'])
  })

  it('gives the same participant the same coverage in every column they appear in', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [assignment('p1', 'a@x.org'), assignment('p1', 'b@x.org')],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    const amosCards = cols.flatMap((c) => c.cards).filter((c) => c.participant_id === 'p1')
    expect(amosCards).toHaveLength(2)
    expect(new Set(amosCards.map((c) => c.coverage))).toEqual(new Set(['met']))
  })

  it('drops a card whose participant is no longer on the roster', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [assignment('ghost', 'a@x.org')],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    expect(cols.flatMap((c) => c.cards).some((c) => c.participant_id === 'ghost')).toBe(false)
  })

  it('flags a column at capacity', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [assignment('p1', 'a@x.org'), assignment('p2', 'a@x.org')],
      kind: 'review',
      required: 1,
      quotaOf: (e) => (e === 'a@x.org' ? 2 : null),
    })
    const ann = cols.find((c) => c.evaluator?.email === 'a@x.org')!
    expect(ann.load).toBe(2)
    expect(ann.atCapacity).toBe(true)
  })

  it('reports each evaluator’s own verdict progress on a review card', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [assignment('p1', 'a@x.org'), assignment('p1', 'b@x.org')],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
      observationsByParticipant: new Map([['p1', ['o1', 'o2', 'o3']]]),
      verdictsByEvaluator: new Map([['a@x.org', new Set(['o1', 'o2'])]]),
    })
    const ann = cols.find((c) => c.evaluator?.email === 'a@x.org')!
    const beth = cols.find((c) => c.evaluator?.email === 'b@x.org')!
    expect(ann.cards[0].progress).toEqual({ done: 2, total: 3 })
    expect(beth.cards[0].progress).toEqual({ done: 0, total: 3 })
  })

  it('omits progress on the observation board', () => {
    const cols = buildBoard({
      participants,
      evaluators,
      assignments: [assignment('p1', 'a@x.org', 'observation')],
      kind: 'observation',
      required: 1,
      quotaOf: uncapped,
      observationsByParticipant: new Map([['p1', ['o1']]]),
      verdictsByEvaluator: new Map(),
    })
    const ann = cols.find((c) => c.evaluator?.email === 'a@x.org')!
    expect(ann.cards[0].progress).toBeUndefined()
  })
})

/**
 * The regression that mattered most in Wave 2's review.
 *
 * Columns used to be derived from the directory alone, so a participant whose
 * only assignee was not a workshop member rendered NOWHERE: not in the
 * unassigned pile (which takes only zero-assignee people) and in no column. The
 * board then reported "everybody has enough assignees" over a cohort that did
 * not, which is the exact opposite of what it is for.
 *
 * This is not a hypothetical arrangement. report_assignment keys on an email
 * precisely so a rota can be planned before the cohort signs up, and somebody
 * can also be removed from a workshop or re-roled after being assigned.
 */
describe('buildBoard with an off-roster assignee', () => {
  const participants = [person('p1', 'Amos'), person('p2', 'Ruth')]
  const evaluators = [evaluator('a@x.org', 'Ann')]
  // Assigned to somebody who has not signed up yet.
  const assignments = [assignment('p1', 'future@sil.org')]

  const cols = () =>
    buildBoard({ participants, evaluators, assignments, kind: 'review', required: 2, quotaOf: uncapped })

  it('gives the unknown assignee a column instead of hiding their work', () => {
    const col = cols().find((c) => c.evaluator?.email === 'future@sil.org')
    expect(col).toBeDefined()
    expect(col!.offRoster).toBe(true)
    expect(col!.cards.map((c) => c.participant_name)).toEqual(['Amos'])
  })

  it('still counts that participant as short', () => {
    // One assignee, two required. Before the fix this returned 1 (Ruth only).
    expect(underCovered(cols())).toBe(2)
  })

  it('does not leave the participant out of every column', () => {
    const everywhere = cols().flatMap((c) => c.cards.map((card) => card.participant_id))
    expect(everywhere).toContain('p1')
  })

  it('marks a real directory column as on-roster', () => {
    const col = cols().find((c) => c.evaluator?.email === 'a@x.org')
    expect(col?.offRoster).toBe(false)
  })

  it('gives an off-roster column no quota, since nobody set one for them', () => {
    const col = buildBoard({
      participants,
      evaluators,
      assignments,
      kind: 'review',
      required: 2,
      quotaOf: () => 1,
    }).find((c) => c.evaluator?.email === 'future@sil.org')
    expect(col?.quota).toBeNull()
    expect(col?.atCapacity).toBe(false)
  })

  it('orders the workshop’s own people before the strangers', () => {
    const named = cols()
      .slice(1)
      .map((c) => c.evaluator!.email)
    expect(named).toEqual(['a@x.org', 'future@sil.org'])
  })
})

describe('underCovered', () => {
  it('counts each short participant once, not once per column', () => {
    const cols = buildBoard({
      participants: [person('p1', 'Amos'), person('p2', 'Ruth'), person('p3', 'Dan')],
      evaluators: [evaluator('a@x.org'), evaluator('b@x.org')],
      assignments: [
        assignment('p1', 'a@x.org'),
        assignment('p1', 'b@x.org'),
        assignment('p2', 'a@x.org'),
      ],
      kind: 'review',
      required: 2,
      quotaOf: uncapped,
    })
    // p2 is under, p3 is unassigned, p1 is met.
    expect(underCovered(cols)).toBe(2)
  })
})
