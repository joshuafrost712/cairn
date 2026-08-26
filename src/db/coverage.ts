import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { acquireChannel } from './channelRegistry'
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

/** One spelling of an evaluator's address, so two spellings cannot be two people. */
function normalizeEvaluatorEmail(email: string | null | undefined): string | null {
  const v = email?.trim().toLowerCase()
  return v ? v : null
}

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
    // Normalized HERE, at the one place a coverage row is born, rather than at the
    // three places `aggregateCoverage` compares it. `myCaptures` already lower-cases
    // before matching an evaluator against the signed-in address, so a row written
    // as `Matt.Menger@sil.org` collapsed correctly in My evaluations and counted as
    // a second, separate evaluator in the coverage badge's initials. Fixing the
    // comparisons would leave the first-write path raw and the drift alive.
    evaluator_email: normalizeEvaluatorEmail(e.evaluator_email),
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

/**
 * The same aggregate for a whole workshop (tl-36).
 *
 * Keyed on `workshop_id`, which every coverage row carries, so it also sees the
 * rows `coverageForActivity` structurally cannot: a free-write capture has no
 * activity, and IndexedDB does not index a record whose index key is null, so
 * those rows are invisible to every `where('activity_id')` query ever written.
 * Read by the free-write capture screen, which has no session to scope to.
 */
export async function coverageForWorkshop(workshopId: string): Promise<Map<string, ParticipantCoverage>> {
  const rows = await db.coverage.where('workshop_id').equals(workshopId).toArray()
  return aggregateCoverage(rows)
}

/**
 * Coverage from FREE-WRITE captures only: the ones with no activity at all.
 *
 * A separate map, and separate from `coverageForWorkshop` on purpose. The problem
 * it solves is real: a free-write naming Joemar shows on its author's screen and
 * on no session screen anywhere, because IndexedDB does not index a null key and
 * so `coverageForActivity`'s `where('activity_id')` can never see those rows.
 *
 * The fix that suggests itself — union the workshop map into the activity grid —
 * is wrong, and worth naming so nobody tries it again. `coverageForWorkshop`
 * aggregates EVERY row in the workshop, so merging it would mark somebody covered
 * for this session because they were covered in a different one, and the merged
 * map has no per-row provenance left to tell the two apart. That would corrupt the
 * "N of 26 still need evaluation" cue, which is the number an evaluator standing
 * in the room actually steers by.
 *
 * So this returns its own map, the session's quota keeps counting only the
 * session's captures, and the capture screen renders the two as two badges.
 */
export async function coverageForFreeWrites(
  workshopId: string,
): Promise<Map<string, ParticipantCoverage>> {
  const rows = await db.coverage.where('workshop_id').equals(workshopId).toArray()
  return aggregateCoverage(rows.filter((r) => r.activity_id == null))
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
  // Through the registry rather than directly: supabase-js hands back the
  // channel it already holds for a topic, and `.on()` after `.subscribe()`
  // throws. See db/channelRegistry.ts for the StrictMode sequence that hit this.
  return acquireChannel(`coverage:${workshopId}`, () => {
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
  })
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
    if (cancelled) return
    for (const w of workshops) {
      await pullCoverage(w.id)
      // Re-checked AFTER the await, not only before it. The old order let a
      // cancelled run subscribe anyway, so the cleanup that set the flag had
      // nothing to release and the channel outlived the mount that opened it.
      if (cancelled) return
      cleanups.push(subscribeCoverage(w.id))
    }
  })()

  return () => {
    cancelled = true
    for (const c of cleanups) c()
    cleanups = []
  }
}
