import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { memberPk } from '../auth/membership'
import type { MembershipChangeLog, WorkshopMember, WorkshopRole } from '../lib/types'

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

/**
 * ## Changing a membership: the three RPCs (tl-02)
 *
 * `workshop_member` still has no client write path — tl-01 revoked the grants
 * rather than merely omitting a policy. Every change goes through a
 * security-definer function that resolves the caller from `auth.uid()` and
 * applies the promotion matrix server-side. The client's copy of that matrix
 * (`src/lib/permissions.ts`) decides which buttons to offer; it decides nothing
 * else.
 *
 * **These three are deliberately online-only, and that is a departure from this
 * wave's offline-first default.** Every other write in the app queues through an
 * outbox because it records something the evaluator observed, and the backend's
 * job is to accept it. A membership change is the opposite: the result is the
 * server's decision, not the caller's observation. Queueing one offline would
 * show a promotion on the device that the matrix may refuse an hour later, which
 * is the failure mode tl-01's `isAuthorizationRefusal()` exists to contain — and
 * here it would be a lie about who can do what, held on the one screen an
 * administrator would trust. So a refusal is returned rather than queued, and
 * `offline` is its own result the UI can name.
 */

/**
 * What a membership call did. Not a thrown error: the server's refusal text is
 * written to be readable, and the slug in `detail` is a stable key tl-11 can map
 * to a chrome.json string rather than rendering Postgres prose forever.
 */
export type MembershipResult =
  | { ok: true }
  | { ok: false; reason: 'offline'; slug: null; message: null }
  | { ok: false; reason: 'refused' | 'failed'; slug: string | null; message: string }

const OFFLINE: MembershipResult = { ok: false, reason: 'offline', slug: null, message: null }

interface PostgrestLikeError {
  message?: string
  details?: string | null
  code?: string | null
}

/** A refusal raised by `raise_refusal()` carries 42501 and a slug in `details`. */
function toResult(error: PostgrestLikeError | null): MembershipResult {
  if (!error) return { ok: true }
  const slug = typeof error.details === 'string' && error.details.startsWith('tl02.')
    ? error.details
    : null
  return {
    ok: false,
    reason: error.code === '42501' ? 'refused' : 'failed',
    slug,
    message: error.message ?? 'That change could not be made.',
  }
}

async function callMembershipRpc(
  fn: 'set_workshop_member_role' | 'remove_workshop_member' | 'transfer_chief_admin',
  args: Record<string, string>,
): Promise<MembershipResult> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return OFFLINE
  try {
    const { error } = await supabase.rpc(fn, args)
    return toResult(error)
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      slug: null,
      message: err instanceof Error ? err.message : 'That change could not be made.',
    }
  }
}

/** Grant or re-rank a workshop role. Refused unless the matrix permits it. */
export async function setWorkshopMemberRole(
  workshopId: string,
  targetAppUserId: string,
  role: WorkshopRole,
): Promise<MembershipResult> {
  return callMembershipRpc('set_workshop_member_role', {
    _workshop_id: workshopId,
    _target_app_user_id: targetAppUserId,
    _role: role,
  })
}

/**
 * Remove somebody from a workshop. Passing your own app_user id is how you leave
 * one, which every role but the chief admin may do without anybody's permission.
 */
export async function removeWorkshopMember(
  workshopId: string,
  targetAppUserId: string,
): Promise<MembershipResult> {
  return callMembershipRpc('remove_workshop_member', {
    _workshop_id: workshopId,
    _target_app_user_id: targetAppUserId,
  })
}

/**
 * Hand the chief admin role to another member, atomically. The outgoing chief
 * admin becomes an `admin`; the workshop is never left without one.
 */
export async function transferChiefAdmin(
  workshopId: string,
  toAppUserId: string,
): Promise<MembershipResult> {
  return callMembershipRpc('transfer_chief_admin', {
    _workshop_id: workshopId,
    _to_app_user_id: toAppUserId,
  })
}

/**
 * The workshop's membership history, newest first.
 *
 * Read straight from Postgres with no Dexie cache: it is an administrator's
 * audit surface, not something an evaluator's phone needs offline, and a cached
 * copy of who-changed-what is a copy that can be stale in the one situation
 * anybody reads it.
 */
export async function membershipHistory(
  workshopId: string | null,
  limit = 100,
): Promise<MembershipChangeLog[]> {
  if (!workshopId || !isSupabaseConfigured || !supabase || !navigator.onLine) return []
  const { data, error } = await supabase
    .from('membership_change_log')
    .select(
      'id, workshop_id, actor_app_user_id, actor_email, target_app_user_id, target_email, from_role, to_role, operation, at',
    )
    .eq('workshop_id', workshopId)
    .order('at', { ascending: false })
    .limit(limit)
  if (error) {
    console.warn('[honest-eval] membership history unavailable.', error)
    return []
  }
  return (data ?? []) as MembershipChangeLog[]
}
