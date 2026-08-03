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
  activityByCapture: Map<string, string | null> = new Map(),
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
      // tl-06: resolved through the capture the observation came from, because an
      // ObservationRecord still carries no activity of its own. This is filled on
      // the DERIVING device, which is an administrator's since tl-06 removed the
      // evaluator's reconcile, and an administrator is the one device that holds
      // other people's captures (tl-03 pulls them to the routing page). The
      // assignee then receives the activity through the sync rather than needing
      // a capture that was never theirs. Null when the capture is not on this
      // device either, and the panel says so rather than inventing a title.
      trigger_activity_id: activityByCapture.get(obs.capture_client_id) ?? null,
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
      follow_up_needed: false,
      follow_up_note: null,
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
 * for every field the admin or the assignee owns. It makes exactly two repairs,
 * and both are of the same narrow kind: filling a field that was never set.
 *
 *   - `workshop_id`, because rows derived before tl-05 all hold null there and
 *     every policy on the table refuses them until it is filled.
 *   - `trigger_activity_id` (tl-06), because rows derived before tl-06 hold null
 *     there by construction and the evidence panel has no other way to name the
 *     activity on a device that does not hold the capture.
 *
 * Neither one overwrites a value that exists. A repair that could overwrite would
 * be indistinguishable from the bug this function is written to prevent.
 */
export function reconcilePatch(
  existing: MentoringConversation,
  derived: MentoringConversation,
): Partial<MentoringConversation> | null {
  const patch: Partial<MentoringConversation> = {}
  if (!existing.workshop_id && derived.workshop_id) patch.workshop_id = derived.workshop_id
  if (!existing.trigger_activity_id && derived.trigger_activity_id) {
    patch.trigger_activity_id = derived.trigger_activity_id
  }
  if (Object.keys(patch).length === 0) return null
  return {
    ...patch,
    // Back into the outbox. For the workshop repair the row could not have been
    // accepted before, so it has never reached the backend whatever its
    // sync_status claims; for the activity it has simply changed and owes a push.
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
  const [observations, verdicts, participants, evaluations, coverage] = await Promise.all([
    db.observations.toArray(),
    db.verifications.toArray(),
    db.participants.toArray(),
    db.evaluations.toArray(),
    db.coverage.toArray(),
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
  // Which activity each capture belongs to. Coverage first because it is the
  // workshop-wide cache (fed by realtime, so it holds other evaluators' captures
  // too) and the local evaluation second because it is the authority for this
  // device's own work. Either way it is best-effort: a capture on neither leaves
  // the activity null, which the panel renders as unknown rather than as absent.
  const activityByCapture = new Map<string, string | null>()
  for (const row of coverage) activityByCapture.set(row.client_id, row.activity_id)
  for (const e of evaluations) activityByCapture.set(e.client_id, e.activity_id)

  const nowIso = new Date().toISOString()
  const derived = deriveNeededConversations(
    annotated,
    participantsById,
    nowIso,
    (id) => scales.get(id) ?? DEFAULT_SCALE,
    activityByCapture,
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

/**
 * Record that a conversation occurred and advance status to 'completed'.
 *
 * tl-06 added the follow-up pair, and they are written here rather than through a
 * second call on purpose: an evaluator logs the outcome once, and a flag saved by
 * a separate save is a flag that gets lost when somebody closes the panel after
 * the first one.
 */
export interface OutcomeInput {
  summary: string
  participant_response: string
  recorded_by: string | null
  follow_up_needed?: boolean
  follow_up_note?: string | null
}

/**
 * What an outcome becomes on the row. Pure, so the two rules in it can be tested
 * without Dexie:
 *
 *   - an empty or whitespace note is null, not '', because the admin's filter and
 *     the drawer both ask "is there a note" and a blank string answers yes;
 *   - a note is dropped when the flag is not raised, so an evaluator who types a
 *     note and then unticks the box does not leave a flag-less note behind for an
 *     admin to find with no view that shows it.
 */
export function outcomeFields(opts: OutcomeInput): Partial<MentoringConversation> {
  const needed = opts.follow_up_needed === true
  const note = (opts.follow_up_note ?? '').trim()
  return {
    status: 'completed',
    summary: opts.summary,
    participant_response: opts.participant_response,
    recorded_by: opts.recorded_by,
    follow_up_needed: needed,
    follow_up_note: needed && note !== '' ? note : null,
  }
}

export async function completeConversation(id: string, opts: OutcomeInput): Promise<void> {
  await updateConversation(id, outcomeFields(opts))
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

// ---------------------------------------------------------------------------
// tl-06: what the assignee is looking at
//
// All pure, and all shared with the surfaces that must agree with them. The badge
// in the sidebar and the list on the page are the same question asked twice, and
// a badge reading 2 above a page listing 4 is worse than either number alone —
// which is exactly the failure tl-05 found and fixed with a filter. One predicate,
// imported by both, is what keeps that fixed.
// ---------------------------------------------------------------------------

/** Assigned and not yet finished. The badge counts these; the page lists them. */
export const OPEN_CONVERSATION_STATUSES = ['needed', 'scheduled'] as const

export function isOpenConversation(c: MentoringConversation): boolean {
  return (OPEN_CONVERSATION_STATUSES as readonly string[]).includes(c.status)
}

/**
 * The order an evaluator wants: unscheduled first, then by the date they set.
 *
 * The question this page answers is "what do I owe", not "what exists", and the
 * conversation with no date on it is the one owing a decision. Within the
 * unscheduled group the oldest comes first, because a follow-up that has been
 * waiting three days is more overdue than one raised this morning.
 */
export function compareForAssignee(a: MentoringConversation, b: MentoringConversation): number {
  const aSet = a.scheduled_for ? 1 : 0
  const bSet = b.scheduled_for ? 1 : 0
  if (aSet !== bSet) return aSet - bSet
  if (aSet === 1) {
    if (a.scheduled_for! !== b.scheduled_for!) return a.scheduled_for! < b.scheduled_for! ? -1 : 1
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Whether the guidance has been rewritten since this evaluator last opened the
 * row.
 *
 * Both arguments are ISO timestamps and both can legitimately be absent, so the
 * default matters: never seen before is NOT "changed". A conversation an
 * evaluator has never opened is already new to them, and marking its guidance as
 * changed on first sight would make the signal mean nothing on the day it is
 * needed most.
 */
export function guidanceChangedSince(
  c: MentoringConversation,
  lastViewedIso: string | null | undefined,
): boolean {
  if (!c.admin_guidance_updated_at) return false
  if (!lastViewedIso) return false
  return c.admin_guidance_updated_at > lastViewedIso
}

export interface ConversationEvidence {
  /** The observation that triggered it, or null when it has not reached this device. */
  trigger: AnnotatedObservation | null
  /** The same participant's other observations on the same question, newest first. */
  pattern: AnnotatedObservation[]
}

/**
 * The evidence behind one conversation: the observation that called for it, and
 * that participant's other observations on the same question.
 *
 * The pattern half is what turns a number into a conversation an evaluator can
 * actually open. A single confirmed 1 says almost nothing on its own; three of
 * them across the week, or one against four 2s, are different conversations, and
 * an evaluator who was not the one who captured it has no other way to tell.
 *
 * `trigger` being null is a real state rather than an error: tl-04 syncs
 * observations and conversations in one loop but not in one transaction, so an
 * assignment can land on a phone a cycle before the evidence does.
 */
export function conversationEvidence(
  c: MentoringConversation,
  annotated: AnnotatedObservation[],
): ConversationEvidence {
  const trigger = annotated.find((o) => o.id === c.trigger_observation_id) ?? null
  const ksa = trigger?.ksa_code ?? c.trigger_ksa_code
  const pattern = annotated
    .filter(
      (o) =>
        o.id !== c.trigger_observation_id &&
        o.participant_id === c.participant_id &&
        ksa !== null &&
        o.ksa_code === ksa,
    )
    .sort((a, b) => (a.imported_at < b.imported_at ? 1 : a.imported_at > b.imported_at ? -1 : 0))
  return { trigger, pattern }
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
