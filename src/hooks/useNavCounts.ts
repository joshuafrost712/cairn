import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useIsChief } from '../layout/roles'
import { buildAllReports } from '../reports/build'
import { annotateObservations } from '../reports/verification'
import { buildCaptureTimeMap, discrepancyId, findDiscrepancies } from '../reports/discrepancy'
import type {
  DiscrepancyResolution,
  EvaluationRecord,
  Ksa,
  ObservationRecord,
  Participant,
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
}

const EMPTY: NavCounts = { conversationsNeeded: 0, openDiscrepancies: 0, draftsNeedingAttention: 0 }

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

  return useMemo(
    () =>
      isChief || conversationsNeeded
        ? {
            conversationsNeeded: conversationsNeeded ?? 0,
            openDiscrepancies,
            draftsNeedingAttention: draftsNeedingAttention ?? 0,
          }
        : EMPTY,
    [isChief, conversationsNeeded, openDiscrepancies, draftsNeedingAttention],
  )
}
