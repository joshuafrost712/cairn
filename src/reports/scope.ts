// Which rows a surface may read when the device holds more than one workshop.
//
// tl-29. Every rule here was previously a habit: `useAnalyticsBundle` filtered
// participants and questions inline, `Reports.tsx` filtered participants and teams
// and not observations, `db/drafts.ts` resolved observations properly for its own
// good reasons, and `DayEmail.tsx`, `Export.tsx` and `Inbox.tsx` filtered nothing at
// all and took `db.workshops.toCollection().first()` as the workshop, which is Dexie
// primary-key order. On the first device to hold two real workshops, the end-of-day
// email came out headed with one workshop's name over the other one's people.
//
// Pure, so the rules are testable without a database and without a DOM. The Dexie
// half is `hooks/useWorkshopEvidence.ts`, which is deliberately thin.

import { observationsForWorkshop, unresolvedObservations } from './workshopOverview'
import { withGoalTitles, type ResolvedKsa } from '../lib/goals'
import type {
  Activity,
  EvaluationRecord,
  Goal,
  Ksa,
  ObservationRecord,
  Participant,
  Team,
  VerificationVerdict,
} from '../lib/types'

/** Everything a surface holds before it has decided what scope it is in. */
export interface EvidenceInput {
  /**
   * The workshop to narrow to, or null.
   *
   * **Null means unscoped, on purpose.** A device that has not signed in yet shows
   * the bundled seed data with no membership to resolve, and a local-only build has
   * no `workshop_member` row at all; narrowing to nothing there would empty every
   * screen for the people most likely to be evaluating with no backend. It is the
   * convention `Reports.tsx` and `useAnalyticsBundle` already use.
   */
  workshopId: string | null
  participants?: Participant[]
  teams?: Team[]
  ksas?: Ksa[]
  goals?: Goal[]
  activities?: Activity[]
  observations?: ObservationRecord[]
  verdicts?: VerificationVerdict[]
  evaluations?: EvaluationRecord[]
}

export interface ScopedEvidence {
  workshopId: string | null
  participants: Participant[]
  teams: Team[]
  /** Code-sorted and joined to their goal titles, which is what every report takes. */
  ksas: ResolvedKsa[]
  goals: Goal[]
  /** In `sort_order`, the order the schedule is authored in. */
  activities: Activity[]
  observations: ObservationRecord[]
  verdicts: VerificationVerdict[]
  evaluations: EvaluationRecord[]
  /**
   * Observations this device cannot attribute to any workshop: no `workshop_id`, no
   * capture, no known participant. Scoping hides them, so the count is handed back
   * for a surface to disclose rather than lost.
   */
  unresolved: ObservationRecord[]
}

/**
 * Which workshop row a surface should present, given what the device holds.
 *
 * With a selection, that workshop. With none, the ONLY workshop on the device, and
 * otherwise nothing. The middle case is a real device (local-only, or mid-sign-in, where
 * there is one workshop and it is unambiguous); the last case is the pairing this whole
 * module exists to prevent, one workshop's NAME over every workshop's people, so a
 * generic heading is the honest answer. Pure and shared because three sites answered
 * this question three ways until tl-29's review counted them.
 */
export function resolveDisplayWorkshop<T extends { id: string }>(
  workshops: T[],
  workshopId: string | null,
): T | null {
  if (workshopId) return workshops.find((w) => w.id === workshopId) ?? null
  return workshops.length === 1 ? workshops[0] : null
}

const ofWorkshop = <T extends { workshop_id?: string | null }>(
  rows: T[],
  workshopId: string | null,
): T[] => (workshopId ? rows.filter((r) => r.workshop_id === workshopId) : rows)

/**
 * Narrow one device's cache to one workshop.
 *
 * Two rules are worth reading rather than inferring.
 *
 * **Observations go through `observationsForWorkshop`**, not through a
 * `workshop_id` comparison, because that column is nullable for the phone captures
 * tl-04 and tl-18 recovered and a plain filter would silently drop real evidence.
 * That resolver is the one place that decision is made.
 *
 * **Verdicts are derived from the scoped observations rather than filtered
 * independently.** A verdict carries its own denormalized `workshop_id` (tl-04),
 * so a second filter was available and is the wrong choice: two rules that answer
 * the same question can disagree, and the one that matters is which observations
 * are in scope. `annotateObservations` already matches on `observation_id`, so a
 * verdict whose observation is out of scope contributes to nothing; this only makes
 * the counts on screen agree with that.
 *
 * **Captures are the union of this workshop's own and the ones the scoped
 * observations came from**, which the first draft of this file got wrong by filtering
 * them on their nullable `workshop_id` alone. `evaluation.workshop_id` is null on
 * captures older than tl-04, and the tl-04 Dexie upgrade backfills the OBSERVATION
 * from the capture or the participant while leaving the capture itself null. So a
 * plain filter kept a stranded observation and dropped the very capture that situates
 * it, which silently costs the evaluator's quick read on the verification queue, the
 * time-gap note on a discrepancy email, and the day and activity of that observation
 * in every dashboard. `db/drafts.ts` had already written the rule down: an
 * observation is situated by its own capture, whichever workshop that capture is in.
 */
export function scopeEvidence(input: EvidenceInput): ScopedEvidence {
  const { workshopId } = input
  const participants = ofWorkshop(input.participants ?? [], workshopId)
  const evaluationsAll = input.evaluations ?? []
  const observations = workshopId
    ? observationsForWorkshop(input.observations ?? [], evaluationsAll, workshopId, participants)
    : (input.observations ?? [])

  const scopedIds = new Set(observations.map((o) => o.id))
  const verdicts = workshopId
    ? (input.verdicts ?? []).filter((v) => scopedIds.has(v.observation_id))
    : (input.verdicts ?? [])

  const capturesBehindScope = new Set(observations.map((o) => o.capture_client_id))
  const evaluations = workshopId
    ? evaluationsAll.filter(
        (e) => e.workshop_id === workshopId || capturesBehindScope.has(e.client_id),
      )
    : evaluationsAll

  const ksas = ofWorkshop(input.ksas ?? [], workshopId)
  const goals = ofWorkshop(input.goals ?? [], workshopId)

  return {
    workshopId,
    participants,
    teams: ofWorkshop(input.teams ?? [], workshopId),
    ksas: withGoalTitles([...ksas].sort((a, b) => a.code.localeCompare(b.code)), goals),
    goals,
    activities: ofWorkshop(input.activities ?? [], workshopId).sort(
      (a, b) => a.sort_order - b.sort_order,
    ),
    observations,
    verdicts,
    evaluations,
    // Nothing is hidden when nothing is scoped, so there is nothing to disclose. The
    // banner that reads this says these rows "appear in no report", which would be
    // false on an unscoped device where they appear in all of them.
    unresolved: workshopId
      ? unresolvedObservations(input.observations ?? [], evaluationsAll, input.participants ?? [])
      : [],
  }
}
