import { db, newId } from '../db/local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { SetupChangeLogEntry } from '../lib/types'
import type { ImpactCounts, SetupChange, SetupImpact, WorkshopState } from './impact'

/**
 * The setup audit log (tl-07).
 *
 * Three properties, in the order they matter:
 *
 *  1. **It never breaks a save.** Every function here swallows its own failures.
 *     The change has already committed by the time it is called; rolling an edit
 *     back because an audit insert was refused would make a workshop uneditable to
 *     protect its history, which is the wrong trade in both directions.
 *  2. **It survives offline.** The row is written to Dexie first and pushed to
 *     `log_setup_change()` when the network returns, the same contract as every
 *     other write in this app. A setup edit made in a Bali conference room with no
 *     signal is exactly the edit somebody will want the record of.
 *  3. **It reaches git.** Once an edit lands in the database, the database is ahead
 *     of src/data/seed.ts, and the Web App Build Protocol requires that divergence
 *     be visible rather than becoming archaeology. In dev the row is appended to
 *     `feedback/setup-changes/<date>.md`; on a deployed build there is no dev
 *     server, so the Dexie row and the Postgres row are the record.
 *
 * The actor this device sends is advisory. `log_setup_change()` overwrites it with
 * `current_app_user_email()`, so the server's copy is the caller's own address
 * whatever the client claimed.
 */

const SAFE_TO_SKIP = new Set(['safe'])

export interface LogInput {
  workshopId: string
  change: SetupChange
  impact: SetupImpact
  state: WorkshopState
  actorEmail: string | null
}

/**
 * Record one committed setup change. Never throws.
 *
 * `safe` changes are NOT logged, and that is a deliberate line rather than an
 * oversight: a safe change is one where nothing already recorded is affected, and
 * logging every keystroke of a save-on-blur title field would bury the four entries
 * an administrator actually needs to find under four hundred.
 */
export async function logSetupChange(input: LogInput): Promise<SetupChangeLogEntry | null> {
  if (SAFE_TO_SKIP.has(input.impact.severity)) return null
  try {
    const entry: SetupChangeLogEntry = {
      id: `setuplog_${newId()}`,
      workshop_id: input.workshopId,
      actor_email: input.actorEmail,
      entity: input.change.entity,
      entity_id: input.change.entityId,
      entity_label: input.change.label,
      operation: input.change.operation,
      severity: input.impact.severity,
      workshop_state: input.state,
      diff: compactDiff(input.change),
      counts: compactCounts(input.change.counts),
      at: new Date().toISOString(),
      sync_status: 'local',
    }
    await db.setupChangeLog.put(entry)
    void pushSetupLog()
    void exportSetupLogEntry(entry)
    return entry
  } catch (err) {
    // The edit stands. Say so loudly and carry on.
    console.warn('[honest-eval] setup change committed but could not be logged locally:', err)
    return null
  }
}

/**
 * Only the fields that actually changed, with their before and after.
 *
 * Truncated per value, because a jsonb column is not the place for a 4KB
 * evidence-descriptor rewrite and because the log's job is to say WHAT was touched
 * so the reader can go and look, not to be a content-versioning system.
 */
function compactDiff(change: SetupChange): SetupChangeLogEntry['diff'] {
  const out: SetupChangeLogEntry['diff'] = {}
  for (const f of change.fields ?? []) {
    out[f.field] = { before: truncate(f.before), after: truncate(f.after) }
  }
  return out
}

const MAX_VALUE_CHARS = 500

function truncate(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  return value
}

function compactCounts(counts: ImpactCounts | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (typeof value === 'number' && value > 0) out[key] = value
  }
  return out
}

/**
 * Push queued log rows through the RPC. Returns what moved, and never throws.
 *
 * An authorization refusal is terminal (the caller is not an administrator of that
 * workshop, which retrying cannot change), so the row is marked `error` with the
 * reason rather than retried forever. Anything else stays queued.
 */
export async function pushSetupLog(): Promise<{ pushed: number; pending: number; failed: number }> {
  let pushed = 0
  let failed = 0
  try {
    if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
      return { pushed: 0, pending: await pendingCount(), failed: 0 }
    }
    const queued = await db.setupChangeLog.where('sync_status').anyOf('local', 'queued').toArray()
    for (const entry of queued) {
      const { error } = await supabase.rpc('log_setup_change', {
        _id: entry.id,
        _workshop_id: entry.workshop_id,
        _entity: entry.entity,
        _entity_id: entry.entity_id,
        _entity_label: entry.entity_label,
        _operation: entry.operation,
        _severity: entry.severity,
        _workshop_state: entry.workshop_state,
        _diff: entry.diff,
        _counts: entry.counts,
      })
      if (!error) {
        await db.setupChangeLog.update(entry.id, { sync_status: 'synced', sync_error: null })
        pushed++
      } else if (/42501|permission|not an administrator|no app_user/i.test(error.message)) {
        await db.setupChangeLog.update(entry.id, {
          sync_status: 'error',
          sync_error: error.message,
        })
        failed++
        console.warn(`[honest-eval] setup log entry ${entry.id} refused: ${error.message}`)
      } else {
        await db.setupChangeLog.update(entry.id, { sync_error: error.message })
      }
    }
  } catch (err) {
    console.warn('[honest-eval] setup log push failed:', err)
  }
  return { pushed, pending: await pendingCount(), failed }
}

async function pendingCount(): Promise<number> {
  try {
    return await db.setupChangeLog.where('sync_status').anyOf('local', 'queued').count()
  } catch {
    return 0
  }
}

/** The log rows this device holds, newest first. Backs the Setup hub's history. */
export async function readSetupLog(workshopId: string, limit = 50): Promise<SetupChangeLogEntry[]> {
  const rows = await db.setupChangeLog.where('workshop_id').equals(workshopId).toArray()
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/**
 * Append one entry to the git-tracked daily file, in dev. Best-effort by design:
 * a deployed build has no dev server to post to and must not care.
 */
async function exportSetupLogEntry(entry: SetupChangeLogEntry): Promise<boolean> {
  const date = entry.at.slice(0, 10)
  const counts = Object.entries(entry.counts)
    .map(([key, value]) => `${value} ${key}`)
    .join(', ')
  const lines = [
    '',
    `## ${entry.at} — ${entry.severity} — ${entry.entity} ${entry.operation}`,
    '',
    `**${entry.entity_label}**${entry.entity_id ? ` (\`${entry.entity_id}\`)` : ''} · by ${entry.actor_email ?? 'unknown'} · workshop ${entry.workshop_state}`,
    '',
    counts ? `Counts quoted in the dialog: ${counts}.` : 'No affected records were counted.',
  ]
  for (const [field, value] of Object.entries(entry.diff)) {
    lines.push('', `\`${field}\``, '', '```diff', `- ${render(value.before)}`, `+ ${render(value.after)}`, '```')
  }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__setup-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, markdown: `${lines.join('\n')}\n` }),
    })
    return res.ok
  } catch {
    return false
  }
}

const render = (value: unknown): string =>
  value == null ? '(empty)' : typeof value === 'string' ? value : JSON.stringify(value)
