import Dexie, { type EntityTable } from 'dexie'
import type {
  Activity,
  ActivityKsa,
  EvaluationRecord,
  Ksa,
  ObservationRecord,
  Participant,
  Team,
  Workshop,
} from '../lib/types'

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
  }
}

export const db = new CairnDB()

/** Rows still needing to reach the backend — the outbox. */
export function getOutbox() {
  return db.evaluations.where('sync_status').anyOf('local', 'queued', 'error').toArray()
}

export const activityKsaPk = (activity_id: string, ksa_id: string) => `${activity_id}::${ksa_id}`
