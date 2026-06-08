import { db, activityKsaPk } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import * as seed from '../data/seed'
import type { Activity, Ksa } from '../lib/types'

/**
 * Load reference data (workshops, activities, KSAs, etc.) into the local cache.
 * - Supabase configured + online: fetch fresh and overwrite the cache.
 * - Otherwise: if the cache is empty, prime it from the local seed so the app works.
 * Capture always reads from the local cache, so it works offline after first load.
 */
export async function loadReferenceData(): Promise<void> {
  if (isSupabaseConfigured && supabase && navigator.onLine) {
    try {
      const [w, t, p, a, k, ak] = await Promise.all([
        supabase.from('workshop').select('*'),
        supabase.from('team').select('*'),
        supabase.from('participant').select('*'),
        supabase.from('activity').select('*'),
        supabase.from('ksa').select('*'),
        supabase.from('activity_ksa').select('*'),
      ])
      const firstError = [w, t, p, a, k, ak].find((r) => r.error)?.error
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
