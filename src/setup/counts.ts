import { db } from '../db/local'
import { observationsCrossingThreshold, type ImpactCounts } from './impact'
import { annotateObservations } from '../reports/verification'
import { diffScales, isLowTrigger, type Scale, type ScalePoint } from '../lib/scale'
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
    // Reports whose headings move if this question changes goal (tl-08). Equal to
    // `reports` here because a question's evidence and its grouping touch the same
    // set of participants; kept as its own key so the regrouping consequence quotes
    // a number that means "reprinted", not "rescored".
    regrouped: participants,
    verdicts: await verdictsOn(obs),
    captures: captures.filter((e) => Boolean(e.answers?.[ksa.id]?.trim())).length,
    wiredEvents: links.length,
  }
}

/**
 * A goal's exposure (tl-08): what it groups, and how many reports reprint because
 * of it.
 *
 * `questions` is the number that become ungrouped if the goal is deleted, which is
 * the whole cost of a delete now that the questions themselves survive it.
 * `regrouped` is reports whose headings change — deliberately NOT `reports`, which
 * this file reserves for reports whose numbers change. Nothing is rescored by a
 * regrouping, and a dialog that used the same word for both would be claiming an
 * invalidation it cannot substantiate.
 */
export async function countsForGoal(goalId: string, workshopId: string): Promise<ImpactCounts> {
  const [ksas, obs] = await Promise.all([
    db.ksas.where('goal_id').equals(goalId).toArray(),
    workshopObservations(workshopId),
  ])
  const codes = new Set(ksas.map((k) => k.code))
  const affected = obs.filter((o) => codes.has(o.ksa_code))
  return {
    questions: ksas.length,
    observations: affected.length,
    participants: distinctParticipants(affected),
    regrouped: distinctParticipants(affected),
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
  const [obs, captures, events, participants, questions] = await Promise.all([
    workshopObservations(workshopId),
    submittedCaptures(workshopId),
    db.activities.where('workshop_id').equals(workshopId).count(),
    db.participants.where('workshop_id').equals(workshopId).count(),
    // Questions belong to the workshop now (tl-08), so this is a straight count.
    // It used to be "the questions wired to this workshop's events", because the
    // library was global and saying "42 questions" about a shared pool would have
    // been a fabricated number in a dialog whose whole value is that its numbers
    // are real. The scoped count is that same number, honestly arrived at.
    db.ksas.where('workshop_id').equals(workshopId).count(),
  ])
  return {
    observations: obs.length,
    captures: captures.length,
    participants,
    reports: distinctParticipants(obs),
    verdicts: await verdictsOn(obs),
    events,
    questions,
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

/**
 * A scale change's exposure (tl-09).
 *
 * Four numbers describe the SHAPE of the edit (added, removed, reworded,
 * re-triggered) and three describe what it costs: how many observations sit on a
 * point about to disappear, and how the follow-up queue would move if the
 * trigger set changes.
 *
 * The conversation numbers are computed against ANNOTATED observations rather
 * than raw ones, because only a verified or adjusted observation ever derives a
 * conversation. Counting raw ones would tell an administrator that flipping a
 * trigger creates forty follow-ups when it creates four, and a number that large
 * and that wrong stops the change rather than informing it.
 */
export async function countsForScale(
  workshopId: string,
  before: ScalePoint[],
  after: ScalePoint[],
): Promise<ImpactCounts> {
  const diff = diffScales(before, after)
  const obs = await workshopObservations(workshopId)
  const verdicts = await db.verifications.toArray()
  const annotated = annotateObservations(obs, verdicts)

  const scored = obs.filter((o) => o.evidence_designation != null)
  const removedSet = new Set(diff.removed)
  const stranded = scored.filter((o) => removedSet.has(o.evidence_designation))

  // What the follow-up queue would gain and lose. `confirmed` is the set that can
  // derive a conversation at all; the rest cannot, whatever the trigger set says.
  const confirmed = annotated.filter(
    (o) => o.vstatus === 'verified' || o.vstatus === 'adjusted',
  )
  const beforeScale: Scale = { workshop_id: workshopId, points: before }
  const afterScale: Scale = { workshop_id: workshopId, points: after }
  const existing = new Set(
    (await db.mentoringConversations.where('workshop_id').equals(workshopId).toArray()).map(
      (c) => c.trigger_observation_id,
    ),
  )

  let appearing = 0
  let stale = 0
  for (const o of confirmed) {
    const was = isLowTrigger(beforeScale, o.effective_designation)
    const now = isLowTrigger(afterScale, o.effective_designation)
    if (!was && now && !existing.has(o.id)) appearing++
    if (was && !now && existing.has(o.id)) stale++
  }

  return {
    addedPoints: diff.added.length,
    removedPoints: diff.removed.length,
    rewordedPoints: diff.reworded.length,
    retriggeredPoints: diff.retriggered.length,
    strandedObservations: stranded.length,
    scored: scored.length,
    observations: obs.length,
    participants: distinctParticipants(stranded.length > 0 ? stranded : scored),
    reports: distinctParticipants(scored),
    conversationsAppearing: appearing,
    conversationsStale: stale,
  }
}
