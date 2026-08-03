import { db, activityKsaPk } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { pushReferenceOutbox } from './referenceWrite'
import { cacheSettingRows, mirrorActiveWorkshop } from './settings'
import { cacheScalePoints, mirrorActiveScale, seedDefaultScale } from './scale'
import { cacheAssignmentRows } from './assignments'
import { cacheAiConfigRows, refreshPlatformSettings } from './aiConfig'
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
      const [w, t, p, a, g, k, ak, st, ra, sp, ac] = await Promise.all([
        supabase.from('workshop').select('*'),
        supabase.from('team').select('*'),
        supabase.from('participant').select('*'),
        supabase.from('activity').select('*'),
        supabase.from('goal').select('*'),
        supabase.from('ksa').select('*'),
        supabase.from('activity_ksa').select('*'),
        supabase.from('workshop_setting').select('*'),
        supabase.from('report_assignment').select('*'),
        supabase.from('scale_point').select('*'),
        // tl-13. Admin-only by policy, so an evaluator's device gets an empty array
        // rather than an error — the same silent filtering every other read here
        // relies on, and the reason `cacheAiConfigRows` prunes from the authorized
        // workshop set rather than from what came back.
        supabase.from('ai_config').select('*'),
      ])
      // `ac` is deliberately NOT in this list, and it is the only read here that is
      // not. Every other table is member-readable, so an error from one means
      // something is genuinely wrong and falling back to the cache is right.
      // `ai_config` is admin-only, which is a new shape in this list: it is the one
      // read most likely to come back as an ERROR rather than as silent filtering if
      // a policy is ever misconfigured or a device meets a backend without this
      // migration — and letting that stop the whole refresh would mean an
      // administrator's questions, roster and scale quietly stopped updating because
      // of a table that has a legal empty state. No config resolves to the app's
      // pre-tl-13 behaviour, so absence is a correct answer and an error is treated
      // as absence, loudly in the console.
      const firstError = [w, t, p, a, g, k, ak, st, ra, sp].find((r) => r.error)?.error
      if (firstError) throw firstError
      if (ac.error) {
        console.warn('[honest-eval] could not read ai_config; using its defaults', ac.error.message)
      }

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
      await cacheScalePoints(sp.data ?? [], inScope)
      // Only prune on a successful read. Passing `inScope` after a failed one would
      // delete this device's cached configuration on the strength of a response that
      // never arrived, which is the exact mistake `inScope` exists to prevent.
      if (!ac.error) await cacheAiConfigRows(ac.data ?? [], inScope)
      // The deployment switch that decides whether hosted AI is even offerable.
      // Awaited rather than fired so that a caller who has finished loading really
      // has: the Setup AI section renders a mode picker off the mirrored value, and
      // a picker that flips a second later reads as a bug.
      await refreshPlatformSettings()
      // Re-point the synchronous verification threshold at what just arrived.
      // It happens HERE rather than in a separate effect so there is no window
      // in which fresh settings sit in Dexie while the gate still runs on the
      // previous value. See the header of db/settings.ts for why the mirror
      // exists at all.
      // Moves the threshold AND (tl-09) the scale; see that function's header for
      // why both mirrors travel together rather than one call site each.
      await mirrorActiveWorkshop(getActiveWorkshopId())
      // People and profiles (tl-12) refresh here so there is one load path, but
      // NOT inside the transaction above and not with a clear: that block wipes
      // its tables first, which is right for reference data the backend owns and
      // wrong for a table whose rows RLS filters. A profile set to `private` comes
      // back absent rather than forbidden, and a clearing pull would delete this
      // device's copy of every profile it merely could not read today. Awaited
      // rather than fired, so a caller that has finished loading really has.
      const { refreshPeople } = await import('./people')
      await refreshPeople()
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
  // The seed carries no scale of its own: local-only mode is the app's original
  // 0-3, which is what defaultScalePoints() is. Seeded as rows rather than left
  // to buildScale()'s fallback so the Setup editor has something to edit.
  for (const w of seed.seedWorkshops) await seedDefaultScale(w.id)
  await mirrorActiveScale(getActiveWorkshopId())
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
