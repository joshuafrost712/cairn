import { db } from '../db/local'
import { observationsCrossingThreshold, type ImpactCounts } from './impact'
import type { EvaluationRecord, Ksa, ObservationRecord } from '../lib/types'

/**
 * The numbers the change dialog quotes, read from the on-device store.
 *
 * Deliberately thin: no classification, no wording, no severity. Every judgment
 * lives in impact.ts, which is pure and tested; this file only counts. If a
 * function here starts deciding what a number means, that decision has escaped its
 * tests.
 *
 * These read the LOCAL store, which is the honest scope. The device knows the
 * observations it has pulled, and a count is a decision aid rather than a
 * guarantee — so where the local store may not hold everything (an admin who has
 * not synced today), the dialog says "on this device" rather than implying it has
 * counted the world. That wording is in chrome.json, not here.
 */

/**
 * Every observation belonging to a workshop, including the pre-tl-04 rows whose
 * `workshop_id` is still null.
 *
 * The null rows are exactly the stranded phone-evaluation history tl-18 is
 * recovering, and they are attached to real participants. Scoping only on
 * `workshop_id` would UNDERSTATE what a delete costs on precisely the devices
 * holding the most at-risk evidence, so they are resolved through the participant
 * instead of skipped.
 */
async function workshopObservations(workshopId: string): Promise<ObservationRecord[]> {
  const [byWorkshop, participants] = await Promise.all([
    db.observations.where('workshop_id').equals(workshopId).toArray(),
    db.participants.where('workshop_id').equals(workshopId).toArray(),
  ])
  const participantIds = new Set(participants.map((p) => p.id))
  const seen = new Set(byWorkshop.map((o) => o.id))
  const orphans = (await db.observations.toArray()).filter(
    (o) => !seen.has(o.id) && o.workshop_id == null && o.participant_id && participantIds.has(o.participant_id),
  )
  return [...byWorkshop, ...orphans]
}

/** Submitted (attested) captures in a workshop. A draft capture invalidates nothing. */
async function submittedCaptures(workshopId: string): Promise<EvaluationRecord[]> {
  const rows = await db.evaluations.where('workshop_id').equals(workshopId).toArray()
  return rows.filter((e) => e.attestation === true)
}

const distinctParticipants = (obs: ObservationRecord[]): number =>
  new Set(obs.map((o) => o.participant_id).filter(Boolean)).size

async function verdictsOn(obs: ObservationRecord[]): Promise<number> {
  if (obs.length === 0) return 0
  const ids = new Set(obs.map((o) => o.id))
  const all = await db.verifications.toArray()
  return all.filter((v) => ids.has(v.observation_id)).length
}

/**
 * A question's exposure. Observations are joined on `ksa_code`, not on the row id —
 * which is exactly why renaming a code is a classified change rather than a rename.
 */
export async function countsForQuestion(ksa: Ksa, workshopId: string): Promise<ImpactCounts> {
  const [obsAll, captures, links] = await Promise.all([
    workshopObservations(workshopId),
    submittedCaptures(workshopId),
    db.activityKsas.where('ksa_id').equals(ksa.id).toArray(),
  ])
  const obs = obsAll.filter((o) => o.ksa_code === ksa.code)
  const participants = distinctParticipants(obs)
  return {
    observations: obs.length,
    scored: obs.length,
    participants,
    reports: participants,
    verdicts: await verdictsOn(obs),
    captures: captures.filter((e) => Boolean(e.answers?.[ksa.id]?.trim())).length,
    wiredEvents: links.length,
  }
}

/** An event's exposure: the captures recorded against it and what they produced. */
export async function countsForEvent(activityId: string, workshopId: string): Promise<ImpactCounts> {
  const [obsAll, captures] = await Promise.all([
    workshopObservations(workshopId),
    submittedCaptures(workshopId),
  ])
  const mine = captures.filter((e) => e.activity_id === activityId)
  const captureIds = new Set(mine.map((e) => e.client_id))
  const obs = obsAll.filter((o) => captureIds.has(o.capture_client_id))
  const participants = distinctParticipants(obs)
  return {
    captures: mine.length,
    observations: obs.length,
    participants,
    reports: participants,
    verdicts: await verdictsOn(obs),
  }
}

/** Rewiring an event is judged by whether that event has already been captured. */
export const countsForWiring = countsForEvent

export async function countsForParticipant(participantId: string): Promise<ImpactCounts> {
  const obs = await db.observations.where('participant_id').equals(participantId).toArray()
  return {
    observations: obs.length,
    scored: obs.length,
    participants: obs.length > 0 ? 1 : 0,
    reports: obs.length > 0 ? 1 : 0,
    verdicts: await verdictsOn(obs),
  }
}

export async function countsForTeam(teamId: string): Promise<ImpactCounts> {
  return { teamMembers: await db.participants.where('team_id').equals(teamId).count() }
}

/** What a whole workshop holds: authored setup and recorded evidence, counted apart. */
export async function countsForWorkshop(workshopId: string): Promise<ImpactCounts> {
  const [obs, captures, events, participants, links] = await Promise.all([
    workshopObservations(workshopId),
    submittedCaptures(workshopId),
    db.activities.where('workshop_id').equals(workshopId).count(),
    db.participants.where('workshop_id').equals(workshopId).count(),
    db.activityKsas.toArray(),
  ])
  const eventIds = new Set(
    (await db.activities.where('workshop_id').equals(workshopId).toArray()).map((a) => a.id),
  )
  return {
    observations: obs.length,
    captures: captures.length,
    participants,
    reports: distinctParticipants(obs),
    verdicts: await verdictsOn(obs),
    events,
    // Questions are a global library (tl-08 gives them a workshop_id), so what a
    // workshop delete costs in questions is the ones WIRED to its events, not the
    // whole library. Saying "42 questions" about a shared library would be a
    // fabricated number in a dialog whose entire value is that its numbers are real.
    questions: new Set(links.filter((l) => eventIds.has(l.activity_id)).map((l) => l.ksa_id)).size,
  }
}

/**
 * How much a verification-threshold change costs, in observations that cross the
 * verified line.
 *
 * Confirm counts are computed here rather than through reports/verification.ts's
 * `observationStatus`, because that function reads the CURRENT threshold from
 * localStorage and this question is about two thresholds at once.
 */
export async function countsForThreshold(
  workshopId: string,
  before: number,
  after: number,
): Promise<ImpactCounts> {
  const obs = await workshopObservations(workshopId)
  const verdicts = await db.verifications.toArray()
  const byObservation = new Map<string, { confirms: number; rejects: number }>()
  for (const v of verdicts) {
    const entry = byObservation.get(v.observation_id) ?? { confirms: 0, rejects: 0 }
    if (v.decision === 'reject') entry.rejects++
    else entry.confirms++
    byObservation.set(v.observation_id, entry)
  }

  // A disputed observation is already blocked by the gate, so a threshold move
  // changes nothing about it. Counting it would overstate the cost.
  const live = obs.filter((o) => (byObservation.get(o.id)?.rejects ?? 0) === 0)
  const confirmCounts = live.map((o) => byObservation.get(o.id)?.confirms ?? 0)
  const crossing = observationsCrossingThreshold(confirmCounts, before, after)

  const lo = Math.min(before, after)
  const hi = Math.max(before, after)
  const affected = live.filter((o) => {
    const count = byObservation.get(o.id)?.confirms ?? 0
    return count >= lo && count < hi
  })
  return { crossing, participants: distinctParticipants(affected), observations: crossing }
}
