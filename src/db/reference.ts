import { db, activityKsaPk } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { pushReferenceOutbox } from './referenceWrite'
import { cacheSettingRows, mirrorActiveWorkshop } from './settings'
import { cacheAssignmentRows } from './assignments'
import { getActiveWorkshopId } from '../lib/activeWorkshop'
import * as seed from '../data/seed'
import {
  resolveForActivity,
  withGoalTitles,
  type ActivityKsaResolved,
  type ResolvedKsa,
} from '../lib/goals'
import type { Activity, ActivityKsa, Goal, Ksa } from '../lib/types'

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
      const [w, t, p, a, g, k, ak, st, ra] = await Promise.all([
        supabase.from('workshop').select('*'),
        supabase.from('team').select('*'),
        supabase.from('participant').select('*'),
        supabase.from('activity').select('*'),
        supabase.from('goal').select('*'),
        supabase.from('ksa').select('*'),
        supabase.from('activity_ksa').select('*'),
        supabase.from('workshop_setting').select('*'),
        supabase.from('report_assignment').select('*'),
      ])
      const firstError = [w, t, p, a, g, k, ak, st, ra].find((r) => r.error)?.error
      if (firstError) throw firstError

      await db.transaction(
        'rw',
        [db.workshops, db.teams, db.participants, db.activities, db.goals, db.ksas, db.activityKsas],
        async () => {
          await Promise.all([
            db.workshops.clear(),
            db.teams.clear(),
            db.participants.clear(),
            db.activities.clear(),
            db.goals.clear(),
            db.ksas.clear(),
            db.activityKsas.clear(),
          ])
          await db.workshops.bulkPut(w.data ?? [])
          await db.teams.bulkPut(t.data ?? [])
          await db.participants.bulkPut(p.data ?? [])
          await db.activities.bulkPut(a.data ?? [])
          // Goals before questions: `ksa.goal_id` points at them, and a reader that
          // caught the cache mid-write should never see a question whose goal is
          // not there yet. Same reason the reference outbox orders its upserts.
          await db.goals.bulkPut(g.data ?? [])
          await db.ksas.bulkPut(k.data ?? [])
          await db.activityKsas.bulkPut(
            (ak.data ?? []).map((row: ActivityKsa) => ({
              // Spread the whole row rather than the three columns it used to
              // have: tl-08 added two override columns, and a destructuring pull
              // would have dropped them without failing anything.
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
      // The workshops this pull was authorized to see. Passed through so the two
      // caches can tell "no rows because there are none" (prune) apart from "no
      // rows because RLS filtered the workshop out" (leave alone).
      const inScope = (w.data ?? []).map((row: { id: string }) => row.id)
      await cacheSettingRows(st.data ?? [], inScope)
      await cacheAssignmentRows(ra.data ?? [], inScope)
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
    [db.workshops, db.teams, db.participants, db.activities, db.goals, db.ksas, db.activityKsas],
    async () => {
      await db.workshops.bulkPut(seed.seedWorkshops)
      await db.teams.bulkPut(seed.seedTeams)
      await db.participants.bulkPut(seed.seedParticipants)
      await db.activities.bulkPut(seed.seedActivities)
      await db.goals.bulkPut(seed.seedGoals)
      await db.ksas.bulkPut(seed.seedKsas)
      await db.activityKsas.bulkPut(
        seed.seedActivityKsas.map((r) => ({ ...r, pk: activityKsaPk(r.activity_id, r.ksa_id) })),
      )
    },
  )
}

/**
 * Every cached question with its goal title resolved.
 *
 * The non-React twin of `useResolvedKsas()`, for the document generators in
 * db/drafts.ts. Same scope decision, same reason: see that hook's header.
 */
export async function loadResolvedKsas(): Promise<ResolvedKsa[]> {
  const [ksas, goals] = await Promise.all([db.ksas.toArray(), db.goals.toArray()])
  return withGoalTitles(ksas, goals)
}

/** A workshop's goals, in the order the administrator arranged them. */
export async function goalsForWorkshop(workshopId: string): Promise<Goal[]> {
  const goals = await db.goals.where('workshop_id').equals(workshopId).toArray()
  return goals.sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
}

/**
 * A workshop's questions with their goal titles resolved.
 *
 * The scoped read tl-08 exists for: before it, every consumer took the whole
 * `ksas` table, which was the same thing in a one-workshop deployment and wrong
 * the moment there were two. Anything that groups, sorts or prints a question's
 * area reads `goal_title` from here.
 */
export async function ksasForWorkshop(workshopId: string): Promise<ResolvedKsa[]> {
  const [ksas, goals] = await Promise.all([
    db.ksas.where('workshop_id').equals(workshopId).toArray(),
    goalsForWorkshop(workshopId),
  ])
  return withGoalTitles(
    ksas.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    goals,
  )
}

/**
 * Questions wired to an activity, in display order, fully resolved.
 *
 * THE ONE RESOLUTION SITE, and the reason the spec insists on that. Three surfaces
 * show an evaluator "the question for this event": the capture screen, the Setup
 * preview, and the capture file pushed to routing. If each applied the per-event
 * override itself, they would drift, and the drift would be invisible — an
 * evaluator answering one wording while their answer is read against another.
 *
 * Returns the resolved prompt in `evaluator_facing_prompt`, so no caller needs to
 * know an override exists, plus `overridden` for the one surface that does.
 */
export async function ksasForActivity(activityId: string): Promise<ActivityKsaResolved[]> {
  const links = await db.activityKsas.where('activity_id').equals(activityId).sortBy('sort_order')
  const rows = await db.ksas.bulkGet(links.map((l) => l.ksa_id))
  const present = links
    .map((link, i) => ({ link, ksa: rows[i] }))
    .filter((pair): pair is { link: (typeof links)[number]; ksa: Ksa } => Boolean(pair.ksa))
  // Goals come from the questions' own workshops rather than the active one: a
  // wiring row can outlive a workshop switch, and a question should carry its own
  // workshop's group heading wherever it is rendered.
  const workshopIds = [...new Set(present.map((p) => p.ksa.workshop_id).filter(Boolean))]
  const goals = (
    await Promise.all(workshopIds.map((id) => goalsForWorkshop(id)))
  ).flat()
  const resolvedKsas = withGoalTitles(
    present.map((p) => p.ksa),
    goals,
  )
  return present.map((p, i) => resolveForActivity(resolvedKsas[i], p.link))
}

/** Activities for a workshop, ordered. */
export async function activitiesForWorkshop(workshopId: string): Promise<Activity[]> {
  return db.activities.where('workshop_id').equals(workshopId).sortBy('sort_order')
}
