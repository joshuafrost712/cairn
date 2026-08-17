/**
 * Instructor reviewer pairs: the reads the app makes, and the one write (tl-30).
 *
 * The pure half of this feature is in src/lib/instructors.ts; this module is the
 * IO. It holds no rule of its own, so a question about who may review whom is
 * answered by that file and enforced by
 * supabase/migrations/20260817000100_instructor_feedback.sql.
 */

import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { instructorReviewPk, normalizeEmail } from '../lib/instructors'
import type { InstructorReviewPair } from '../lib/types'

/**
 * Every pair cached on this device.
 *
 * Deliberately unfiltered: the backend has already narrowed the rows to the ones
 * this account may see (`instructor_reviewer_select`), and a second workshop
 * filter here would have to be threaded through five call sites to say the same
 * thing. Callers pass the workshop to `reviewableInstructors()` instead, which is
 * where the scoping question belongs.
 */
export function allReviewPairs(): Promise<InstructorReviewPair[]> {
  return db.instructorReviewPairs.toArray()
}

/** The pairs held by one person in one workshop. */
export function reviewPairsFor(
  workshopId: string,
  email: string | null | undefined,
): Promise<InstructorReviewPair[]> {
  const me = normalizeEmail(email)
  if (!me) return Promise.resolve([])
  return db.instructorReviewPairs
    .where('workshop_id')
    .equals(workshopId)
    .filter((r) => normalizeEmail(r.reviewer_email) === me)
    .toArray()
}

/** Every pair in one workshop. The administrator's view of the whole matrix. */
export function reviewPairsInWorkshop(workshopId: string): Promise<InstructorReviewPair[]> {
  return db.instructorReviewPairs.where('workshop_id').equals(workshopId).toArray()
}

export type PairWriteResult =
  | { ok: true; outcome: 'granted' | 'revoked' }
  | { ok: false; message: string }

/**
 * Grant or revoke one pair, through the chief-admin-gated RPC.
 *
 * Online-only and deliberately so. Every other write in this app is queued to an
 * outbox because losing an evaluator's dictation would be unacceptable; a
 * permission change is the opposite case. A revoke that sat in an outbox would
 * leave the client showing "removed" while the database still allowed the review,
 * which is exactly the disagreement this feature must not have. Better to refuse
 * the change and say the network is down.
 *
 * The local cache is updated optimistically on success rather than waiting for
 * the next reference pull, so the Setup grid repaints immediately; the next pull
 * overwrites it from the server either way.
 */
export async function setInstructorReviewPair(
  workshopId: string,
  reviewerEmail: string,
  instructorParticipantId: string,
  allowed: boolean,
): Promise<PairWriteResult> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return { ok: false, message: 'This change needs a connection. Try again when you are online.' }
  }
  const email = normalizeEmail(reviewerEmail)
  try {
    const { error } = await supabase.rpc('set_instructor_review_pair', {
      _workshop_id: workshopId,
      _reviewer_email: email,
      _instructor_id: instructorParticipantId,
      _allowed: allowed,
    })
    if (error) return { ok: false, message: readableRpcError(error.message) }

    const pk = instructorReviewPk(workshopId, email, instructorParticipantId)
    if (allowed) {
      await db.instructorReviewPairs.put({
        pk,
        workshop_id: workshopId,
        reviewer_email: email,
        instructor_participant_id: instructorParticipantId,
      })
    } else {
      await db.instructorReviewPairs.delete(pk)
    }
    return { ok: true, outcome: allowed ? 'granted' : 'revoked' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'That change could not be made.' }
  }
}

/**
 * The server's refusal slugs, turned into something an administrator can act on.
 *
 * The slugs are matched rather than the prose, because the prose is a Postgres
 * exception message and is not a contract. An unrecognised message is passed
 * through rather than replaced with a generic apology: the person seeing it is
 * the chief admin, and the raw text is more use to them than "something failed".
 */
function readableRpcError(message: string): string {
  if (message.includes('tl30.not_the_chief_admin_of_this_workshop')) {
    return 'Only the chief admin of this workshop can change who reviews the instructors.'
  }
  if (message.includes('tl30.self_review')) {
    return 'Somebody cannot be set to review themselves.'
  }
  if (message.includes('tl30.not_an_instructor')) {
    return 'That person is on the trainee roster, not the instructor roster.'
  }
  if (message.includes('tl30.participant_is_in_another_workshop')) {
    return 'That instructor belongs to a different workshop.'
  }
  if (message.includes('tl30.not_an_email')) return 'That does not look like an email address.'
  return message
}
