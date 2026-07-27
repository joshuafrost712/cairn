import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import { buildAllReports } from '../reports/build'
import { annotateObservations, participantGate } from '../reports/verification'
import type { AnnotatedObservation, Gate } from '../reports/verification'
import { buildCaptureTimeMap, findDiscrepancies } from '../reports/discrepancy'
import type { Discrepancy } from '../reports/discrepancy'
import {
  allActivityAnalytics,
  attributionHealth,
  buildCaptureIndex,
  buildHeatmap,
  evaluatorAnalytics,
  flagParticipants,
  ksaAnalytics,
  situate,
  workbenchSummary,
} from '../reports/analytics'
import type {
  ActivityAnalytics,
  AttributionHealth,
  EvaluatorAnalytics,
  FlaggedParticipant,
  HeatSort,
  HeatmapMatrix,
  KsaAnalytics,
  SituatedObservation,
  WorkbenchSummary,
} from '../reports/analytics'
import type { ParticipantReport } from '../reports/build'
import type { Activity, Ksa, Participant, Team, Workshop } from '../lib/types'

export interface DashboardFilters {
  /** Activity.day, or null for all days. */
  day?: string | null
  teamId?: string | null
  evaluator?: string | null
  sort?: HeatSort
}

export interface AnalyticsBundle {
  loading: boolean
  workshop: Workshop | null
  participants: Participant[]
  teams: Team[]
  ksas: Ksa[]
  activities: Activity[]
  annotated: AnnotatedObservation[]
  situated: SituatedObservation[]
  reports: ParticipantReport<AnnotatedObservation>[]
  gates: Map<string, Gate>
  discrepancies: Discrepancy[]
  flagged: FlaggedParticipant[]
  byActivity: ActivityAnalytics[]
  byKsa: KsaAnalytics[]
  byEvaluator: EvaluatorAnalytics[]
  heatmap: HeatmapMatrix
  attribution: AttributionHealth
  summary: WorkbenchSummary
  /** Days present in the schedule, ascending, for the filter row. */
  days: string[]
}

/**
 * The single place Dexie meets the pure analytics layer.
 *
 * One live query per table, one memo chain, consumed by every card on a page.
 * This exists because Reports, DayEmail, Inbox and EvaluatorHome each
 * independently ran `annotateObservations -> buildAllReports`, and a dashboard
 * with six cards would otherwise have made that six more times per render.
 *
 * Filters narrow the OBSERVATION set before the rollups, not the rendered rows
 * after them, so a filtered mean is the mean of what the filter describes.
 */
export function useAnalyticsBundle(filters: DashboardFilters = {}): AnalyticsBundle {
  const activeWorkshopId = useActiveWorkshopId()

  const workshop = useLiveQuery(async () => {
    if (activeWorkshopId) {
      const w = await db.workshops.get(activeWorkshopId)
      if (w) return w
    }
    return db.workshops.toCollection().first()
  }, [activeWorkshopId])

  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [])
  const evaluations = useLiveQuery(() => db.evaluations.toArray(), [], [])
  const resolutions = useLiveQuery(() => db.discrepancyResolutions.toArray(), [], [])
  const conversations = useLiveQuery(() => db.mentoringConversations.toArray(), [], [])

  const loading = workshop === undefined || ksas === undefined || observations === undefined

  const { day = null, teamId = null, evaluator = null, sort = 'roster' } = filters

  return useMemo(() => {
    const wsId = workshop?.id ?? null
    const myActivities = (activities ?? [])
      .filter((a) => !wsId || a.workshop_id === wsId)
      .sort((a, b) => a.sort_order - b.sort_order)
    const myParticipantsAll = (participants ?? []).filter((p) => !wsId || p.workshop_id === wsId)
    const myParticipants = teamId
      ? myParticipantsAll.filter((p) => p.team_id === teamId)
      : myParticipantsAll
    // Stable KSA order everywhere: code-sorted, matching what the rest of the app does.
    const sortedKsas = [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code))

    const annotatedAll = annotateObservations(observations ?? [], verdicts ?? [])
    const situatedAll = situate(annotatedAll, buildCaptureIndex(evaluations ?? []))

    const dayOf = new Map(myActivities.map((a) => [a.id, a.day]))
    const participantIds = new Set(myParticipants.map((p) => p.id))

    const situatedFiltered = situatedAll.filter((o) => {
      if (day && (!o.activity_id || dayOf.get(o.activity_id) !== day)) return false
      if (evaluator && o.evaluator !== evaluator) return false
      // A team filter narrows to that team's people; unattributed observations
      // have no team, so they drop out of a team view by construction.
      if (teamId && (o.participant_id === null || !participantIds.has(o.participant_id))) return false
      return true
    })

    const reports = buildAllReports(myParticipants, sortedKsas, situatedFiltered, teams ?? [])
    const gates = new Map<string, Gate>()
    for (const r of reports) {
      gates.set(
        r.participant_id,
        participantGate(r.ksaRollups.flatMap((k) => [...k.contributing, ...k.toVerify])),
      )
    }

    const discrepancies = findDiscrepancies(reports, buildCaptureTimeMap(evaluations ?? []))
    const activitiesInScope = day ? myActivities.filter((a) => a.day === day) : myActivities

    return {
      loading,
      workshop: workshop ?? null,
      participants: myParticipants,
      teams: teams ?? [],
      ksas: sortedKsas,
      activities: myActivities,
      annotated: annotatedAll,
      situated: situatedFiltered,
      reports,
      gates,
      discrepancies,
      flagged: flagParticipants(reports, gates),
      byActivity: allActivityAnalytics(
        activitiesInScope,
        sortedKsas,
        situatedFiltered,
        evaluations ?? [],
      ),
      byKsa: ksaAnalytics(sortedKsas, myParticipants, reports, situatedFiltered, myActivities),
      byEvaluator: evaluatorAnalytics(
        situatedFiltered,
        verdicts ?? [],
        evaluations ?? [],
        myActivities,
      ),
      heatmap: buildHeatmap(reports, sortedKsas, { sort }),
      attribution: attributionHealth(situatedFiltered),
      summary: workbenchSummary({
        reports,
        gates,
        situated: situatedFiltered,
        discrepancies,
        resolutions: resolutions ?? [],
        conversations: conversations ?? [],
        evaluations: evaluations ?? [],
      }),
      days: [...new Set(myActivities.map((a) => a.day).filter((d): d is string => d != null))].sort(),
    }
  }, [
    loading,
    workshop,
    participants,
    teams,
    ksas,
    activities,
    observations,
    verdicts,
    evaluations,
    resolutions,
    conversations,
    day,
    teamId,
    evaluator,
    sort,
  ])
}
