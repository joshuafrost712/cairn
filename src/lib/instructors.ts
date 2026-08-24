/**
 * Instructor feedback: the category questions, in one place (tl-30).
 *
 * Pure. No IO, no Dexie, no React — the same contract impact.ts and goals.ts
 * hold, and for the same reason: these are decisions that are easy to get subtly
 * wrong and impossible to eyeball afterwards.
 *
 * FOUR RESOLUTIONS LIVE HERE, AND NOWHERE ELSE.
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
 *  4. **Which questions a trainee capture may reach.** `participantFacingQuestions()`
 *     (tl-36), the wiring-derived answer to "is this an instructor question",
 *     because a question row carries no audience of its own.
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
  ActivityKsa,
  InstructorReviewPair,
  Participant,
  ParticipantCategory,
} from './types'

/** A roster row's kind. Absent means trainee, which is what the column defaults to. */
export function categoryOf(p: Pick<Participant, 'category'>): ParticipantCategory {
  return p.category === 'instructor' ? 'instructor' : 'participant'
}

/**
 * What kind of evidence an imported observation is, when the routed file comes
 * back (review fix, 2026-08-18).
 *
 * The capture wins, always: it is what `evaluation_insert` checked when the
 * reviewer wrote it, and a router file must never be able to relabel its own
 * evidence. The second argument is the fallback for the one path that admits a
 * capture this device never recorded, where the original code went straight to
 * 'participant' — the value that makes a row readable by every evaluating
 * member. The roster is the authority there, because `participant.category` is a
 * fact this device holds rather than a claim in the file being validated.
 *
 * A subject this device does not recognize stays trainee evidence, which is the
 * pre-tl-30 meaning of every row and is safe: it is the write policies, not this
 * function, that stop an instructor observation being created in the first place.
 */
export function subjectKindForImport(
  captureKind: ParticipantCategory | null | undefined,
  subjectCategory: ParticipantCategory | null | undefined,
): ParticipantCategory {
  if (captureKind) return categoryOf({ category: captureKind })
  return categoryOf({ category: subjectCategory ?? null })
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
 * The questions a trainee capture may reach: everything except the ones that
 * exist only to review the people teaching (tl-36).
 *
 * THE FOURTH RESOLUTION, and it belongs here for the reason the other three do.
 * A question carries no audience of its own — `audience` is a column on
 * `activity` — so "is this an instructor question" is answerable only through the
 * wiring, and answering it in two places is how a trainee brain dump ends up
 * routed against "Collaborative leadership".
 *
 * The rule: a question is instructor-only when it is wired to at least one event
 * and every event it is wired to has the instructor audience. Two consequences,
 * both deliberate.
 *
 * The rule is stated in terms of what is POSITIVELY known, and the review of this
 * spec is why. An earlier version asked "is every event it is wired to an
 * instructor event", treating an activity this device does not hold as evidence
 * FOR keeping the question. That inverted the answer on most real devices.
 * `activity_select` hides an instructor-audience event from any member holding
 * neither an `instructor_reviewer` pair nor `admin`, while `ksa_select` and
 * `activity_ksa_select` are plain `is_workshop_member` — so an ordinary
 * evaluator's cache holds `INSTR1`, `INSTR2`, `INSTR3` and their wiring rows and
 * NOT the event those rows point at. Five of Psalms' seven members are in that
 * state. Their free-write screen would have offered all three under a promise
 * that the app will file the words against the right questions, while the
 * administrator's device, which can see the event, routed without them: the two
 * surfaces disagreeing, which is the single thing `ksasInScopeFor` exists to make
 * impossible.
 *
 * So a link counts as evidence only when it points at an event this device can
 * see AND that event's audience is `participant`. A link to an event the device
 * cannot see is evidence of nothing, which on a trainee capture means the
 * question is left out.
 *
 * An UNWIRED question is kept. It carries no evidence either way, and a workshop
 * mid-setup has plenty; dropping them would make the free-write set silently
 * narrower than the workshop's own question list, which is the surprise this
 * function exists to prevent. "No links at all" and "links this device cannot
 * resolve" are therefore different answers, and the caller must not collapse them
 * by pre-filtering the links against the visible activities.
 *
 * A question wired to BOTH kinds of event is kept, because an administrator who
 * wired it to a teaching session meant it to be asked there. That is a wiring
 * mistake if it was one, and it is visible in Setup; a filter that hid it would
 * not be.
 *
 * **Not codes.** tl-36 as written named `CC-INS1`, `CC-INS2` and `CC-INS3`. The
 * Psalms workshop's three are `INSTR1`, `INSTR2` and `INSTR3`, so a code list
 * checked against the crash course would have leaked all three of Psalms' into
 * every free-write capture on the workshop this shipped for.
 */
export function participantFacingQuestions<K extends { id: string }>(
  ksas: readonly K[],
  links: readonly Pick<ActivityKsa, 'ksa_id' | 'activity_id'>[],
  activities: readonly Pick<Activity, 'id' | 'audience'>[],
): K[] {
  // `links` may be the WHOLE table; the scoping to these questions happens here
  // rather than in the caller, and the re-review is why. The caller's version of
  // this filter is what held the original defect, it was keyed on the activity,
  // and a regex test over the caller's source could only ever catch that one
  // spelling of it. Done here it is covered by the tests below and there is
  // nothing left for a caller to get wrong.
  const mine = new Set(ksas.map((k) => k.id))
  const audienceById = new Map(activities.map((a) => [a.id, audienceOf(a)] as const))
  const wired = new Map<string, boolean>()
  for (const link of links) {
    if (!mine.has(link.ksa_id)) continue
    const participantFacing =
      (wired.get(link.ksa_id) ?? false) || audienceById.get(link.activity_id) === 'participant'
    wired.set(link.ksa_id, participantFacing)
  }
  // `!wired.has(k.id)` is the unwired case and is kept; `false` means every link
  // it has is either an instructor event or an event this device cannot read.
  return ksas.filter((k) => !wired.has(k.id) || wired.get(k.id) === true)
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
