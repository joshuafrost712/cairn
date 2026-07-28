import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { memberPk } from '../auth/membership'
import type { WorkshopMember, WorkshopRole } from '../lib/types'

/**
 * The caller's own workshop memberships: fetch from Postgres, cache in Dexie,
 * fall back to the cache when offline.
 *
 * Only the caller's own rows are cached. The full roster of a workshop is a
 * different question (tl-11's people directory) and reading it here would put
 * other people's roles on every device for no reason.
 */

/** Bound on the membership fetch. A stalled request must degrade to the cache. */
const MEMBERSHIP_TIMEOUT_MS = 8_000

interface MemberRow {
  workshop_id: string
  app_user_id: string
  role: string
  added_by?: string | null
  added_at?: string | null
}

const isWorkshopRole = (r: string): r is WorkshopRole =>
  ['chief_admin', 'admin', 'chief_evaluator', 'consultant', 'evaluator', 'participant'].includes(r)

function toMember(row: MemberRow): WorkshopMember | null {
  // A role the client does not recognize is dropped rather than coerced. Coercing
  // it would either invent privilege or silently strip it; dropping the row makes
  // the membership absent, which the UI already has an honest state for.
  if (!isWorkshopRole(row.role)) return null
  return {
    pk: memberPk(row.workshop_id, row.app_user_id),
    workshop_id: row.workshop_id,
    app_user_id: row.app_user_id,
    role: row.role,
    added_by: row.added_by ?? null,
    added_at: row.added_at ?? null,
  }
}

/** Every cached membership for this device's signed-in account. */
export async function cachedMemberships(appUserId: string | null): Promise<WorkshopMember[]> {
  if (!appUserId) return []
  try {
    return await db.workshopMembers.where('app_user_id').equals(appUserId).toArray()
  } catch {
    return []
  }
}

/**
 * Pull the caller's memberships and replace the cached copy.
 *
 * Returns the cache on any failure rather than an empty list: an evaluator whose
 * network drops mid-workshop must keep the role they had, and "fetch failed" is
 * not the same fact as "you have been removed". The cache is only cleared on a
 * successful fetch that genuinely returns nothing.
 */
export async function refreshMemberships(appUserId: string | null): Promise<WorkshopMember[]> {
  if (!appUserId) return []
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return cachedMemberships(appUserId)
  }
  try {
    const { data, error } = await supabase
      .from('workshop_member')
      .select('workshop_id, app_user_id, role, added_by, added_at')
      .eq('app_user_id', appUserId)
      .abortSignal(AbortSignal.timeout(MEMBERSHIP_TIMEOUT_MS))
    if (error) {
      console.warn('[honest-eval] membership fetch failed; using cached memberships.', error)
      return cachedMemberships(appUserId)
    }
    const rows = ((data ?? []) as MemberRow[])
      .map(toMember)
      .filter((m): m is WorkshopMember => m !== null)
    await db.transaction('rw', db.workshopMembers, async () => {
      const stale = await db.workshopMembers.where('app_user_id').equals(appUserId).toArray()
      const keep = new Set(rows.map((r) => r.pk))
      await db.workshopMembers.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
      await db.workshopMembers.bulkPut(rows)
    })
    return rows
  } catch (err) {
    console.warn('[honest-eval] membership fetch threw; using cached memberships.', err)
    return cachedMemberships(appUserId)
  }
}

/**
 * Local-only mode (no Supabase configured) has no membership table to read, so
 * the chosen sign-in role is synthesized into a membership over the seeded
 * workshop. Keeps the offline demo path working without giving the online path a
 * client-asserted role: this function is never reached when Supabase is
 * configured.
 */
export async function synthesizeLocalMembership(
  appUserId: string,
  role: WorkshopRole,
): Promise<WorkshopMember[]> {
  const workshops = await db.workshops.toArray()
  const rows: WorkshopMember[] = workshops.map((w) => ({
    pk: memberPk(w.id, appUserId),
    workshop_id: w.id,
    app_user_id: appUserId,
    role,
    added_by: null,
    added_at: null,
  }))
  if (rows.length > 0) await db.workshopMembers.bulkPut(rows)
  return rows
}
