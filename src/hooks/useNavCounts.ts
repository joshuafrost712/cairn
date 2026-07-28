import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useIsChief, useScopedWorkshopId } from '../layout/roles'
import { buildAllReports } from '../reports/build'
import { annotateObservations, getRequiredConfirmations } from '../reports/verification'
import { buildCaptureTimeMap, discrepancyId, findDiscrepancies } from '../reports/discrepancy'
import type {
  DiscrepancyResolution,
  EvaluationRecord,
  Ksa,
  ObservationRecord,
  Participant,
  ReportAssignment,
  Team,
  VerificationVerdict,
} from '../lib/types'

export interface NavCounts {
  /** Mentoring conversations with status 'needed'. */
  conversationsNeeded: number
  /** Conflicting rollups with no recorded resolution. Chief-only; 0 otherwise. */
  openDiscrepancies: number
  /**
   * Outgoing drafts still in draft state, plus any whose edits went stale.
   * Counted with a Dexie count() rather than through the report pipeline: the
   * drafts already hold their own flags, so there is nothing to recompute.
   */
  draftsNeedingAttention: number
  /**
   * Participants with fewer review assignees than the verification threshold
   * requires. Chief-only; 0 otherwise.
   *
   * Counted from the rows directly rather than through `buildBoard`, because the
   * board also resolves names, quotas and per-evaluator progress, none of which
   * a badge needs. The threshold read is the synchronous one, which the settings
   * mirror keeps pointed at the active workshop.
   */
  underAssigned: number
}

const EMPTY: NavCounts = {
  conversationsNeeded: 0,
  openDiscrepancies: 0,
  draftsNeedingAttention: 0,
  underAssigned: 0,
}

/**
 * Badge counts for the sidebar.
 *
 * This exists so the whole report pipeline runs ONCE per render for the nav,
 * rather than once per badge. EvaluatorHome used to run
 * `annotateObservations -> buildAllReports -> findDiscrepancies` inline purely to
 * print one number, and every page that grew a badge would have repeated it.
 *
 * Slice 2 folds this into useAnalyticsBundle, which computes the same pipeline
 * once for a whole dashboard page; this hook then becomes a thin read off that.
 * Until then it is the single owner of the badge numbers.
 *
 * The chief-only queries stay gated on `isChief` so a plain evaluator's device
 * never pulls every observation and verdict just to render a nav.
 */
export function useNavCounts(): NavCounts {
  const isChief = useIsChief()
  const workshopId = useScopedWorkshopId()

  const conversationsNeeded = useLiveQuery(
    () => db.mentoringConversations.where('status').equals('needed').count(),
    [],
    0,
  )

  const draftsNeedingAttention = useLiveQuery(
    () => (isChief ? db.docDrafts.where('status').equals('draft').count() : Promise.resolve(0)),
    [isChief],
    0,
  )

  const participants = useLiveQuery(
    () => (isChief ? db.participants.toArray() : Promise.resolve([] as Participant[])),
    [isChief],
    [] as Participant[],
  )
  // Scoped to the active workshop, unlike the counts above it. loadReferenceData
  // caches every workshop this account can read, so an unscoped count would add
  // up three scenarios' rosters and compare them against the ACTIVE workshop's
  // threshold, producing a badge that disagrees with the page it links to.
  const reviewAssignments = useLiveQuery(
    () =>
      isChief && workshopId
        ? db.assignments
            .where('workshop_id')
            .equals(workshopId)
            .filter((a) => a.kind === 'review')
            .toArray()
        : Promise.resolve([] as ReportAssignment[]),
    [isChief, workshopId],
    [] as ReportAssignment[],
  )
  const ksas = useLiveQuery(
    () => (isChief ? db.ksas.toArray() : Promise.resolve([] as Ksa[])),
    [isChief],
    [] as Ksa[],
  )
  const teams = useLiveQuery(
    () => (isChief ? db.teams.toArray() : Promise.resolve([] as Team[])),
    [isChief],
    [] as Team[],
  )
  const observations = useLiveQuery(
    () => (isChief ? db.observations.toArray() : Promise.resolve([] as ObservationRecord[])),
    [isChief],
    [] as ObservationRecord[],
  )
  const verdicts = useLiveQuery(
    () => (isChief ? db.verifications.toArray() : Promise.resolve([] as VerificationVerdict[])),
    [isChief],
    [] as VerificationVerdict[],
  )
  const evaluations = useLiveQuery(
    () => (isChief ? db.evaluations.toArray() : Promise.resolve([] as EvaluationRecord[])),
    [isChief],
    [] as EvaluationRecord[],
  )
  const resolutions = useLiveQuery(
    () =>
      isChief
        ? db.discrepancyResolutions.toArray()
        : Promise.resolve([] as DiscrepancyResolution[]),
    [isChief],
    [] as DiscrepancyResolution[],
  )

  const openDiscrepancies = useMemo(() => {
    if (!isChief) return 0
    const sortedKsas = [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code))
    const annotated = annotateObservations(observations ?? [], verdicts ?? [])
    const reports = buildAllReports(participants ?? [], sortedKsas, annotated, teams ?? [])
    const captureTimes = buildCaptureTimeMap(evaluations ?? [])
    const resolvedIds = new Set((resolutions ?? []).map((r) => r.id))
    return findDiscrepancies(reports, captureTimes).filter(
      (d) => !resolvedIds.has(discrepancyId(d.participant_id, d.ksa_code)),
    ).length
  }, [isChief, participants, ksas, teams, observations, verdicts, evaluations, resolutions])

  const underAssigned = useMemo(() => {
    if (!isChief || !workshopId) return 0
    const required = getRequiredConfirmations()
    const counts = new Map<string, number>()
    for (const a of reviewAssignments ?? []) {
      counts.set(a.participant_id, (counts.get(a.participant_id) ?? 0) + 1)
    }
    return (participants ?? [])
      .filter((p) => p.workshop_id === workshopId)
      .filter((p) => (counts.get(p.id) ?? 0) < required).length
  }, [isChief, workshopId, participants, reviewAssignments])

  return useMemo(
    () =>
      isChief || conversationsNeeded
        ? {
            conversationsNeeded: conversationsNeeded ?? 0,
            openDiscrepancies,
            draftsNeedingAttention: draftsNeedingAttention ?? 0,
            underAssigned,
          }
        : EMPTY,
    [isChief, conversationsNeeded, openDiscrepancies, draftsNeedingAttention, underAssigned],
  )
}
