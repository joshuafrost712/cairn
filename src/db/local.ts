import Dexie, { type EntityTable } from 'dexie'
import type {
  Activity,
  ActivityKsa,
  CoverageRow,
  DiscrepancyResolution,
  EvaluationRecord,
  Goal,
  Ksa,
  MentoringConversation,
  ObservationRecord,
  Participant,
  ReferenceOutboxEntry,
  ReportAssignment,
  SetupChangeLogEntry,
  Team,
  VerdictTombstone,
  VerificationVerdict,
  Workshop,
  WorkshopMember,
  WorkshopPerson,
  WorkshopSettingRow,
} from '../lib/types'
import type { DraftDoc } from '../drafts/types'
import { planBackfill } from './backfill'
import { planGoalBackfill } from './goalBackfill'
import { defaultScalePoints, type ScalePoint } from '../lib/scale'
import { getActiveWorkshopId } from '../lib/activeWorkshop'

/**
 * On-device store (IndexedDB via Dexie). Two roles:
 *  1. Durable capture store + outbox: `evaluations`. Every change is written here
 *     immediately, independent of network. Rows whose sync_status != 'synced' ARE
 *     the outbox (see getOutbox).
 *  2. Reference cache: workshops/teams/participants/activities/ksas/activity_ksa so
 *     the capture flow works offline after the first load.
 */
class CairnDB extends Dexie {
  evaluations!: EntityTable<EvaluationRecord, 'client_id'>
  workshops!: EntityTable<Workshop, 'id'>
  teams!: EntityTable<Team, 'id'>
  participants!: EntityTable<Participant, 'id'>
  activities!: EntityTable<Activity, 'id'>
  goals!: EntityTable<Goal, 'id'>
  ksas!: EntityTable<Ksa, 'id'>
  activityKsas!: EntityTable<ActivityKsa & { pk: string }, 'pk'>
  observations!: EntityTable<ObservationRecord, 'id'>
  verifications!: EntityTable<VerificationVerdict, 'id'>
  verdictTombstones!: EntityTable<VerdictTombstone, 'id'>
  mentoringConversations!: EntityTable<MentoringConversation, 'id'>
  discrepancyResolutions!: EntityTable<DiscrepancyResolution, 'id'>
  coverage!: EntityTable<CoverageRow, 'client_id'>
  referenceOutbox!: EntityTable<ReferenceOutboxEntry, 'id'>
  docDrafts!: EntityTable<DraftDoc, 'id'>
  workshopMembers!: EntityTable<WorkshopMember, 'pk'>
  workshopPeople!: EntityTable<WorkshopPerson, 'pk'>
  workshopSettings!: EntityTable<WorkshopSettingRow, 'pk'>
  assignments!: EntityTable<ReportAssignment, 'pk'>
  setupChangeLog!: EntityTable<SetupChangeLogEntry, 'id'>
  scalePoints!: EntityTable<ScalePoint, 'pk'>

  constructor() {
    super('cairn')
    this.version(1).stores({
      evaluations: 'client_id, sync_status, activity_id, workshop_id, updated_at',
      workshops: 'id',
      teams: 'id, workshop_id',
      participants: 'id, workshop_id, team_id',
      activities: 'id, workshop_id, sort_order',
      ksas: 'id, code',
      // composite key flattened into pk so we can upsert cleanly
      activityKsas: 'pk, activity_id, ksa_id',
    })
    // v2: routing_status index on evaluations + the imported observations table.
    this.version(2).stores({
      evaluations: 'client_id, sync_status, routing_status, activity_id, workshop_id, updated_at',
      observations: 'id, capture_client_id, participant_id, ksa_code',
    })
    // v3: evaluator verdicts for the multi-evaluator verification gate.
    this.version(3).stores({
      verifications: 'id, observation_id, capture_client_id, evaluator_email',
    })
    // v4: mentoring conversations derived from confirmed low observations.
    this.version(4).stores({
      mentoringConversations: 'id, participant_id, workshop_id, status, trigger_observation_id, sync_status',
    })
    // v5: local-only acknowledgement that a chief evaluator has reconciled a discrepancy.
    this.version(5).stores({
      discrepancyResolutions: 'id',
    })
    // v6: live evaluation-coverage cache (who has been evaluated per activity),
    // fed by this device's submissions and other devices via Supabase Realtime.
    this.version(6).stores({
      coverage: 'client_id, activity_id, workshop_id, evaluator_email',
    })
    // v7: reference-authoring outbox — pending backend upserts/deletes for
    // workshops/activities/KSAs/wiring produced by the Scenario Builder.
    this.version(7).stores({
      referenceOutbox: 'id, table, op',
    })
    // v8: outgoing document drafts (participant emails, event digests) with the
    // human's edits and approval record. Purely additive, so no migration
    // function: Dexie creates the store and leaves every existing table alone.
    this.version(8).stores({
      docDrafts: 'id, kind, subjectKey, status, dateLabel, updatedAt',
    })
    // v9: cached per-workshop memberships, so role resolution survives a cold
    // offline start. A convenience for the UI only — never an authorization
    // source; RLS re-derives the same fact from auth.uid() on every request.
    this.version(9).stores({
      workshopMembers: 'pk, workshop_id, app_user_id, role',
    })
    // v10: the assignment layer. `workshopPeople` is everyone ELSE in a workshop
    // you belong to (workshopMembers above is only ever yourself); `assignments`
    // is who owes what; `workshopSettings` moves the verification threshold and
    // the review quotas off the device and onto the workshop. Purely additive.
    this.version(10).stores({
      workshopPeople: 'pk, workshop_id, app_user_id, email, role',
      workshopSettings: 'pk, workshop_id, key',
      assignments: 'pk, workshop_id, participant_id, evaluator_email, kind',
    })
    // v11 (tl-04): observations and verdicts get a backend, so both need the
    // outbox fields every other synced table has, and observations need the
    // workshop_id the backend's read policy is written against.
    //
    // The upgrade is the desktop half of the phone-evaluations recovery. Marking
    // every existing row 'local' is what makes the first sync cycle push the
    // entire pilot history up, so "one private database" becomes true
    // retroactively rather than only for work captured after today.
    this.version(11)
      .stores({
        observations: 'id, capture_client_id, participant_id, ksa_code, workshop_id, sync_status',
        verifications: 'id, observation_id, capture_client_id, evaluator_email, workshop_id, sync_status',
        verdictTombstones: 'id, sync_status',
      })
      .upgrade(async (tx) => {
        // The plan is computed by planBackfill (src/db/backfill.ts), which is pure
        // and unit-tested. This block is only the plumbing that applies it.
        const evaluations = await tx.table('evaluations').toArray()
        const participants = await tx.table('participants').toArray()
        const observations = await tx.table('observations').toArray()
        const verdicts = await tx.table('verifications').toArray()

        const plan = planBackfill({
          observations,
          verdicts,
          captureWorkshops: new Map(evaluations.map((e) => [e.client_id, e.workshop_id ?? null])),
          participantWorkshops: new Map(participants.map((p) => [p.id, p.workshop_id ?? null])),
          activeWorkshopId: getActiveWorkshopId(),
        })
        if (plan.unresolved > 0) {
          console.warn(
            `[cairn] tl-04 backfill: ${plan.unresolved} observation(s) could not be placed in a workshop and cannot be shared until re-imported`,
          )
        }

        await tx
          .table('observations')
          .toCollection()
          .modify((o: Record<string, unknown>) => {
            o.workshop_id = plan.observationWorkshops.get(o.id as string) ?? null
            o.sync_status = 'local'
            o.sync_error = null
          })

        await tx
          .table('verifications')
          .toCollection()
          .modify((v: Record<string, unknown>) => {
            v.workshop_id = plan.verdictWorkshops.get(v.id as string) ?? null
            v.sync_status = 'local'
            v.sync_error = null
          })
      })
    // v12 (tl-07): the setup audit log's outbox. A setup edit made offline must
    // still be logged, so the row is written here first and pushed to
    // log_setup_change() when the network returns — the same offline-first contract
    // every other write in this app has.
    //
    // VERSION CLAIM: tl-07 owns Dexie v12 for this wave. tl-05 is the other spec
    // that needs a bump and takes v13; the two were assigned in the program file
    // rather than at implementation time, because two branches defining v12 with
    // different contents means the second to merge is silently wrong on every
    // device that already upgraded. Purely additive, so no upgrade function.
    this.version(12).stores({
      setupChangeLog: 'id, workshop_id, sync_status, at',
    })
    // v14 (tl-08): the goals layer, and questions that belong to a workshop.
    //
    // VERSION CLAIM: **v13 is tl-05's** and is deliberately skipped here. The
    // program file assigned both numbers before either was implemented, and
    // honoring the reservation across a gap is cheaper than the alternative: two
    // branches defining v13 with different stores means the second to merge is
    // silently wrong on every device that already upgraded, with no error to
    // notice. Dexie is content with a gap; it is not content with a collision.
    //
    // `ksas` gains two indexes because questions are now scoped: the question
    // list is `where('workshop_id')` rather than the whole table, and the goal
    // grouping reads `where('goal_id')`. `activityKsas` needs no store change —
    // its two override columns are data, not indexes.
    this.version(14)
      .stores({
        goals: 'id, workshop_id, sort_order',
        ksas: 'id, code, workshop_id, goal_id',
      })
      .upgrade(async (tx) => {
        // The plan is computed by planGoalBackfill (src/db/goalBackfill.ts), which
        // is pure and unit-tested. This block is only the plumbing that applies
        // it. See that file for why the device backfills at all when the migration
        // has already done it server-side.
        const [ksas, links, activities, workshops] = await Promise.all([
          tx.table('ksas').toArray(),
          tx.table('activityKsas').toArray(),
          tx.table('activities').toArray(),
          tx.table('workshops').toArray(),
        ])

        const plan = planGoalBackfill({
          ksas,
          links,
          activities,
          workshops,
          activeWorkshopId: getActiveWorkshopId(),
        })

        if (plan.goals.length > 0) await tx.table('goals').bulkPut(plan.goals)
        await tx
          .table('ksas')
          .toCollection()
          .modify((k: Record<string, unknown>) => {
            const assignment = plan.assignments.get(k.id as string)
            if (!assignment) return
            k.workshop_id = assignment.workshop_id
            k.goal_id = assignment.goal_id
          })

        if (plan.unplaced.length > 0) {
          console.warn(
            `[honest-eval] tl-08 backfill: ${plan.unplaced.length} question(s) could not be placed in a workshop and will not appear until this device syncs`,
          )
        }
        if (plan.crossWorkshop.length > 0) {
          console.warn(
            `[honest-eval] tl-08 backfill: ${plan.crossWorkshop.length} question(s) were wired across more than one workshop and were assigned to their primary one; the backend clones these, so the copies arrive on the next sync`,
          )
        }
      })
    // v15 (tl-09): the workshop's own grading scale.
    //
    // VERSION CLAIM: the program file assigned v15 to tl-09 before either this
    // spec or tl-10 was implemented. v16 is tl-10's and is not taken here.
    //
    // The upgrade seeds today's 0-3 scale for every cached workshop, which is the
    // device half of the migration's own seed. It is not strictly required —
    // `buildScale()` falls back to the same four points when a workshop has no
    // rows — and it is worth doing anyway, because without it the Scale section
    // on a device that has not yet pulled would show an administrator an empty
    // editor for a workshop that is demonstrably scoring people 0-3.
    this.version(15)
      .stores({
        scalePoints: 'pk, workshop_id',
      })
      .upgrade(async (tx) => {
        const workshops = await tx.table('workshops').toArray()
        const rows = workshops.flatMap((w: { id: string }) => defaultScalePoints(w.id))
        if (rows.length > 0) await tx.table('scalePoints').bulkPut(rows)
      })
  }
}

export const db = new CairnDB()

/** A client-generated id (UUID where available). Shared by the roster + builder writers. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** Rows still needing to reach the backend — the outbox. */
export function getOutbox() {
  return db.evaluations.where('sync_status').anyOf('local', 'queued', 'error').toArray()
}

export const activityKsaPk = (activity_id: string, ksa_id: string) => `${activity_id}::${ksa_id}`

/**
 * Composite keys, flattened for Dexie and for the reference outbox's `rowKey`.
 *
 * The `::` separator is safe for all of these because neither a uuid, a setting
 * key, an assignment kind, nor an email can contain it. referenceWrite.ts splits
 * `rowKey` back apart on the same separator to build a Postgres `.match()`, so
 * the field ORDER here must stay identical to `TABLE_SPEC[...].keyFields` there.
 */
export const workshopSettingPk = (workshop_id: string, key: string) => `${workshop_id}::${key}`

export const assignmentPk = (
  workshop_id: string,
  participant_id: string,
  evaluator_email: string,
  kind: string,
) => `${workshop_id}::${participant_id}::${evaluator_email.trim().toLowerCase()}::${kind}`
