import { db, newId } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { enqueueReferenceWrite, pushReferenceOutbox } from './referenceWrite'
import {
  briefValue,
  defaultAiConfig,
  functionsValue,
  resolveAiConfig,
  type AiBrief,
  type AiConfig,
  type AiConfigRow,
  type AiFunction,
  type AiMode,
} from '../lib/aiConfig'
import type { AiCallLogEntry } from '../lib/types'

/**
 * The AI configuration: its offline-first cache, its one write path, and the trace
 * sink (tl-13).
 *
 * Same shape as db/settings.ts and db/scale.ts — Dexie immediately, backend queued
 * — with one deliberate difference, which is the trace.
 *
 * ## Why the trace does not use the reference outbox
 *
 * Every other backend write in this app queues in `referenceOutbox`, and
 * `loadReferenceData()` refuses its destructive pull while anything is pending
 * there. That is exactly right for an administrator's edit: better a stale pull
 * than a lost decision. It is exactly wrong for a log line. A trace the backend
 * will not accept — an `ai_call_log` insert refused because the actor has since
 * been demoted, say — would sit in that queue forever and silently stop the device
 * refreshing its questions, roster and scale. The failure would present as "the app
 * stopped updating", days later, with nothing pointing at the log.
 *
 * So traces get their own table with their own `sync_status` and their own
 * best-effort push. A trace that cannot be delivered stays local and marked; it is
 * visible in the AI section, and it blocks nothing.
 */

/** Cached rows. Kept as raw rows so `resolveAiConfig` stays the only reader. */
export async function aiConfigRows(): Promise<AiConfigRow[]> {
  return db.aiConfigs.toArray()
}

/**
 * One workshop's resolved configuration.
 *
 * A null workshop id resolves to the defaults rather than throwing, matching
 * `getSettings()`: several callers run before a workshop is selected, and the
 * honest answer there is "what the app would do anyway".
 */
export async function getAiConfig(workshopId: string | null): Promise<AiConfig> {
  if (!workshopId) return defaultAiConfig(null)
  return resolveAiConfig(workshopId, await db.aiConfigs.toArray())
}

/**
 * Write the whole configuration: Dexie now, backend when it can be reached.
 *
 * ONE ENTRY FOR THE WHOLE ROW rather than one per toggle. Six toggles saved as six
 * queued upserts of the same primary key would collapse to one entry anyway (the
 * outbox keys on `${table}:${rowKey}`), so the only thing per-toggle entries would
 * add is a window in which the queue holds a half-applied configuration.
 */
export async function saveAiConfig(
  workshopId: string,
  next: {
    mode?: AiMode
    functions?: AiConfig['functions']
    /**
     * The SPARSE assumption map (tl-14) — only what differs from the estimator's
     * defaults. Pass `{}` to reset a workshop to the defaults; omit to leave the
     * stored overrides alone, which is what every tl-13 caller does.
     */
    assumptions?: Record<string, number>
    /** The brief pack's settings (tl-15). Omit to leave them alone. */
    brief?: AiBrief
  },
  updatedBy: string | null,
): Promise<AiConfig> {
  const current = await getAiConfig(workshopId)
  const merged: AiConfig = {
    ...current,
    workshop_id: workshopId,
    mode: next.mode ?? current.mode,
    functions: next.functions ?? current.functions,
    assumptions: next.assumptions ?? current.assumptions,
    brief: next.brief ?? current.brief,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  }
  const row: AiConfigRow = {
    workshop_id: workshopId,
    mode: merged.mode,
    functions: functionsValue(merged),
    assumptions: merged.assumptions,
    brief: briefValue(merged.brief),
    updated_by: merged.updated_by,
    updated_at: merged.updated_at,
  }
  await db.aiConfigs.put(row)
  await enqueueReferenceWrite({
    id: `ai_config:${workshopId}`,
    table: 'ai_config',
    op: 'upsert',
    rowKey: workshopId,
    payload: row,
  })
  void pushReferenceOutbox()
  return merged
}

/**
 * Choose the model one function uses, leaving the rest of the configuration alone (tl-14).
 *
 * Null clears the choice, which means "whatever the provider's own default is" — for
 * the hosted path that is the Edge Function's `GEMINI_MODEL`, and for the two
 * subscription modes it is whatever model the human happens to be signed in to. That
 * is a real state rather than a missing one, so it is representable.
 */
export async function setAiFunctionModel(
  workshopId: string,
  fn: AiFunction,
  model: string | null,
  updatedBy: string | null,
): Promise<AiConfig> {
  const current = await getAiConfig(workshopId)
  return saveAiConfig(
    workshopId,
    { functions: { ...current.functions, [fn]: { ...current.functions[fn], model } } },
    updatedBy,
  )
}

/**
 * Record where the operator's course materials live (tl-15).
 *
 * Separate writer from `saveAiConfig` for the same reason `setAiAssumptions` is: the
 * caller has one thing in hand and should not have to reconstruct the rest of the
 * configuration to save it. The `pack_generated_at` stamp is deliberately NOT set here —
 * see `stampPackGenerated`, which is a different act by a different screen.
 */
export async function setAiLocalFiles(
  workshopId: string,
  localFiles: string[],
  localFilesNote: string | null,
  updatedBy: string | null,
): Promise<AiConfig> {
  const current = await getAiConfig(workshopId)
  return saveAiConfig(
    workshopId,
    { brief: { ...current.brief, localFiles, localFilesNote } },
    updatedBy,
  )
}

/**
 * Record that a pack was generated, so the screen can say when.
 *
 * Best-effort and deliberately not part of the pack's own success: the download has
 * already happened by the time this runs, and a failed stamp must not report a failed
 * pack. It also does not route through tl-07's dialog, because generating a pack is an
 * action rather than a setting — the same distinction tl-14 drew between changing a model
 * (dialog) and changing an assumption (no dialog).
 */
export async function stampPackGenerated(
  workshopId: string,
  generatedAt: string,
  updatedBy: string | null,
): Promise<void> {
  try {
    const current = await getAiConfig(workshopId)
    await saveAiConfig(workshopId, { brief: { ...current.brief, packGeneratedAt: generatedAt } }, updatedBy)
  } catch {
    /* the pack is downloaded; a missing timestamp is not worth an error on screen */
  }
}

/** Replace the estimator's assumption overrides (tl-14). `{}` resets to the defaults. */
export async function setAiAssumptions(
  workshopId: string,
  assumptions: Record<string, number>,
  updatedBy: string | null,
): Promise<AiConfig> {
  return saveAiConfig(workshopId, { assumptions }, updatedBy)
}

/** Toggle one function, leaving the rest of the configuration alone. */
export async function setAiFunctionEnabled(
  workshopId: string,
  fn: AiFunction,
  enabled: boolean,
  updatedBy: string | null,
): Promise<AiConfig> {
  const current = await getAiConfig(workshopId)
  return saveAiConfig(
    workshopId,
    { functions: { ...current.functions, [fn]: { ...current.functions[fn], enabled } } },
    updatedBy,
  )
}

/**
 * Replace the cached rows with what the backend returned.
 *
 * `inScope` carries the meaning it does in `cacheSettingRows`: the workshops this
 * pull was AUTHORIZED to see, so "no row because there is none" (prune) can be told
 * from "no row because RLS filtered it out" (leave alone).
 *
 * One extra wrinkle here, because `ai_config` is admin-only rather than
 * member-readable: a workshop where the caller is a plain evaluator is in `inScope`
 * (they can read the workshop) and returns no config row. Pruning it is the RIGHT
 * behaviour — a device whose user is no longer an administrator should not go on
 * holding that workshop's provider configuration — and it is worth stating out
 * loud, because the same code in settings.ts means something slightly different.
 */
export async function cacheAiConfigRows(
  rows: AiConfigRow[],
  inScope?: Iterable<string>,
): Promise<void> {
  const typed: AiConfigRow[] = rows.map((r) => ({
    workshop_id: r.workshop_id,
    mode: r.mode,
    functions: r.functions,
    // Carried explicitly rather than by spread, so a column added server-side does
    // not silently start being cached before this client knows what it means.
    assumptions: r.assumptions ?? {},
    updated_by: r.updated_by ?? null,
    updated_at: r.updated_at ?? null,
  }))
  const keep = new Set(typed.map((t) => t.workshop_id))
  const touched = new Set([...(inScope ?? []), ...keep])
  await db.transaction('rw', db.aiConfigs, async () => {
    const stale = (await db.aiConfigs.toArray()).filter(
      (row) => touched.has(row.workshop_id) && !keep.has(row.workshop_id),
    )
    await db.aiConfigs.bulkDelete(stale.map((s) => s.workshop_id))
    await db.aiConfigs.bulkPut(typed)
  })
}

// ---------------------------------------------------------------------------
// Deployment switches
// ---------------------------------------------------------------------------

const HOSTED_KEY = 'cairn.ai.hosted_enabled'

/**
 * Whether this deployment permits hosted, metered AI at all.
 *
 * Mirrored into localStorage for the same reason the verification threshold is:
 * the read is synchronous (a render decides whether to offer a mode) and the value
 * changes about once in the life of a deployment. Defaults to FALSE when nothing is
 * known, which is the safe direction — an unknown answer offers the mode that
 * spends nobody's money.
 */
export function hostedAiEnabled(): boolean {
  try {
    return localStorage.getItem(HOSTED_KEY) === 'true'
  } catch {
    return false
  }
}

function mirrorHostedAi(enabled: boolean): void {
  try {
    localStorage.setItem(HOSTED_KEY, enabled ? 'true' : 'false')
  } catch {
    /* storage disabled: the accessor falls back to false, which is the safe answer */
  }
}

/** Read the deployment switches from the backend and mirror them. Never throws. */
export async function refreshPlatformSettings(): Promise<void> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return
  const { data, error } = await supabase
    .from('platform_setting')
    .select('key, value')
    .eq('key', 'hosted_ai_enabled')
    .maybeSingle()
  if (error) {
    console.warn('[honest-eval] could not read platform settings', error.message)
    return
  }
  const value = (data as { value?: unknown } | null)?.value
  mirrorHostedAi(value === true || value === 'true')
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

/**
 * Record one provider call. Never throws, and never blocks the call it describes.
 *
 * Fail-loud-to-the-trace is the protocol's rule (§4), and its corollary is that the
 * tracing itself must not become a way for the feature to fail: a provider whose
 * result is thrown away because the log could not be written would be a worse app
 * than one with no log.
 */
export async function traceAiCall(
  entry: Omit<AiCallLogEntry, 'id' | 'at' | 'sync_status'>,
): Promise<void> {
  const row: AiCallLogEntry = {
    ...entry,
    id: newId(),
    at: new Date().toISOString(),
    sync_status: 'local',
  }
  try {
    await db.aiCallLog.put(row)
  } catch (err) {
    console.warn('[honest-eval] could not record an AI trace locally', err)
    return
  }
  void pushAiCallLog()
}

/** The most recent traces for one workshop, newest first. */
export async function recentAiCalls(workshopId: string, limit = 20): Promise<AiCallLogEntry[]> {
  const rows = await db.aiCallLog.where('workshop_id').equals(workshopId).toArray()
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/**
 * Push local traces to the backend, best-effort.
 *
 * Serialized like `pushReferenceOutbox` and for the same reason: two overlapping
 * drains would both read the pending list before either marked anything, and the
 * second would insert a duplicate row that no key would collide with.
 */
export function pushAiCallLog(): Promise<{ pushed: number; pending: number }> {
  const run = pushQueue.then(drainAiCallLog, drainAiCallLog)
  pushQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

let pushQueue: Promise<void> = Promise.resolve()

async function drainAiCallLog(): Promise<{ pushed: number; pending: number }> {
  // The whole function is inside the guard, not just the network half. This is fired
  // and not awaited from `traceAiCall`, so a Dexie failure here would surface as an
  // unhandled rejection somewhere unrelated to the log — and the log is the one
  // subsystem in this app that must never be able to break the thing it observes.
  let pendingRows
  try {
    pendingRows = await db.aiCallLog.where('sync_status').anyOf('local', 'error').toArray()
  } catch {
    return { pushed: 0, pending: 0 }
  }
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return { pushed: 0, pending: pendingRows.length }
  }
  let pushed = 0
  for (const row of pendingRows) {
    const { error } = await supabase.from('ai_call_log').insert({
      id: row.id,
      workshop_id: row.workshop_id,
      fn: row.fn,
      mode: row.mode,
      model: row.model,
      actor_email: row.actor_email,
      input_chars: row.input_chars,
      outcome: row.outcome,
      detail: row.detail,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      latency_ms: row.latency_ms,
      at: row.at,
    })
    if (error) {
      // Marked and left alone. Not retried into the ground and not deleted: a
      // refused trace is itself a fact worth seeing in the AI section.
      await db.aiCallLog.update(row.id, { sync_status: 'error', sync_error: error.message })
      continue
    }
    await db.aiCallLog.update(row.id, { sync_status: 'synced', sync_error: null })
    pushed++
  }
  try {
    const stillPending = await db.aiCallLog.where('sync_status').anyOf('local', 'error').count()
    return { pushed, pending: stillPending }
  } catch {
    return { pushed, pending: 0 }
  }
}
