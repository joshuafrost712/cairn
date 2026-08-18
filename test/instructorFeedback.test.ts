import { describe, expect, it } from 'vitest'

import {
  audienceOf,
  categoryOf,
  instructorReviewPk,
  instructors,
  isInstructorActivity,
  isInstructorRecord,
  normalizeEmail,
  reviewableInstructors,
  reviewsAnyInstructor,
  rosterForActivity,
  subjectKindFor,
  traineeRecords,
  trainees,
  subjectKindForImport,
} from '../src/lib/instructors'
import { scopeEvidence } from '../src/reports/scope'
import type {
  Activity,
  EvaluationRecord,
  InstructorReviewPair,
  ObservationRecord,
  Participant,
} from '../src/lib/types'

/**
 * tl-30. The rules the migration enforces, mirrored on the client.
 *
 * The cases here are the REAL Bali ones rather than invented shapes, because the
 * asymmetry is the whole point: Viji Mathew reviews the three co-facilitators and
 * is reviewed only by Nikki and Angie. A test built on "everyone reviews everyone
 * but themselves" would pass against a formula that is wrong, which is the exact
 * mistake this feature is designed not to make.
 */

const CC = 'ws-crash-course'
const SONGS = 'ws-songs'

const p = (over: Partial<Participant> & { id: string }): Participant => ({
  workshop_id: CC,
  name: over.id,
  registered_email: null,
  team_id: null,
  preferred_language: null,
  ...over,
})

// The Crash Course instructor roster, plus one trainee to prove the split.
const JOSH = p({ id: 'i-josh', name: 'Joshua C. Frost', category: 'instructor' })
const MATHEW = p({ id: 'i-mathew', name: 'Mathew Thomas', category: 'instructor' })
const IRENE = p({ id: 'i-irene', name: 'Irene van Riezen', category: 'instructor' })
const VIJI = p({ id: 'i-viji', name: 'Viji Mathew', category: 'instructor' })
// No `category` at all: the column defaults to 'participant' in Postgres, and
// every row cached before tl-30 looks like this.
const MICAH = p({ id: 't-micah', name: 'Micah Limboo' })
const ROSTER = [JOSH, MATHEW, IRENE, VIJI, MICAH]

const pair = (reviewer: string, instructor: string, workshop = CC): InstructorReviewPair => ({
  pk: instructorReviewPk(workshop, reviewer, instructor),
  workshop_id: workshop,
  reviewer_email: reviewer,
  instructor_participant_id: instructor,
})

/**
 * The nine Crash Course grants from scripts/tl30-instructor-roster.sql.
 *
 * Amended 2026-08-18 with the roster script: Mathew's and Irene's four grants
 * came out when Joshua narrowed the rule to "an evaluator reviews trainees and
 * nobody else". They are absent on purpose, and the two tests below assert the
 * absence from both directions so a later edit that restores the symmetry fails
 * here rather than shipping.
 */
const CC_PAIRS: InstructorReviewPair[] = [
  pair('josh_frost@sil.org', MATHEW.id),
  pair('josh_frost@sil.org', IRENE.id),
  pair('nikkicm23@gmail.com', JOSH.id),
  pair('nikkicm23@gmail.com', MATHEW.id),
  pair('nikkicm23@gmail.com', IRENE.id),
  pair('nikkicm23@gmail.com', VIJI.id),
  pair('viji_mathew@sil.org', JOSH.id),
  pair('viji_mathew@sil.org', MATHEW.id),
  pair('viji_mathew@sil.org', IRENE.id),
]

const names = (rows: Participant[]) => rows.map((r) => r.id).sort()

describe('categoryOf / audienceOf: absent means the pre-tl-30 meaning', () => {
  it('reads a missing category as trainee, matching the Postgres default', () => {
    expect(categoryOf(MICAH)).toBe('participant')
    expect(categoryOf({ category: null })).toBe('participant')
    expect(categoryOf(JOSH)).toBe('instructor')
  })

  it('reads a missing audience as the trainee roster', () => {
    expect(audienceOf(undefined)).toBe('participant')
    expect(audienceOf({ audience: null })).toBe('participant')
    expect(audienceOf({ audience: 'instructor' })).toBe('instructor')
  })

  it('splits a roster both ways without losing anybody', () => {
    expect(names(trainees(ROSTER))).toEqual(['t-micah'])
    expect(names(instructors(ROSTER))).toEqual(['i-irene', 'i-josh', 'i-mathew', 'i-viji'])
    expect(trainees(ROSTER).length + instructors(ROSTER).length).toBe(ROSTER.length)
  })

  it('normalizes an address the way the Postgres check constraint requires', () => {
    expect(normalizeEmail('  Josh_Frost@SIL.org ')).toBe('josh_frost@sil.org')
    expect(normalizeEmail(null)).toBe('')
  })
})

describe('reviewableInstructors: the Bali matrix, not a formula', () => {
  it('gives the course lead his two co-facilitators, and never himself', () => {
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'josh_frost@sil.org', CC))).toEqual([
      'i-irene',
      'i-mathew',
    ])
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'josh_frost@sil.org', CC))).not.toContain(
      'i-josh',
    )
  })

  // THE SECOND ASYMMETRY, added 2026-08-18. Mathew and Irene teach, and they also
  // evaluate the trainees; Joshua's rule is that the second job costs them the
  // first one's reciprocity. They review nobody. This is asserted as an empty
  // list AND as a false from reviewsAnyInstructor, because the two feed different
  // surfaces: the empty list is the capture picker, and the boolean is what hides
  // the instructor event from their schedule (activity_select calls the SQL twin).
  it('gives the two facilitator-evaluators nobody at all', () => {
    for (const who of ['mathewtperumal@gmail.com', 'irene@sall.com']) {
      expect(reviewableInstructors(ROSTER, CC_PAIRS, who, CC)).toEqual([])
      expect(reviewsAnyInstructor(CC_PAIRS, who, CC)).toBe(false)
    }
  })

  it('gives Nikki all four, including Viji', () => {
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'nikkicm23@gmail.com', CC))).toEqual([
      'i-irene',
      'i-josh',
      'i-mathew',
      'i-viji',
    ])
  })

  // THE ASYMMETRY. Viji reviews the three co-facilitators; none of them reviews
  // him. A "everyone except themselves" rule would put i-viji in all three of the
  // lists asserted above, and this is the test that would still be green if
  // somebody replaced the pair table with that rule tomorrow — so it is asserted
  // from the other direction too.
  it('lets Viji review the others while none of them may review him', () => {
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'viji_mathew@sil.org', CC))).toEqual([
      'i-irene',
      'i-josh',
      'i-mathew',
    ])
    for (const who of ['josh_frost@sil.org', 'mathewtperumal@gmail.com', 'irene@sall.com']) {
      expect(names(reviewableInstructors(ROSTER, CC_PAIRS, who, CC))).not.toContain('i-viji')
    }
  })

  // Viji's own row is the reason the rule above is written as pairs rather than
  // as a role check. He is invited to this workshop as an `evaluator`, the same
  // role Mathew and Irene hold, and he reviews all three of them. Any refactor
  // that derives instructor-review rights from workshop_member.role fails here.
  it('keeps Viji reviewing everybody though he holds the same role as the two who review nobody', () => {
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'viji_mathew@sil.org', CC))).toHaveLength(3)
    expect(reviewableInstructors(ROSTER, CC_PAIRS, 'mathewtperumal@gmail.com', CC)).toEqual([])
  })

  it('gives nothing to somebody holding no pair, and nothing off-workshop', () => {
    expect(reviewableInstructors(ROSTER, CC_PAIRS, 'katie_frost@sil.org', CC)).toEqual([])
    expect(reviewableInstructors(ROSTER, CC_PAIRS, 'nikkicm23@gmail.com', SONGS)).toEqual([])
    expect(reviewableInstructors(ROSTER, CC_PAIRS, null, CC)).toEqual([])
    expect(reviewableInstructors(ROSTER, CC_PAIRS, 'nikkicm23@gmail.com', null)).toEqual([])
  })

  it('matches an address case-insensitively, as the server does', () => {
    expect(names(reviewableInstructors(ROSTER, CC_PAIRS, 'Nikkicm23@Gmail.COM', CC))).toHaveLength(4)
  })

  it('never returns a trainee, even if a pair somehow names one', () => {
    const bogus = [...CC_PAIRS, pair('nikkicm23@gmail.com', MICAH.id)]
    expect(names(reviewableInstructors(ROSTER, bogus, 'nikkicm23@gmail.com', CC))).not.toContain(
      't-micah',
    )
  })

  it('answers reviewsAnyInstructor for exactly the three reviewers', () => {
    for (const who of ['josh_frost@sil.org', 'nikkicm23@gmail.com', 'viji_mathew@sil.org']) {
      expect(reviewsAnyInstructor(CC_PAIRS, who, CC)).toBe(true)
    }
    expect(reviewsAnyInstructor(CC_PAIRS, 'katie_frost@sil.org', CC)).toBe(false)
    // The two who teach and also evaluate the trainees. Their false here is what
    // takes the instructor event off their schedule, not just the picker.
    expect(reviewsAnyInstructor(CC_PAIRS, 'mathewtperumal@gmail.com', CC)).toBe(false)
    expect(reviewsAnyInstructor(CC_PAIRS, 'irene@sall.com', CC)).toBe(false)
    // Angie is a songs-workshop reviewer and holds nothing here.
    expect(reviewsAnyInstructor(CC_PAIRS, 'angeline_foo@sil.org', CC)).toBe(false)
  })
})

describe('rosterForActivity: which names an event puts on screen', () => {
  const teaching: Activity = {
    id: 'a-1',
    workshop_id: CC,
    title: 'Exegesis for OBT',
    day: '2026-08-18',
    start_time: null,
    end_time: null,
    sort_order: 3,
    genre_group: 'Teaching',
  }
  const instructorEvent: Activity = { ...teaching, id: 'a-ins', title: 'Instructor feedback', audience: 'instructor' }

  it('shows a teaching event the trainees and no facilitator', () => {
    expect(isInstructorActivity(teaching)).toBe(false)
    expect(names(rosterForActivity(teaching, ROSTER, CC_PAIRS, 'nikkicm23@gmail.com', CC))).toEqual([
      't-micah',
    ])
  })

  it('shows the instructor event only what the viewer holds a pair for', () => {
    expect(isInstructorActivity(instructorEvent)).toBe(true)
    expect(
      names(rosterForActivity(instructorEvent, ROSTER, CC_PAIRS, 'josh_frost@sil.org', CC)),
    ).toEqual(['i-irene', 'i-mathew'])
  })

  // An administrator opening the event holds no pairs. Showing them the whole
  // instructor roster would offer a capture the insert policy then refuses.
  it('shows an administrator with no pairs nobody at all', () => {
    expect(rosterForActivity(instructorEvent, ROSTER, CC_PAIRS, 'katie_frost@sil.org', CC)).toEqual([])
  })

  // The other direction of the 2026-08-18 narrowing, and the half that would
  // announce itself as a broken workshop rather than as a quiet leak: losing the
  // instructor pairs must not cost Mathew and Irene the trainees they are here to
  // evaluate. Their instructor event is empty; their teaching event is not.
  it('leaves the two facilitator-evaluators their trainees', () => {
    for (const who of ['mathewtperumal@gmail.com', 'irene@sall.com']) {
      expect(names(rosterForActivity(teaching, ROSTER, CC_PAIRS, who, CC))).toEqual(['t-micah'])
      expect(rosterForActivity(instructorEvent, ROSTER, CC_PAIRS, who, CC)).toEqual([])
    }
  })

  it('stamps a capture with the kind its event collects', () => {
    expect(subjectKindFor(teaching)).toBe('participant')
    expect(subjectKindFor(instructorEvent)).toBe('instructor')
    expect(subjectKindFor(undefined)).toBe('participant')
  })
})

describe('scopeEvidence: instructor evidence never lands in a trainee aggregate', () => {
  const obs = (over: Partial<ObservationRecord> & { id: string }): ObservationRecord => ({
    capture_client_id: `cap-${over.id}`,
    workshop_id: CC,
    participant_id: MICAH.id,
    participant_name: 'Micah Limboo',
    ksa_code: 'CC-OR1',
    text: 'said a thing',
    source_excerpt: 'said a thing',
    evidence_designation: 2,
    sentiment_flag: 'neutral',
    confidence: 'high',
    needs_review: false,
    origin: 'individual',
    imported_at: '2026-08-19T09:00:00.000Z',
    evaluator_email: 'nikkicm23@gmail.com',
    ...over,
  })

  const evaluation = (over: Partial<EvaluationRecord> & { client_id: string }): EvaluationRecord => ({
    evaluator_email: 'nikkicm23@gmail.com',
    activity_id: 'a-1',
    workshop_id: CC,
    source_language: 'English',
    answers: {},
    source_text: '',
    participant_scope: [],
    attestation: true,
    ruleset_version: null,
    edit_history: [],
    created_at: '2026-08-19T09:00:00.000Z',
    updated_at: '2026-08-19T09:00:00.000Z',
    sync_status: 'synced',
    ...over,
  })

  const traineeObs = obs({ id: 'o-trainee' })
  // No subject_kind at all: every observation routed before tl-30 looks like this
  // and must keep counting as trainee evidence.
  const legacyObs = obs({ id: 'o-legacy', subject_kind: undefined })
  const instructorObs = obs({
    id: 'o-instructor',
    subject_kind: 'instructor',
    participant_id: JOSH.id,
    participant_name: 'Joshua C. Frost',
    ksa_code: 'CC-INS2',
    text: 'handed over cleanly after the APM session',
  })

  const scoped = scopeEvidence({
    workshopId: CC,
    participants: ROSTER,
    observations: [traineeObs, legacyObs, instructorObs],
    evaluations: [
      evaluation({ client_id: 'cap-o-trainee' }),
      evaluation({ client_id: 'cap-o-legacy' }),
      evaluation({ client_id: 'cap-o-instructor', subject_kind: 'instructor' }),
    ],
  })

  it('puts only trainees in participants and only facilitators in instructorRoster', () => {
    expect(names(scoped.participants)).toEqual(['t-micah'])
    expect(names(scoped.instructorRoster)).toEqual(['i-irene', 'i-josh', 'i-mathew', 'i-viji'])
  })

  it('keeps instructor observations out of the trainee set and does not lose them', () => {
    expect(scoped.observations.map((o) => o.id).sort()).toEqual(['o-legacy', 'o-trainee'])
    expect(scoped.instructorObservations.map((o) => o.id)).toEqual(['o-instructor'])
  })

  it('splits the captures the same way', () => {
    expect(scoped.evaluations.map((e) => e.client_id).sort()).toEqual(['cap-o-legacy', 'cap-o-trainee'])
    expect(scoped.instructorEvaluations.map((e) => e.client_id)).toEqual(['cap-o-instructor'])
  })

  it('does not report an instructor observation as stranded', () => {
    expect(scoped.unresolved.every((o) => !isInstructorRecord(o))).toBe(true)
  })

  it('treats an absent subject_kind as trainee everywhere', () => {
    expect(isInstructorRecord(legacyObs)).toBe(false)
    expect(traineeRecords([traineeObs, legacyObs, instructorObs]).map((o) => o.id)).toEqual([
      'o-trainee',
      'o-legacy',
    ])
  })
})

describe('instructorReviewPk', () => {
  it('lowercases the address so one grant cannot become two rows', () => {
    expect(instructorReviewPk(CC, 'Nikkicm23@Gmail.com', 'i-josh')).toBe(
      instructorReviewPk(CC, 'nikkicm23@gmail.com', 'i-josh'),
    )
  })
})

/**
 * The review fix of 2026-08-18. The original line was
 * `local?.subject_kind ?? 'participant'`, which is a relabelling rather than a
 * default: it ran on the repo-pull path, the one path whose whole purpose is
 * importing work this device never recorded, and 'participant' is the value that
 * makes a row readable by every evaluating member of the workshop.
 */
describe('subjectKindForImport: what an imported observation is about', () => {
  it('takes the capture, which is what the insert policy checked', () => {
    expect(subjectKindForImport('instructor', 'participant')).toBe('instructor')
    expect(subjectKindForImport('participant', 'instructor')).toBe('participant')
  })

  it('falls back to the roster when this device does not hold the capture', () => {
    expect(subjectKindForImport(undefined, 'instructor')).toBe('instructor')
    expect(subjectKindForImport(null, 'instructor')).toBe('instructor')
  })

  it('keeps an unrecognized subject as trainee evidence', () => {
    expect(subjectKindForImport(undefined, undefined)).toBe('participant')
    expect(subjectKindForImport(undefined, null)).toBe('participant')
  })
})
