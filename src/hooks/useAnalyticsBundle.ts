import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useDisplayWorkshopId } from './useWorkshopEvidence'
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
import { resolveDisplayWorkshop, scopeEvidence } from '../reports/scope'
import { type ResolvedKsa } from '../lib/goals'
import type { Activity, Goal, Ksa, Participant, Team, Workshop } from '../lib/types'

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
  /**
   * The workshop's questions, with their goal titles resolved (tl-08).
   *
   * `ResolvedKsa` rather than `Ksa` on purpose: every rollup below prints a group
   * heading, and that heading now comes from the goal. Taking the resolved shape
   * makes it a compile error to hand the analytics layer questions whose group is
   * unknown, which is what the old free-text `area` field allowed.
   */
  ksas: ResolvedKsa[]
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
  // The SAME two functions the document surfaces use (tl-29's review): this hook had its
  // own pair — the unvalidated stored id plus a first-workshop fallback — so with nothing
  // selected on a two-workshop device the day email said "Workshop" over everybody's
  // people while these dashboards said one workshop's name over its own. Two seams, two
  // answers to one state.
  const activeWorkshopId = useDisplayWorkshopId()

  const workshop = useLiveQuery(
    async () => resolveDisplayWorkshop(await db.workshops.toArray(), activeWorkshopId),
    [activeWorkshopId],
  )

  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const goals = useLiveQuery(() => db.goals.toArray(), [], [] as Goal[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [])
  const evaluations = useLiveQuery(() => db.evaluations.toArray(), [], [])
  const resolutions = useLiveQuery(() => db.discrepancyResolutions.toArray(), [], [])
  const conversations = useLiveQuery(() => db.mentoringConversations.toArray(), [], [])

  const loading = workshop === undefined || ksas === undefined || observations === undefined

  const { day = null, teamId = null, evaluator = null, sort = 'roster' } = filters

  return useMemo(() => {
    /**
     * Scoped to the active workshop through the shared rules (tl-29).
     *
     * This function used to filter participants, activities, questions and goals
     * inline and correctly, which is why the thirteen pages behind it were not among
     * tl-26's findings. Two gaps survived that pass and neither was visible in a
     * report: `annotateObservations` ran over EVERY observation on the device, so the
     * evaluator table, the attribution health and the workbench summary counted the
     * other workshop's work, and `teams` came back unfiltered, so every team picker
     * behind this hook offered the other workshop's teams. The reports themselves were
     * accidentally safe, because `buildAllReports` keys off the scoped participant
     * list. Accidentally safe is the state this spec exists to remove.
     */
    const scoped = scopeEvidence({
      workshopId: workshop?.id ?? null,
      participants,
      teams,
      ksas,
      goals,
      activities,
      observations,
      verdicts,
      evaluations,
    })
    const myActivities = scoped.activities
    const myParticipantsAll = scoped.participants
    const myParticipants = teamId
      ? myParticipantsAll.filter((p) => p.team_id === teamId)
      : myParticipantsAll
    const sortedKsas = scoped.ksas
    const myTeams = scoped.teams
    /**
     * Conversations carry their own `workshop_id` (nullable, like observations), and
     * `conversationsNeeded` on the summary counted every workshop's. Resolutions are
     * deliberately NOT scoped: they are consumed as a set of ids matched against
     * discrepancies that are already in scope, and a `disc::<participant>::<code>` id
     * from another workshop cannot match one of these.
     */
    const wsId = scoped.workshopId
    const myConversations = wsId
      ? (conversations ?? []).filter(
          (c) =>
            c.workshop_id === wsId ||
            (c.workshop_id == null && myParticipantsAll.some((p) => p.id === c.participant_id)),
        )
      : (conversations ?? [])

    const annotatedAll = annotateObservations(scoped.observations, scoped.verdicts)
    const situatedAll = situate(annotatedAll, buildCaptureIndex(scoped.evaluations))

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

    const reports = buildAllReports(myParticipants, sortedKsas, situatedFiltered, myTeams)
    const gates = new Map<string, Gate>()
    for (const r of reports) {
      gates.set(
        r.participant_id,
        participantGate(r.ksaRollups.flatMap((k) => [...k.contributing, ...k.toVerify])),
      )
    }

    const discrepancies = findDiscrepancies(reports, buildCaptureTimeMap(scoped.evaluations))
    const activitiesInScope = day ? myActivities.filter((a) => a.day === day) : myActivities

    return {
      loading,
      workshop: workshop ?? null,
      participants: myParticipants,
      teams: myTeams,
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
        scoped.evaluations,
      ),
      byKsa: ksaAnalytics(sortedKsas, myParticipants, reports, situatedFiltered, myActivities),
      byEvaluator: evaluatorAnalytics(
        situatedFiltered,
        scoped.verdicts,
        scoped.evaluations,
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
        conversations: myConversations,
        evaluations: scoped.evaluations,
      }),
      days: [...new Set(myActivities.map((a) => a.day).filter((d): d is string => d != null))].sort(),
    }
  }, [
    loading,
    workshop,
    participants,
    teams,
    ksas,
    goals,
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
