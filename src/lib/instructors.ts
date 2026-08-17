/**
 * Instructor feedback: the category questions, in one place (tl-30).
 *
 * Pure. No IO, no Dexie, no React — the same contract impact.ts and goals.ts
 * hold, and for the same reason: these are decisions that are easy to get subtly
 * wrong and impossible to eyeball afterwards.
 *
 * THREE RESOLUTIONS LIVE HERE, AND NOWHERE ELSE.
 *
 *  1. **What kind a roster row is.** `category` is optional on the type and NOT
 *     NULL DEFAULT 'participant' in Postgres, so absent and 'participant' are the
 *     same answer. Every reader asks `categoryOf()` rather than writing
 *     `p.category === 'instructor'`, because the negation of that expression is
 *     the one that goes wrong: `p.category !== 'instructor'` is accidentally
 *     correct, `p.category === 'participant'` silently drops every row the
 *     backend defaulted.
 *
 *  2. **Who a reviewer may review.** `reviewableInstructors()` is the only place
 *     the pair list is turned into a roster. It mirrors `may_review_instructor()`
 *     in the tl-30 migration.
 *
 *  3. **Which roster an event wants.** `rosterForActivity()` answers it once, so
 *     the capture screen, the coverage summary and the Setup preview cannot
 *     disagree about whether Joshua's name belongs in the grid.
 *
 * **Not a security boundary.** Every rule here is re-derived server-side by RLS
 * from `auth.uid()`, so a client that skips these checks gets an empty result
 * rather than a privilege. Keep them in step anyway: a mirror that drifts either
 * hides a review somebody is entitled to give, or offers one the insert will
 * refuse after they have dictated three paragraphs into it.
 *
 * THE RULE A FUTURE EDITOR WILL VIOLATE: do not reintroduce "everyone may review
 * everyone except themselves" as a shortcut, however much of the data it happens
 * to fit. Viji Mathew is reviewed only by Nikki and Angie while reviewing all the
 * other facilitators, and that asymmetry is Joshua's instruction, not an
 * accident of how the rows were seeded.
 */

import type {
  Activity,
  ActivityAudience,
  InstructorReviewPair,
  Participant,
  ParticipantCategory,
} from './types'

/** A roster row's kind. Absent means trainee, which is what the column defaults to. */
export function categoryOf(p: Pick<Participant, 'category'>): ParticipantCategory {
  return p.category === 'instructor' ? 'instructor' : 'participant'
}

/** An event's audience. Absent means the trainee roster, as every pre-tl-30 event is. */
export function audienceOf(a: Pick<Activity, 'audience'> | null | undefined): ActivityAudience {
  return a?.audience === 'instructor' ? 'instructor' : 'participant'
}

/** Whether this event collects instructor feedback rather than trainee evaluation. */
export function isInstructorActivity(a: Pick<Activity, 'audience'> | null | undefined): boolean {
  return audienceOf(a) === 'instructor'
}

/** The trainee half of a roster. What every pre-tl-30 surface meant by "participants". */
export function trainees<T extends Pick<Participant, 'category'>>(rows: readonly T[]): T[] {
  return rows.filter((p) => categoryOf(p) === 'participant')
}

/** The teaching half of a roster, unfiltered by permission. */
export function instructors<T extends Pick<Participant, 'category'>>(rows: readonly T[]): T[] {
  return rows.filter((p) => categoryOf(p) === 'instructor')
}

/** Emails are compared lowercased everywhere; the Postgres column is constrained to it. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * The instructors this person may review in this workshop.
 *
 * Self-exclusion is NOT computed here, and that is deliberate: it is expressed by
 * the absence of a pair, enforced by a trigger on the table, and re-checked by
 * the insert policy. Filtering "not me" a fourth time in the client would look
 * like the rule when it is only a consequence, and would quietly paper over a
 * self-pair that had somehow been written rather than letting it show.
 */
export function reviewableInstructors<T extends Pick<Participant, 'id' | 'category' | 'workshop_id'>>(
  roster: readonly T[],
  pairs: readonly InstructorReviewPair[],
  viewerEmail: string | null | undefined,
  workshopId: string | null | undefined,
): T[] {
  const me = normalizeEmail(viewerEmail)
  if (!me || !workshopId) return []
  const allowed = new Set(
    pairs
      .filter((r) => r.workshop_id === workshopId && normalizeEmail(r.reviewer_email) === me)
      .map((r) => r.instructor_participant_id),
  )
  if (allowed.size === 0) return []
  return roster.filter((p) => categoryOf(p) === 'instructor' && allowed.has(p.id))
}

/**
 * Does this person hold any pair in this workshop?
 *
 * This, and nothing else, is what reveals the Instructor feedback event on the
 * home screen. It mirrors `reviews_any_instructor()` in the migration, where the
 * same fact gates `activity_select`. There is deliberately no separate flag, so
 * there is nothing that can come to disagree with the pairs themselves.
 */
export function reviewsAnyInstructor(
  pairs: readonly InstructorReviewPair[],
  viewerEmail: string | null | undefined,
  workshopId: string | null | undefined,
): boolean {
  const me = normalizeEmail(viewerEmail)
  if (!me || !workshopId) return false
  return pairs.some((r) => r.workshop_id === workshopId && normalizeEmail(r.reviewer_email) === me)
}

/**
 * The roster to show for one event: the people this viewer may evaluate here.
 *
 * For a teaching event that is every trainee, unchanged from before tl-30. For
 * the Instructor feedback event it is the reviewer's own pair list, which may
 * legitimately be shorter than the instructor roster and may legitimately be
 * empty — an administrator opening the event holds no pairs and should see no
 * names rather than all of them.
 */
export function rosterForActivity<
  T extends Pick<Participant, 'id' | 'category' | 'workshop_id'>,
>(
  activity: Pick<Activity, 'audience'> | null | undefined,
  roster: readonly T[],
  pairs: readonly InstructorReviewPair[],
  viewerEmail: string | null | undefined,
  workshopId: string | null | undefined,
): T[] {
  return isInstructorActivity(activity)
    ? reviewableInstructors(roster, pairs, viewerEmail, workshopId)
    : trainees(roster)
}

/** What a capture started on this event records as its `subject_kind`. */
export function subjectKindFor(a: Pick<Activity, 'audience'> | null | undefined): ParticipantCategory {
  return audienceOf(a)
}

/**
 * Is this row about an instructor?
 *
 * Used to keep instructor evidence out of every trainee aggregate: heatmaps, day
 * emails, coverage counts, the discrepancy inbox and the mentoring trigger. The
 * argument is the row rather than a boolean so call sites read as a filter and so
 * an absent `subject_kind` (every row written before this migration) resolves the
 * same way the database resolves it.
 */
export function isInstructorRecord(row: { subject_kind?: ParticipantCategory | null }): boolean {
  return row.subject_kind === 'instructor'
}

/** Drop instructor rows. The default posture for anything that reports on trainees. */
export function traineeRecords<T extends { subject_kind?: ParticipantCategory | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => !isInstructorRecord(r))
}

/** The Dexie key for a pair, flattened the way every other composite cache here is. */
export function instructorReviewPk(
  workshop_id: string,
  reviewer_email: string,
  instructor_participant_id: string,
): string {
  return `${workshop_id}::${normalizeEmail(reviewer_email)}::${instructor_participant_id}`
}
