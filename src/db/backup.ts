import { db } from './local'
import type {
  Activity,
  ActivityKsa,
  EvaluationRecord,
  Ksa,
  ObservationRecord,
  Participant,
  Team,
  VerificationVerdict,
  Workshop,
} from '../lib/types'

// Full on-device backup/restore — for moving a device's data or guarding against
// loss before a backend exists. Restore is an upsert (bulkPut by key): it merges
// into the current store rather than wiping it, so importing a backup is safe.

export const BACKUP_SCHEMA_ID = 'cairn.backup/v1'

interface BackupData {
  workshops: Workshop[]
  teams: Team[]
  participants: Participant[]
  activities: Activity[]
  ksas: Ksa[]
  activityKsas: (ActivityKsa & { pk: string })[]
  evaluations: EvaluationRecord[]
  observations: ObservationRecord[]
  verifications: VerificationVerdict[]
}

export interface Backup {
  schema: typeof BACKUP_SCHEMA_ID
  exported_at: string
  data: BackupData
}

export async function exportAll(): Promise<Backup> {
  const [workshops, teams, participants, activities, ksas, activityKsas, evaluations, observations, verifications] =
    await Promise.all([
      db.workshops.toArray(),
      db.teams.toArray(),
      db.participants.toArray(),
      db.activities.toArray(),
      db.ksas.toArray(),
      db.activityKsas.toArray(),
      db.evaluations.toArray(),
      db.observations.toArray(),
      db.verifications.toArray(),
    ])
  return {
    schema: BACKUP_SCHEMA_ID,
    exported_at: new Date().toISOString(),
    data: { workshops, teams, participants, activities, ksas, activityKsas, evaluations, observations, verifications },
  }
}

export async function importAll(text: string): Promise<{ tables: number; rows: number }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON.')
  }
  const obj = parsed as Partial<Backup>
  if (obj?.schema !== BACKUP_SCHEMA_ID || !obj.data) throw new Error('Not a Cairn backup file.')
  const d = obj.data
  let tables = 0
  let rows = 0
  await db.transaction(
    'rw',
    [db.workshops, db.teams, db.participants, db.activities, db.ksas, db.activityKsas, db.evaluations, db.observations, db.verifications],
    async () => {
      const put = async <T>(table: { bulkPut: (rows: T[]) => Promise<unknown> }, list: T[] | undefined) => {
        if (!Array.isArray(list) || list.length === 0) return
        await table.bulkPut(list)
        tables++
        rows += list.length
      }
      await put(db.workshops, d.workshops)
      await put(db.teams, d.teams)
      await put(db.participants, d.participants)
      await put(db.activities, d.activities)
      await put(db.ksas, d.ksas)
      await put(db.activityKsas, d.activityKsas)
      await put(db.evaluations, d.evaluations)
      await put(db.observations, d.observations)
      await put(db.verifications, d.verifications)
    },
  )
  return { tables, rows }
}
