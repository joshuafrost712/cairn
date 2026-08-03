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
      workshop_id: null, // not available on ObservationRecord; can be joined later
      trigger_observation_id: obs.id,
      trigger_ksa_code: obs.ksa_code,
      trigger_designation: d,
      trigger_activity_id: null, // not available on ObservationRecord
      status: 'needed',
      scheduled_for: null,
      summary: null,
      participant_response: null,
      recorded_by: null,
      created_at: nowIso,
      updated_at: nowIso,
      sync_status: 'local',
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Reconcile (async, idempotent)
// ---------------------------------------------------------------------------

/**
 * Read all annotated observations + participants from Dexie, derive the needed
 * conversations, then insert any that do not already exist. Existing records
 * (in any status) are never overwritten — history is preserved.
 *
 * Safe to call after every verification pass.
 */
export async function reconcileMentoringConversations(): Promise<{ added: number }> {
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
  for (const conv of derived) {
    const existing = await db.mentoringConversations.get(conv.id)
    if (!existing) {
      await db.mentoringConversations.put(conv)
      added++
    }
    // Existing records are left as-is regardless of their current status.
  }
  return { added }
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
