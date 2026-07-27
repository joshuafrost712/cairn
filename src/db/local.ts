import Dexie, { type EntityTable } from 'dexie'
import type {
  Activity,
  ActivityKsa,
  CoverageRow,
  DiscrepancyResolution,
  EvaluationRecord,
  Ksa,
  MentoringConversation,
  ObservationRecord,
  Participant,
  ReferenceOutboxEntry,
  Team,
  VerificationVerdict,
  Workshop,
} from '../lib/types'
import type { DraftDoc } from '../drafts/types'

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
  ksas!: EntityTable<Ksa, 'id'>
  activityKsas!: EntityTable<ActivityKsa & { pk: string }, 'pk'>
  observations!: EntityTable<ObservationRecord, 'id'>
  verifications!: EntityTable<VerificationVerdict, 'id'>
  mentoringConversations!: EntityTable<MentoringConversation, 'id'>
  discrepancyResolutions!: EntityTable<DiscrepancyResolution, 'id'>
  coverage!: EntityTable<CoverageRow, 'client_id'>
  referenceOutbox!: EntityTable<ReferenceOutboxEntry, 'id'>
  docDrafts!: EntityTable<DraftDoc, 'id'>

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
