// The cross-workshop overview — pure logic, no IO.
//
// One card per workshop the signed-in person belongs to, answering "how is each
// of my workshops doing" without making them switch into each one to find out.
// tl-01 deferred cross-workshop reporting as "not a thing anybody has asked
// for"; Joshua asked on 2026-07-30, and this is the narrow version of it: per
// workshop numbers, never a combined matrix.
//
// Free of Dexie for the same reason syncHealth.ts is: the caller assembles the
// rows, so the arithmetic can be tested against fixtures rather than against a
// database that has to be put into eight different states.

import type {
  EvaluationRecord,
  ObservationRecord,
  VerificationVerdict,
  Workshop,
  WorkshopMember,
  WorkshopRole,
} from '../lib/types'
import type { WorkshopState } from '../setup/impact'
import { deriveWorkshopState } from '../setup/state'
import { buildSyncFunnel } from './syncHealth'
import { observationStatus } from './verification'

/** One entry in the switcher: a workshop the caller holds a membership in. */
export interface WorkshopOption {
  workshop_id: string
  role: WorkshopRole
  /**
   * The workshop's name, or null when the row is not on this device.
   *
   * A membership can arrive before the workshop row does: memberships come from
   * `workshop_member` at sign-in, the names come from the reference pull. On a
   * cold start, and offline, the switcher would otherwise render a blank option
   * that switches to something the user cannot identify. The renderer names the
   * gap instead.
   */
  name: string | null
  start_date: string | null
}

/**
 * Memberships joined to whatever workshop rows this device has, newest first.
 *
 * Sorted by start date descending because the workshop somebody is running now
 * is the one they want at the top, and an undated workshop (a draft nobody has
 * scheduled yet) sorts last rather than first: a draft is the thing you are
 * setting up, not the thing you are running.
 */
export function workshopOptions(
  memberships: WorkshopMember[],
  workshops: Workshop[],
): WorkshopOption[] {
  const byId = new Map(workshops.map((w) => [w.id, w]))
  return memberships
    .map((m) => {
      const w = byId.get(m.workshop_id) ?? null
      return {
        workshop_id: m.workshop_id,
        role: m.role,
        name: w?.name ?? null,
        start_date: w?.start_date ?? null,
      }
    })
    .sort(compareOptions)
}

function compareOptions(a: WorkshopOption, b: WorkshopOption): number {
  if (a.start_date !== b.start_date) {
    if (!a.start_date) return 1
    if (!b.start_date) return -1
    return a.start_date < b.start_date ? 1 : -1
  }
  return (a.name ?? a.workshop_id).localeCompare(b.name ?? b.workshop_id)
}

/**
 * Which observations belong to a workshop.
 *
 * `observation.workshop_id` is the answer whenever it is set (tl-04 resolves it
 * at ingest). It is nullable for rows imported before tl-04 whose capture is no
 * longer on the device, so the capture's own workshop is consulted as a fallback
 * rather than dropping the row: an observation counted into no workshop at all
 * would quietly deflate whichever card should have carried it.
 */
export function observationsForWorkshop(
  observations: ObservationRecord[],
  evaluations: EvaluationRecord[],
  workshopId: string,
): ObservationRecord[] {
  const captureWorkshop = new Map(evaluations.map((e) => [e.client_id, e.workshop_id ?? null]))
  return observations.filter((o) =>
    o.workshop_id != null
      ? o.workshop_id === workshopId
      : captureWorkshop.get(o.capture_client_id) === workshopId,
  )
}

/** Everything one card needs, already scoped to its workshop by the caller. */
export interface WorkshopCardInput {
  membership: WorkshopMember
  /** Null when the membership's workshop row has not reached this device. */
  workshop: Workshop | null
  participants: number
  evaluations: EvaluationRecord[]
  observations: ObservationRecord[]
  verdicts: VerificationVerdict[]
  /** THIS workshop's confirmation threshold, not the active workshop's. */
  threshold: number
}

export interface WorkshopCard {
  workshop_id: string
  name: string | null
  role: WorkshopRole
  start_date: string | null
  end_date: string | null
  location: string | null
  state: WorkshopState
  participants: number
  /** Participants holding at least one observation that has cleared the gate. */
  participantsWithEvidence: number
  /**
   * `participantsWithEvidence` as a percentage of the roster, or null when there
   * is no roster yet.
   *
   * Null rather than 0, because 0% of nobody is a number that reads as failure
   * and means "you have not added anybody". The renderer says which it is.
   */
  coveragePercent: number | null
  /** Attested captures in this workshop, however far down the pipeline. */
  submitted: number
  /** tl-18's stages, the three that name work somebody still has to do. */
  unsynced: number
  unrouted: number
  unverified: number
}

/**
 * One card per membership, newest workshop first.
 *
 * The pending numbers are tl-18's funnel stages verbatim rather than a fresh
 * calculation, so the overview and `/admin/sync-health` can never disagree about
 * how much work is outstanding — two independent implementations of "unsynced"
 * is exactly the kind of divergence that makes an administrator stop trusting
 * both pages.
 */
export function buildWorkshopCards(inputs: WorkshopCardInput[], now: string): WorkshopCard[] {
  return inputs
    .map((input) => {
      const funnel = buildSyncFunnel(
        input.evaluations,
        input.observations,
        input.verdicts,
        input.threshold,
      )
      const byObservation = new Map<string, VerificationVerdict[]>()
      for (const v of input.verdicts) {
        const list = byObservation.get(v.observation_id)
        if (list) list.push(v)
        else byObservation.set(v.observation_id, [v])
      }
      const evidenced = new Set<string>()
      for (const o of input.observations) {
        if (!o.participant_id) continue
        const s = observationStatus(o, byObservation.get(o.id) ?? [], input.threshold)
        if (s.status === 'verified' || s.status === 'adjusted') evidenced.add(o.participant_id)
      }

      const state = deriveWorkshopState({
        submittedEvaluations: funnel.rollup.total,
        endDate: input.workshop?.end_date ?? null,
        now,
      })

      return {
        workshop_id: input.membership.workshop_id,
        name: input.workshop?.name ?? null,
        role: input.membership.role,
        start_date: input.workshop?.start_date ?? null,
        end_date: input.workshop?.end_date ?? null,
        location: input.workshop?.location ?? null,
        state,
        participants: input.participants,
        participantsWithEvidence: evidenced.size,
        coveragePercent: input.participants
          ? Math.round((evidenced.size / input.participants) * 100)
          : null,
        submitted: funnel.rollup.total,
        unsynced: funnel.rollup.unsynced,
        unrouted: funnel.rollup.syncedUnrouted,
        unverified: funnel.rollup.routedUnverified,
      }
    })
    .sort((a, b) =>
      compareOptions(
        { workshop_id: a.workshop_id, role: a.role, name: a.name, start_date: a.start_date },
        { workshop_id: b.workshop_id, role: b.role, name: b.name, start_date: b.start_date },
      ),
    )
}

/** Whether a card has anything on it that somebody has to act on. */
export function pendingTotal(card: WorkshopCard): number {
  return card.unsynced + card.unrouted + card.unverified
}
