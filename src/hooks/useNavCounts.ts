import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { ADMIN_ROLES, useHasWorkshopRole, useIsChief, useScopedWorkshopId } from '../layout/roles'
import { buildAllReports } from '../reports/build'
import { annotateObservations, getRequiredConfirmations } from '../reports/verification'
import { buildCaptureTimeMap, discrepancyId, findDiscrepancies } from '../reports/discrepancy'
import { withGoalTitles } from '../lib/goals'
import type {
  Goal,
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
  /**
   * Conversations needing this person's attention: assigned to them and not yet
   * logged or dismissed.
   *
   * Scoped to the assignee since tl-05, and that changed what the number means.
   * It used to count every 'needed' row on the device, so an evaluator's badge
   * reported the whole workshop's follow-up backlog — 30-odd on a bad day, none
   * of it theirs, and no way to tell from the badge which. A badge that counts
   * other people's work is not a prompt, it is noise with a number on it.
   */
  conversationsMine: number
  /** Unassigned open conversations. Admin-only; 0 otherwise. */
  conversationsUnassigned: number
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
  conversationsMine: 0,
  conversationsUnassigned: 0,
  openDiscrepancies: 0,
  draftsNeedingAttention: 0,
  underAssigned: 0,
}

/** Assigned-and-unfinished. Shared by the badge and the evaluator's own page. */
const OPEN_STATUSES = ['needed', 'scheduled'] as const

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
  const isAdmin = useHasWorkshopRole(ADMIN_ROLES)
  const workshopId = useScopedWorkshopId()
  const { identity } = useAuth()
  const myEmail = identity?.email?.trim().toLowerCase() ?? null

  const conversationsMine = useLiveQuery(
    () =>
      myEmail
        ? db.mentoringConversations
            .where('assigned_to')
            .equals(myEmail)
            .filter((cv) => (OPEN_STATUSES as readonly string[]).includes(cv.status))
            .count()
        : Promise.resolve(0),
    [myEmail],
    0,
  )

  const conversationsUnassigned = useLiveQuery(
    () =>
      isAdmin && workshopId
        ? db.mentoringConversations
            .where('workshop_id')
            .equals(workshopId)
            .filter(
              (cv) =>
                !cv.assigned_to && (OPEN_STATUSES as readonly string[]).includes(cv.status),
            )
            .count()
        : Promise.resolve(0),
    [isAdmin, workshopId],
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
  // Goals too, because the discrepancy rollup below runs through buildAllReports,
  // which prints a group heading per question (tl-08).
  const goals = useLiveQuery(
    () => (isChief ? db.goals.toArray() : Promise.resolve([] as Goal[])),
    [isChief],
    [] as Goal[],
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
    const sortedKsas = withGoalTitles(
      [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
      goals ?? [],
    )
    const annotated = annotateObservations(observations ?? [], verdicts ?? [])
    const reports = buildAllReports(participants ?? [], sortedKsas, annotated, teams ?? [])
    const captureTimes = buildCaptureTimeMap(evaluations ?? [])
    const resolvedIds = new Set((resolutions ?? []).map((r) => r.id))
    return findDiscrepancies(reports, captureTimes).filter(
      (d) => !resolvedIds.has(discrepancyId(d.participant_id, d.ksa_code)),
    ).length
  }, [isChief, participants, ksas, goals, teams, observations, verdicts, evaluations, resolutions])

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
      isChief || conversationsMine
        ? {
            conversationsMine: conversationsMine ?? 0,
            conversationsUnassigned: conversationsUnassigned ?? 0,
            openDiscrepancies,
            draftsNeedingAttention: draftsNeedingAttention ?? 0,
            underAssigned,
          }
        : EMPTY,
    [
      isChief,
      conversationsMine,
      conversationsUnassigned,
      openDiscrepancies,
      draftsNeedingAttention,
      underAssigned,
    ],
  )
}
