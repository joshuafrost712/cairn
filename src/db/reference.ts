import { db, activityKsaPk } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { pushReferenceOutbox } from './referenceWrite'
import { cacheSettingRows, mirrorActiveWorkshop } from './settings'
import { cacheScalePoints, mirrorActiveScale, seedDefaultScale } from './scale'
import { pullTemplates } from './templates'
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
import { instructorReviewPk } from '../lib/instructors'
import type { Activity, ActivityKsa, Goal, InstructorReviewPair, Ksa } from '../lib/types'

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
 * Whether the destructive reference pull must be skipped.
 *
 * The guard exists to protect UNSYNCED LOCAL AUTHORING: the pull clears eight
 * tables and rewrites them from the server, so running it while a Scenario Builder
 * or roster edit is still queued would discard that edit. Pending > 0 therefore
 * means "keep the cache".
 *
 * The bootstrap override is the 2026-08-20 fix. An empty cache holds no authoring
 * to protect, so skipping buys nothing and costs everything: `syncNow()` pulls per
 * workshop from `db.workshops`, so a device with zero workshops runs every loop
 * body zero times and can never refill itself. One stuck entry then means no
 * workshops, no roster, no activities and no questions on that device, for good,
 * with only a console warning to say so. types.ts already predicted this shape
 * (see ReferenceOutboxEntry.attempts); this is the same failure reached through
 * the front door rather than through a foreign-key violation.
 *
 * Pure so the decision is testable without a database, matching how the rest of
 * this codebase separates arithmetic from IO.
 */
export function shouldSkipReferencePull(input: {
  /** Entries still worth retrying (set-aside ones are already excluded upstream). */
  pending: number
  /** Workshops currently in the local cache. */
  cachedWorkshops: number
}): boolean {
  if (input.pending <= 0) return false
  return input.cachedWorkshops > 0
}

/**
 * Set when the pull was skipped to protect queued authoring, so the UI can say so
 * rather than presenting a stale cache as current. Zero means "not stalled".
 */
let referenceStalled = 0
const stalledListeners = new Set<(pending: number) => void>()

export function getReferenceStalled(): number {
  return referenceStalled
}

export function subscribeReferenceStalled(fn: (pending: number) => void): () => void {
  stalledListeners.add(fn)
  return () => {
    stalledListeners.delete(fn)
  }
}

function setReferenceStalled(pending: number): void {
  referenceStalled = pending
  for (const fn of stalledListeners) fn(pending)
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
    if (shouldSkipReferencePull({ pending, cachedWorkshops: await db.workshops.count() })) {
      console.warn('[honest-eval] reference outbox has unsynced entries; keeping local cache')
      // Raised to the UI, not just the console. A device in this state serves a
      // cache that quietly stops tracking the server, and the only previous signal
      // was a warning nobody reads.
      setReferenceStalled(pending)
      return
    }
    if (pending > 0) {
      console.warn(
        `[honest-eval] reference outbox has ${pending} unsynced entr${pending === 1 ? 'y' : 'ies'}, ` +
          'but the local cache is empty; pulling anyway so this device can recover',
      )
    }
    setReferenceStalled(0)
    try {
      const [w, t, p, a, g, k, ak, st, ra, sp, ac, ir] = await Promise.all([
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
        // tl-30. Member-readable, but narrowly: the policy returns only the pairs
        // that name you, name you as the subject, or belong to a workshop you
        // administer. So an evaluator with no pairs legitimately gets an empty
        // array, which is the same silent filtering every other read here relies
        // on rather than an error.
        supabase.from('instructor_reviewer').select('*'),
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
      const firstError = [w, t, p, a, g, k, ak, st, ra, sp, ir].find((r) => r.error)?.error
      if (firstError) throw firstError
      if (ac.error) {
        console.warn('[honest-eval] could not read ai_config; using its defaults', ac.error.message)
      }

      await db.transaction(
        'rw',
        [
          db.workshops,
          db.teams,
          db.participants,
          db.activities,
          db.goals,
          db.ksas,
          db.activityKsas,
          db.instructorReviewPairs,
        ],
        async () => {
          await Promise.all([
            db.workshops.clear(),
            db.teams.clear(),
            db.participants.clear(),
            db.activities.clear(),
            db.goals.clear(),
            db.ksas.clear(),
            db.activityKsas.clear(),
            // tl-30. Cleared and rewritten with the rest of the reference data
            // rather than pruned like settings, because a REVOKED pair must
            // disappear from this device. An additive merge would leave somebody
            // able to open a review Joshua had just taken away from them, and the
            // insert would then be refused server-side after they had dictated
            // into it — the worst of both behaviours.
            db.instructorReviewPairs.clear(),
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
          await db.instructorReviewPairs.bulkPut(
            (ir.data ?? []).map((row: Omit<InstructorReviewPair, 'pk'>) => ({
              ...row,
              pk: instructorReviewPk(row.workshop_id, row.reviewer_email, row.instructor_participant_id),
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
      // tl-16's authored templates pull HERE but not in the transaction above, for
      // the same reason profiles do not: that block clears its tables first, which is
      // right for reference data the backend owns and wrong for rows holding human
      // edits. `pullTemplates` is additive and prunes only within `inScope`; it
      // swallows its own failure, so a device with no network keeps its cached
      // library and generates the workshop's own wording from it.
      await pullTemplates(inScope)
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
      // Moves the threshold, the scale AND (tl-16) the authored templates. All three
      // travel in one function rather than three call sites, which is what the header of
      // db/settings.ts asks for and what tl-16's first draft got wrong.
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

// `loadResolvedKsas()` lived here until tl-29: every cached question with its goal
// title resolved, ACROSS EVERY WORKSHOP, described as the non-React twin of the
// equally unscoped `useResolvedKsas()`. Its last caller (db/drafts.ts) moved to
// `ksasForWorkshop` when tl-17 gave the generators a named workshop, so it was a
// deployment-wide read that nothing called, sitting one import away from any page
// that wanted questions. Use `ksasForWorkshop(workshopId)` below, or the
// `useWorkshopEvidence()` hook, both of which have to be told which workshop.

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
