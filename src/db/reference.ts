import { db, activityKsaPk } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { pushReferenceOutbox } from './referenceWrite'
import { cacheSettingRows, mirrorActiveWorkshop } from './settings'
import { cacheAssignmentRows } from './assignments'
import { getActiveWorkshopId } from '../lib/activeWorkshop'
import * as seed from '../data/seed'
import type { Activity, Ksa } from '../lib/types'

/**
 * Whether there is a session to read reference data with. Never throws: no
 * session and "could not tell" both mean the same thing here, which is to fall
 * back to the cache or the seed.
 */
async function hasSession(): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    return data.session != null
  } catch {
    return false
  }
}

/**
 * Load reference data (workshops, activities, KSAs, etc.) into the local cache.
 * - Supabase configured + online + AUTHENTICATED: fetch fresh and overwrite the cache.
 * - Otherwise: if the cache is empty, prime it from the local seed so the app works.
 * Capture always reads from the local cache, so it works offline after first load.
 *
 * The authenticated requirement arrived with tl-01. Reads on the reference tables
 * used to be open to `anon` precisely so this function could run on a cold,
 * pre-auth start, and that openness is what made per-workshop roles meaningless:
 * anybody holding the public anon key could read every workshop in the
 * deployment. Now a session is required and rows are membership-scoped, so a
 * pre-auth device shows the bundled seed rather than real workshop data. That is
 * a visible behaviour change, and the intended one.
 */
export async function loadReferenceData(): Promise<void> {
  const authed = await hasSession()
  if (isSupabaseConfigured && supabase && navigator.onLine && authed) {
    // Drain any locally-authored reference edits (Scenario Builder / roster) up to
    // the backend first, so the destructive pull below reflects them rather than
    // clobbering them. If anything is still pending afterward (e.g. a transient
    // push error), SKIP the overwrite entirely and keep the local cache — losing
    // unsynced authoring would be worse than serving a slightly stale remote.
    const { pending } = await pushReferenceOutbox()
    if (pending > 0) {
      console.warn('[cairn] reference outbox has unsynced entries; keeping local cache')
      return
    }
    try {
      const [w, t, p, a, k, ak, st, ra] = await Promise.all([
        supabase.from('workshop').select('*'),
        supabase.from('team').select('*'),
        supabase.from('participant').select('*'),
        supabase.from('activity').select('*'),
        supabase.from('ksa').select('*'),
        supabase.from('activity_ksa').select('*'),
        supabase.from('workshop_setting').select('*'),
        supabase.from('report_assignment').select('*'),
      ])
      const firstError = [w, t, p, a, k, ak, st, ra].find((r) => r.error)?.error
      if (firstError) throw firstError

      await db.transaction(
        'rw',
        [db.workshops, db.teams, db.participants, db.activities, db.ksas, db.activityKsas],
        async () => {
          await Promise.all([
            db.workshops.clear(),
            db.teams.clear(),
            db.participants.clear(),
            db.activities.clear(),
            db.ksas.clear(),
            db.activityKsas.clear(),
          ])
          await db.workshops.bulkPut(w.data ?? [])
          await db.teams.bulkPut(t.data ?? [])
          await db.participants.bulkPut(p.data ?? [])
          await db.activities.bulkPut(a.data ?? [])
          await db.ksas.bulkPut(k.data ?? [])
          await db.activityKsas.bulkPut(
            (ak.data ?? []).map((row: { activity_id: string; ksa_id: string; sort_order: number }) => ({
              ...row,
              pk: activityKsaPk(row.activity_id, row.ksa_id),
            })),
          )
        },
      )
      // Settings and assignments live in their own modules because their caches
      // are keyed and pruned differently from the six tables above, but they are
      // server-authoritative in exactly the same way, so they refresh here rather
      // than growing a second pull the caller has to remember to make.
      await cacheSettingRows(st.data ?? [])
      await cacheAssignmentRows(ra.data ?? [])
      // Re-point the synchronous verification threshold at what just arrived.
      // It happens HERE rather than in a separate effect so there is no window
      // in which fresh settings sit in Dexie while the gate still runs on the
      // previous value. See the header of db/settings.ts for why the mirror
      // exists at all.
      await mirrorActiveWorkshop(getActiveWorkshopId())
      return
    } catch (err) {
      // Fall through to whatever is cached; capture must not be blocked by a fetch failure.
      console.warn('[cairn] reference fetch failed, using cache', err)
    }
  }

  // Local-only mode (or no cache yet): prime from seed if empty.
  const count = await db.workshops.count()
  if (count === 0) await primeFromSeed()
}

export async function primeFromSeed(): Promise<void> {
  await db.transaction(
    'rw',
    [db.workshops, db.teams, db.participants, db.activities, db.ksas, db.activityKsas],
    async () => {
      await db.workshops.bulkPut(seed.seedWorkshops)
      await db.teams.bulkPut(seed.seedTeams)
      await db.participants.bulkPut(seed.seedParticipants)
      await db.activities.bulkPut(seed.seedActivities)
      await db.ksas.bulkPut(seed.seedKsas)
      await db.activityKsas.bulkPut(
        seed.seedActivityKsas.map((r) => ({ ...r, pk: activityKsaPk(r.activity_id, r.ksa_id) })),
      )
    },
  )
}

/** KSAs linked to an activity, in display order. */
export async function ksasForActivity(activityId: string): Promise<Ksa[]> {
  const links = await db.activityKsas.where('activity_id').equals(activityId).sortBy('sort_order')
  const ksas = await db.ksas.bulkGet(links.map((l) => l.ksa_id))
  return ksas.filter((k): k is Ksa => Boolean(k))
}

/** Activities for a workshop, ordered. */
export async function activitiesForWorkshop(workshopId: string): Promise<Activity[]> {
  return db.activities.where('workshop_id').equals(workshopId).sortBy('sort_order')
}
