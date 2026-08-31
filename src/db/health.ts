import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { WorkshopHealth } from '../reports/health'

/**
 * The briefing's one server read (tl-38).
 *
 * This module deliberately does NOT write to Dexie. Every other read in this app
 * pulls rows into the local database so the app works offline against them, and
 * that is right for evidence. It is wrong for this payload: it is one JSON blob
 * per workshop with no index and nothing to query, so a Dexie store would burn a
 * schema version on a cache. The snapshot lives in `localStorage` instead.
 *
 * The key keeps the `cairn.` prefix. Storage identifiers keep whichever codename
 * they were born with; renaming one orphans data on a device that already holds it.
 */

const KEY_PREFIX = 'cairn.health.'

export interface HealthSnapshot {
  data: WorkshopHealth
  fetchedAt: string
}

export type HealthResult =
  | { ok: true; data: WorkshopHealth; fetchedAt: string }
  | { ok: false; reason: 'offline' | 'refused' | 'error'; message: string }

function keyFor(workshopId: string): string {
  return `${KEY_PREFIX}${workshopId}`
}

/**
 * Forget a workshop's snapshot.
 *
 * Called the moment the server refuses. A cached briefing outlives the permission
 * that earned it, and the cache key carries a workshop id but no user, so without
 * this a demoted chief, or the next person to use a shared browser profile, could
 * be shown the last report the device happened to hold.
 */
export function clearCachedHealth(workshopId: string): void {
  try {
    localStorage.removeItem(keyFor(workshopId))
  } catch {
    // Nothing to do and nothing to report: the caller is already handling a refusal.
  }
}

/** Every cached briefing on this device, dropped. Used on sign-out. */
export function clearAllCachedHealth(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // Best effort. Sign-out must not fail because a cache would not clear.
  }
}

/**
 * May a failed read fall back to the device's saved snapshot?
 *
 * Every failure may, EXCEPT a refusal. Offline with a saved copy is a real and
 * useful state, and the page labels it with its age. `refused` is different in
 * kind: the server has just said this caller may not read this workshop, and
 * answering that with the last report the device happens to hold is worse than
 * answering it with zeroes, because the numbers are real and correct and nothing
 * on screen says whose they are. Extracted from the page so the rule is a tested
 * one rather than a condition somebody can widen without noticing.
 */
export function mayFallBackToCache(result: HealthResult): boolean {
  return !result.ok && result.reason !== 'refused'
}

export function readCachedHealth(workshopId: string): HealthSnapshot | null {
  try {
    const raw = localStorage.getItem(keyFor(workshopId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as HealthSnapshot
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null
    return parsed
  } catch {
    // A corrupt cache is a cache miss, never a crash on a page somebody opened
    // because something was already wrong.
    return null
  }
}

function writeCachedHealth(workshopId: string, snapshot: HealthSnapshot): void {
  try {
    localStorage.setItem(keyFor(workshopId), JSON.stringify(snapshot))
  } catch {
    // Quota or private-mode refusal. The fetch already succeeded and the page is
    // about to render it; losing the cache costs a re-fetch, not the report.
  }
}

/**
 * Postgres raises `tl38.not_permitted_for_this_workshop` with SQLSTATE 42501 when
 * the caller may not read this workshop. It raises rather than returning an empty
 * report on purpose, because a health surface that answers a refusal with zeros
 * says the workshop is fine. Both halves are checked: the slug, and the code.
 */
function isRefusal(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false
  return (
    (error.message ?? '').includes('tl38.not_permitted_for_this_workshop') || error.code === '42501'
  )
}

export async function fetchWorkshopHealth(
  workshopId: string,
  staleHours = 24,
): Promise<HealthResult> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return { ok: false, reason: 'offline', message: 'no backend reachable' }
  }

  const { data, error } = await supabase.rpc('workshop_health', {
    _workshop_id: workshopId,
    _stale_hours: staleHours,
  })

  if (error) {
    if (isRefusal(error)) {
      // The snapshot dies with the permission. Keeping it would let the page fall
      // back to a report this caller is no longer entitled to read.
      clearCachedHealth(workshopId)
      return { ok: false, reason: 'refused', message: error.message }
    }
    return { ok: false, reason: 'error', message: error.message }
  }
  if (!data) {
    return { ok: false, reason: 'error', message: 'the report came back empty' }
  }

  const fetchedAt = new Date().toISOString()
  const health = data as WorkshopHealth
  writeCachedHealth(workshopId, { data: health, fetchedAt })
  return { ok: true, data: health, fetchedAt }
}
