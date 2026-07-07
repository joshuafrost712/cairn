import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { CoverageRow, EvaluationRecord } from '../lib/types'

/**
 * Live evaluation-coverage: "who has already been evaluated for this activity."
 *
 * A participant is "covered" for an activity once they appear in the
 * participant_scope (or are the focus_participant_id) of any SUBMITTED
 * (attestation = true) evaluation for that activity. Coverage rows are a
 * denormalized cache keyed by the evaluation client_id, fed from:
 *   - this device's own submissions (instant self-feedback), and
 *   - other devices via Supabase Realtime (postgres_changes on `evaluation`).
 *
 * The realtime handler writes to Dexie; the participant selector live-queries
 * coverageForActivity, so the UI repaints automatically. Everything degrades
 * gracefully to local-only when Supabase is not configured (the cue then
 * reflects only this device's submissions).
 */

/** The minimal evaluation shape we need — local record or a remote Postgres row. */
type EvalLike = Pick<
  EvaluationRecord,
  'client_id' | 'activity_id' | 'workshop_id' | 'evaluator_email' | 'participant_scope' | 'focus_participant_id'
> & { attestation?: boolean | null; created_at?: string; updated_at?: string }

/**
 * Map an evaluation (local or remote) to a CoverageRow. Returns null for
 * un-attested drafts — only submitted evaluations count toward coverage.
 */
export function coverageRowFromEvaluation(e: EvalLike | null | undefined): CoverageRow | null {
  if (!e || e.attestation !== true) return null
  const ids = new Set<string>()
  for (const s of e.participant_scope ?? []) {
    if (s.participant_id) ids.add(s.participant_id)
  }
  if (e.focus_participant_id) ids.add(e.focus_participant_id)
  return {
    client_id: e.client_id,
    activity_id: e.activity_id ?? null,
    workshop_id: e.workshop_id ?? null,
    evaluator_email: e.evaluator_email ?? null,
    participant_ids: [...ids],
    submitted_at: e.updated_at ?? e.created_at ?? new Date().toISOString(),
  }
}

export interface ParticipantCoverage {
  count: number
  evaluators: string[]
  lastAt: string
}

/**
 * Aggregate coverage rows into per-participant coverage. Pure (no I/O) so it can
 * be unit-tested; coverageForActivity wraps it around a Dexie query. Recomputing
 * from whole rows on each read means an edit that drops a participant correctly
 * lowers that participant's count.
 */
export function aggregateCoverage(rows: CoverageRow[]): Map<string, ParticipantCoverage> {
  const map = new Map<string, ParticipantCoverage>()
  for (const row of rows) {
    for (const pid of row.participant_ids) {
      const existing = map.get(pid)
      if (existing) {
        existing.count += 1
        if (row.evaluator_email && !existing.evaluators.includes(row.evaluator_email)) {
          existing.evaluators.push(row.evaluator_email)
        }
        if (row.submitted_at > existing.lastAt) existing.lastAt = row.submitted_at
      } else {
        map.set(pid, {
          count: 1,
          evaluators: row.evaluator_email ? [row.evaluator_email] : [],
          lastAt: row.submitted_at,
        })
      }
    }
  }
  return map
}

/** Per-participant coverage for an activity, read live from the local cache. */
export async function coverageForActivity(activityId: string): Promise<Map<string, ParticipantCoverage>> {
  const rows = await db.coverage.where('activity_id').equals(activityId).toArray()
  return aggregateCoverage(rows)
}

/** Upsert a single coverage row (idempotent on client_id). */
export async function upsertCoverage(row: CoverageRow | null): Promise<void> {
  if (!row) return
  await db.coverage.put(row)
}

/**
 * Seed the coverage cache from this device's local submitted evaluations. Runs
 * even when offline / Supabase-unconfigured, so the cue works local-only.
 */
export async function seedCoverageFromLocal(): Promise<void> {
  const local = await db.evaluations.toArray()
  const rows = local
    .map((e) => coverageRowFromEvaluation(e))
    .filter((r): r is CoverageRow => r !== null)
  if (rows.length > 0) await db.coverage.bulkPut(rows)
}

/**
 * Pull all submitted evaluations for a workshop into the coverage cache. Closes
 * the push-only gap so a device sees coverage that predates its realtime
 * subscription. No-ops when unconfigured or offline.
 */
export async function pullCoverage(workshopId: string): Promise<void> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return
  const { data, error } = await supabase
    .from('evaluation')
    .select(
      'client_id, activity_id, workshop_id, evaluator_email, participant_scope, focus_participant_id, attestation, created_at, updated_at',
    )
    .eq('workshop_id', workshopId)
    .eq('attestation', true)
  if (error) {
    console.warn('[cairn] coverage pull failed', error)
    return
  }
  const rows = (data ?? [])
    .map((e) => coverageRowFromEvaluation(e as EvalLike))
    .filter((r): r is CoverageRow => r !== null)
  if (rows.length > 0) await db.coverage.bulkPut(rows)
}

/**
 * Subscribe to Supabase Realtime changes on the `evaluation` table for a
 * workshop. On each insert/update of a submitted evaluation, upsert its coverage
 * row (which the participant selector live-queries). Returns an unsubscribe fn.
 * No-ops (returns a noop) when unconfigured.
 */
export function subscribeCoverage(workshopId: string): () => void {
  if (!isSupabaseConfigured || !supabase) return () => {}
  const client = supabase
  const channel = client
    .channel(`coverage:${workshopId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'evaluation', filter: `workshop_id=eq.${workshopId}` },
      (payload) => {
        const row = coverageRowFromEvaluation(payload.new as EvalLike)
        if (row) void upsertCoverage(row)
      },
    )
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}

/**
 * Start live coverage sync: seed from local first (works offline), then — when
 * Supabase is configured and online — pull + subscribe for each cached workshop
 * (normally one). Returns a cleanup fn. Mirrors startSyncLoop in db/sync.ts.
 */
export function startCoverageSync(): () => void {
  let cleanups: Array<() => void> = []
  let cancelled = false

  void (async () => {
    await seedCoverageFromLocal()
    if (cancelled || !isSupabaseConfigured || !supabase || !navigator.onLine) return
    const workshops = await db.workshops.toArray()
    for (const w of workshops) {
      if (cancelled) break
      await pullCoverage(w.id)
      cleanups.push(subscribeCoverage(w.id))
    }
  })()

  return () => {
    cancelled = true
    for (const c of cleanups) c()
    cleanups = []
  }
}
