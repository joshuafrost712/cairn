// Mentoring conversation subsystem.
//
// A mentoring conversation is triggered whenever a verified/adjusted observation
// lands on a point its workshop marked `is_low_trigger`. One conversation record
// per observation; id = `mc::${observation_id}` so reconcile is idempotent.
//
// THE TRIGGER IS DECLARATIVE (tl-09), and it is the reason the scale had to
// become configurable rather than merely relabelable. Until this spec the test
// was `d !== 0 && d !== 1`, in the client and in a check constraint on the table.
// On a 5-point scale where 3 is adequate, that rule creates hard follow-up
// conversations for participants who are doing fine and creates none for the ones
// who are not — with nothing on any screen looking wrong. Making the scale
// configurable without making this test declarative would have shipped exactly
// that bug, which is why the spec pairs them.
//
// Status lifecycle:
//   needed → scheduled (date set via scheduleConversation)
//   needed | scheduled → completed (summary recorded)
//   needed | scheduled → dismissed (evaluator opts out)

import { db } from './local'
import { annotateObservations, type AnnotatedObservation } from '../reports/verification'
import { scaleForWorkshop } from './scale'
import { DEFAULT_SCALE, isLowTrigger, type Scale } from '../lib/scale'
import type { MentoringConversation, Participant } from '../lib/types'

// ---------------------------------------------------------------------------
// Pure derivation — no IO
// ---------------------------------------------------------------------------

/**
 * Given the full set of annotated observations and a map from participant_id to
 * Participant, return one MentoringConversation stub per observation that is:
 *   - vstatus === 'verified' or 'adjusted', AND
 *   - whose effective_designation sits on a low-trigger point of ITS OWN
 *     workshop's scale.
 *
 * Disputed, pending, or set-aside observations are not triggers.
 *
 * PER WORKSHOP, NOT PER DEVICE (tl-09). `scaleFor` is a function rather than a
 * single Scale because this runs over every observation on the device and two
 * workshops in one deployment may score on different scales — resolving against
 * the active workshop's scale would derive one workshop's conversations by the
 * other's rules. Unresolvable workshops fall to the app's original 0-3, which
 * reproduces exactly the behaviour this function had before this spec.
 *
 * @param annotated         Full result of annotateObservations().
 * @param participantsById  Map from participant_id → Participant (for the name).
 * @param nowIso            ISO timestamp to stamp created_at / updated_at.
 * @param scaleFor          Resolver from workshop id to that workshop's scale.
 */
export function deriveNeededConversations(
  annotated: AnnotatedObservation[],
  participantsById: Map<string, Participant>,
  nowIso: string,
  scaleFor: (workshopId: string | null) => Scale = () => DEFAULT_SCALE,
): MentoringConversation[] {
  const results: MentoringConversation[] = []

  for (const obs of annotated) {
    if (obs.participant_id === null) continue
    if (obs.vstatus !== 'verified' && obs.vstatus !== 'adjusted') continue
    const d = obs.effective_designation
    if (!isLowTrigger(scaleFor(obs.workshop_id), d)) continue

    const p = participantsById.get(obs.participant_id)
    results.push({
      id: `mc::${obs.id}`,
      participant_id: obs.participant_id,
      participant_name: p?.name ?? obs.participant_name,
      // tl-05: taken from the observation, which has carried a workshop_id since
      // tl-04. It used to be hardcoded null with a "can be joined later" note,
      // and later arrived: every policy on this table is written against
      // workshop_id, and `is_workshop_member(null)` is false, so a null here is
      // not an unfilled field — it is a row the backend will refuse forever.
      // Falls back to the participant's workshop, which is the same answer by a
      // different route and covers an observation imported before tl-04.
      workshop_id: obs.workshop_id ?? p?.workshop_id ?? null,
      trigger_observation_id: obs.id,
      trigger_ksa_code: obs.ksa_code,
      trigger_designation: d,
      trigger_activity_id: null, // not available on ObservationRecord
      status: 'needed',
      scheduled_for: null,
      summary: null,
      participant_response: null,
      recorded_by: null,
      assigned_to: null,
      assigned_by: null,
      assigned_at: null,
      admin_guidance: null,
      admin_guidance_updated_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      sync_status: 'local',
    })
  }

  return results
}

/**
 * What reconcile should do to one already-existing row, given the stub the
 * derivation just produced for the same trigger.
 *
 * Pure and separate from the IO so the rule can be tested directly, because the
 * rule is the whole risk in this spec: reconcile runs on every visit to the
 * conversations page, so a version of it that overwrites would quietly unassign
 * the entire queue on the next page load and look like nothing had happened.
 *
 * Returns null when the row should be left exactly as it is, which is the answer
 * for every field the admin or the assignee owns. The one repair it will make is
 * filling a workshop_id that was never set — rows derived before tl-05 all hold
 * null there and cannot sync until it is filled.
 */
export function reconcilePatch(
  existing: MentoringConversation,
  derived: MentoringConversation,
): Partial<MentoringConversation> | null {
  if (existing.workshop_id || !derived.workshop_id) return null
  return {
    workshop_id: derived.workshop_id,
    // Back into the outbox: the row could not have been accepted before, so it
    // has never reached the backend regardless of what its sync_status claims.
    sync_status: 'queued',
    sync_error: null,
  }
}

// ---------------------------------------------------------------------------
// Reconcile (async, idempotent)
// ---------------------------------------------------------------------------

/**
 * Read all annotated observations + participants from Dexie, derive the needed
 * conversations, then insert any that do not already exist. Existing records
 * (in any status) are never overwritten — history is preserved, and since tl-05
 * that explicitly includes the assignment and the guidance.
 *
 * Safe to call after every verification pass.
 */
export async function reconcileMentoringConversations(): Promise<{
  added: number
  repaired: number
}> {
  const [observations, verdicts, participants] = await Promise.all([
    db.observations.toArray(),
    db.verifications.toArray(),
    db.participants.toArray(),
  ])

  const annotated = annotateObservations(observations, verdicts)

  // One scale per workshop present in the evidence, resolved once. The map is
  // built here rather than inside the pure function so that function stays free
  // of IO, which is what lets test/mentoring.test.ts drive it with a 6-point
  // scale and no database.
  const workshopIds = [...new Set(observations.map((o) => o.workshop_id))]
  const scales = new Map<string | null, Scale>()
  for (const id of workshopIds) scales.set(id, await scaleForWorkshop(id))

  const participantsById = new Map(participants.map((p) => [p.id, p]))
  const nowIso = new Date().toISOString()
  const derived = deriveNeededConversations(
    annotated,
    participantsById,
    nowIso,
    (id) => scales.get(id) ?? DEFAULT_SCALE,
  )

  let added = 0
  let repaired = 0
  for (const conv of derived) {
    const existing = await db.mentoringConversations.get(conv.id)
    if (!existing) {
      await db.mentoringConversations.put(conv)
      added++
      continue
    }
    // Existing records keep their status, their outcome, their assignment and
    // their guidance. The only write reconcile will make to one is the
    // workshop_id repair, and reconcilePatch decides that, not this loop.
    const patch = reconcilePatch(existing, conv)
    if (patch) {
      await db.mentoringConversations.update(conv.id, patch)
      repaired++
    }
  }
  return { added, repaired }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** All conversations, most-recently-updated first. */
export async function listConversations(): Promise<MentoringConversation[]> {
  const all = await db.mentoringConversations.toArray()
  // updated_at is not an index; sort in memory (ISO strings sort lexically).
  return all.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
}

/**
 * Generic partial update. Stamps updated_at and re-queues for sync — the
 * fields callers change here (status / schedule / notes / recorded_by) are all
 * Supabase-relevant, so a synced row rejoins the outbox.
 */
export async function updateConversation(
  id: string,
  patch: Partial<Omit<MentoringConversation, 'id' | 'created_at'>>,
): Promise<void> {
  await db.mentoringConversations.update(id, {
    ...patch,
    updated_at: new Date().toISOString(),
    sync_status: 'queued',
  })
}

/** Set a scheduled date and advance status to 'scheduled'. */
export async function scheduleConversation(id: string, dateIso: string): Promise<void> {
  await updateConversation(id, { status: 'scheduled', scheduled_for: dateIso })
}

/** Record that a conversation occurred and advance status to 'completed'. */
export async function completeConversation(
  id: string,
  opts: { summary: string; participant_response: string; recorded_by: string | null },
): Promise<void> {
  await updateConversation(id, {
    status: 'completed',
    summary: opts.summary,
    participant_response: opts.participant_response,
    recorded_by: opts.recorded_by,
  })
}

/** Mark a conversation as dismissed (no further follow-up planned). */
export async function dismissConversation(id: string): Promise<void> {
  await updateConversation(id, { status: 'dismissed' })
}

// ---------------------------------------------------------------------------
// tl-05: assignment and guidance
//
// All three go through updateConversation, so the updated_at stamp and the
// re-queue live in one place and an assignment cannot be written by a path that
// forgets to sync it.
// ---------------------------------------------------------------------------

/** Emails are compared lowercased everywhere; normalize at the one write site. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Hand a conversation to an evaluator. Reassignment is the same call: it
 * overwrites who, by whom, and when, and deliberately leaves `admin_guidance`
 * alone, because the guidance is about how to open this conversation with this
 * participant and does not stop being true when a different person takes it.
 */
export async function assignConversation(
  id: string,
  opts: { assignedTo: string; assignedBy: string | null; nowIso?: string },
): Promise<void> {
  await updateConversation(id, {
    assigned_to: normalizeEmail(opts.assignedTo),
    assigned_by: opts.assignedBy ? normalizeEmail(opts.assignedBy) : null,
    assigned_at: opts.nowIso ?? new Date().toISOString(),
  })
}

/** Return a conversation to the unassigned pool. Guidance survives this too. */
export async function unassignConversation(id: string): Promise<void> {
  await updateConversation(id, {
    assigned_to: null,
    assigned_by: null,
    assigned_at: null,
  })
}

/**
 * Write the admin's guidance, independently of who holds the conversation, so an
 * admin can think about how it should be opened before deciding who is right to
 * open it. The stamp is what tl-06 uses to tell an evaluator the guidance changed
 * after they last read it.
 */
export async function setAdminGuidance(
  id: string,
  guidance: string,
  nowIso?: string,
): Promise<void> {
  const trimmed = guidance.trim()
  await updateConversation(id, {
    admin_guidance: trimmed === '' ? null : trimmed,
    admin_guidance_updated_at: nowIso ?? new Date().toISOString(),
  })
}

export interface EvaluatorLoad {
  email: string
  /** Assigned and not yet finished: what the person is actually carrying. */
  open: number
  /** Of the open ones, those with a date already set. */
  scheduled: number
  completed: number
}

/**
 * How much each evaluator is carrying, so assignment is not blind.
 *
 * Pure, and takes the roster of evaluators rather than deriving it from the
 * conversations, because the answer an admin needs includes the people carrying
 * nothing — those are the ones with room, and a group-by over the conversations
 * would omit exactly them.
 */
export function evaluatorLoads(
  conversations: MentoringConversation[],
  evaluatorEmails: string[],
): EvaluatorLoad[] {
  const byEmail = new Map<string, EvaluatorLoad>()
  for (const email of evaluatorEmails) {
    const key = normalizeEmail(email)
    if (!byEmail.has(key)) byEmail.set(key, { email: key, open: 0, scheduled: 0, completed: 0 })
  }

  for (const c of conversations) {
    if (!c.assigned_to) continue
    const key = normalizeEmail(c.assigned_to)
    // Somebody who has left the workshop still shows here while they hold work.
    // Dropping them would make the queue add up to less than it contains.
    let load = byEmail.get(key)
    if (!load) {
      load = { email: key, open: 0, scheduled: 0, completed: 0 }
      byEmail.set(key, load)
    }
    if (c.status === 'completed') load.completed++
    else if (c.status === 'dismissed') continue
    else {
      load.open++
      if (c.status === 'scheduled') load.scheduled++
    }
  }

  return [...byEmail.values()].sort(
    (a, b) => b.open - a.open || a.email.localeCompare(b.email),
  )
}
