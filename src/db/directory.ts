import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { memberPk } from '../auth/membership'
import type { EvaluationRecord, ObservationRecord, WorkshopPerson, WorkshopRole } from '../lib/types'

/**
 * Who else is in this workshop.
 *
 * The opposite question to db/membership.ts, which caches only the CALLER's own
 * rows and says so in its docstring. Assignment needs the roster, and needs it
 * to include evaluators who have not captured anything yet, so it cannot be
 * derived from observations the way the analytics pages derive their evaluator
 * list.
 *
 * Kept in its own Dexie table rather than widening `workshopMembers`, because
 * `refreshMemberships` prunes stale rows filtered by `app_user_id`: other
 * people's rows placed there would be written once and never cleaned up again.
 *
 * No new policy work was needed. `workshop_member_select` already permits the
 * roster of a workshop you belong to, and `app_user_select` permits people you
 * share a workshop with, both from tl-01's migration. Like every other client
 * cache here, this decides what to render and never what is allowed.
 *
 * ## The write gap, which this module cannot close
 *
 * `workshop_member` has no client write path at all: tl-01 revoked the grants
 * rather than merely omitting a policy, so a browser cannot add anyone to a
 * workshop. This module reads a roster; it cannot grow one. Until tl-02/tl-11
 * ship the security-definer RPCs, people are added by an operator running SQL,
 * and the assignment UI says so rather than offering a button that would fail.
 */

/** Bound on the directory fetch. A stall must degrade to the cache. */
const DIRECTORY_TIMEOUT_MS = 8_000

const isWorkshopRole = (r: string): r is WorkshopRole =>
  ['chief_admin', 'admin', 'chief_evaluator', 'consultant', 'evaluator', 'participant'].includes(r)

/** Roles whose holders can be given work. A participant is in the room, not on the rota. */
export const ASSIGNABLE_ROLES: WorkshopRole[] = [
  'chief_admin',
  'admin',
  'chief_evaluator',
  'consultant',
  'evaluator',
]

/** Everyone cached for a workshop, name-sorted. */
export async function cachedDirectory(workshopId: string | null): Promise<WorkshopPerson[]> {
  if (!workshopId) return []
  try {
    const rows = await db.workshopPeople.where('workshop_id').equals(workshopId).toArray()
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** The people in a workshop who can hold an assignment. */
export async function assignableEvaluators(workshopId: string | null): Promise<WorkshopPerson[]> {
  return (await cachedDirectory(workshopId)).filter((p) => ASSIGNABLE_ROLES.includes(p.role))
}

/**
 * Pull the workshop's roster and replace the cached copy.
 *
 * Returns the cache on any failure rather than an empty list, for the same
 * reason `refreshMemberships` does: "the fetch failed" and "this workshop has
 * nobody in it" are different facts, and confusing them would empty an admin's
 * assignment board mid-workshop the moment their wifi dropped.
 */
export async function refreshDirectory(workshopId: string | null): Promise<WorkshopPerson[]> {
  if (!workshopId) return []
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return cachedDirectory(workshopId)
  }
  try {
    // One request. `app_user` is embedded through the foreign key rather than
    // fetched separately, so a partially-readable roster cannot produce rows
    // with a role but no name.
    const { data, error } = await supabase
      .from('workshop_member')
      .select('workshop_id, app_user_id, role, app_user:app_user_id (id, name, email)')
      .eq('workshop_id', workshopId)
      .abortSignal(AbortSignal.timeout(DIRECTORY_TIMEOUT_MS))
    if (error) {
      console.warn('[honest-eval] directory fetch failed; using cache.', error)
      return cachedDirectory(workshopId)
    }

    type Row = {
      workshop_id: string
      app_user_id: string
      role: string
      app_user: { id: string; name: string; email: string } | { id: string; name: string; email: string }[] | null
    }
    const people: WorkshopPerson[] = []
    for (const row of (data ?? []) as Row[]) {
      // PostgREST types a to-one embed as an array in some versions; normalize
      // rather than trusting one shape.
      const user = Array.isArray(row.app_user) ? row.app_user[0] : row.app_user
      // A membership whose app_user row is filtered out by RLS is dropped, not
      // rendered nameless: an unlabelled column on the assignment board would be
      // worse than a column that is honestly absent.
      if (!user?.email || !isWorkshopRole(row.role)) continue
      people.push({
        pk: memberPk(row.workshop_id, row.app_user_id),
        workshop_id: row.workshop_id,
        app_user_id: row.app_user_id,
        email: user.email.trim().toLowerCase(),
        name: user.name || user.email,
        role: row.role,
      })
    }

    await db.transaction('rw', db.workshopPeople, async () => {
      const stale = await db.workshopPeople.where('workshop_id').equals(workshopId).toArray()
      const keep = new Set(people.map((p) => p.pk))
      await db.workshopPeople.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
      await db.workshopPeople.bulkPut(people)
    })
    return people.sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    console.warn('[honest-eval] directory fetch threw; using cache.', err)
    return cachedDirectory(workshopId)
  }
}

/**
 * Local-only mode has no `workshop_member` table to read, so the directory is
 * synthesized from the evaluator emails this device has actually seen, plus the
 * signed-in user.
 *
 * Everyone synthesized is given the `evaluator` role: it is the least privilege
 * that can hold an assignment, and a demo board is more useful than an empty
 * one. Nothing here is written to the backend, and nothing here grants anything;
 * in this mode there is no backend to grant against.
 */
export async function synthesizeLocalDirectory(
  workshopId: string | null,
  self: { email: string; name: string } | null,
): Promise<WorkshopPerson[]> {
  if (!workshopId) return []
  const [evaluations, observations] = await Promise.all([
    db.evaluations.toArray() as Promise<EvaluationRecord[]>,
    db.observations.toArray() as Promise<ObservationRecord[]>,
  ])

  const emails = new Set<string>()
  for (const e of evaluations) if (e.evaluator_email) emails.add(e.evaluator_email.toLowerCase())
  for (const o of observations) if (o.evaluator_email) emails.add(o.evaluator_email.toLowerCase())
  if (self?.email) emails.add(self.email.toLowerCase())

  const people: WorkshopPerson[] = [...emails].map((email) => ({
    pk: memberPk(workshopId, `local::${email}`),
    workshop_id: workshopId,
    app_user_id: `local::${email}`,
    email,
    name: self && self.email.toLowerCase() === email ? self.name : email,
    role: 'evaluator' as WorkshopRole,
  }))

  await db.transaction('rw', db.workshopPeople, async () => {
    const stale = await db.workshopPeople.where('workshop_id').equals(workshopId).toArray()
    const keep = new Set(people.map((p) => p.pk))
    await db.workshopPeople.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
    await db.workshopPeople.bulkPut(people)
  })
  return people.sort((a, b) => a.name.localeCompare(b.name))
}
