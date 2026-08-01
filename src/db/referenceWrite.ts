import { db, activityKsaPk, newId } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type {
  Activity,
  Goal,
  Ksa,
  Participant,
  ReferenceOutboxEntry,
  ReferenceTable,
  Team,
  Workshop,
} from '../lib/types'

/**
 * Reference write-up path for the Scenario Builder.
 *
 * The app's reference data (workshops, activities, KSAs, the activity↔KSA wiring,
 * and the roster) historically flowed one way only: db/reference.ts READ it from
 * Supabase and never wrote back, and loadReferenceData() clears+overwrites the
 * local cache on every load. So in-app authoring used to be device-local and got
 * clobbered the moment Supabase was configured.
 *
 * This module closes that gap. Every mutator writes the Dexie cache immediately
 * (offline-first, exactly like db/admin.ts) and queues the matching backend
 * upsert/delete in the `referenceOutbox`. pushReferenceOutbox() replays the queue
 * to Supabase; loadReferenceData() drains it BEFORE its destructive pull, and
 * skips the overwrite entirely while anything is still pending, so locally
 * authored edits are never lost.
 */

/**
 * Per-table facts the replay needs: how deep in the foreign-key tree the table
 * sits, and which columns form its primary key.
 *
 * `keyFields` drives BOTH halves of a round trip. An upsert passes them to
 * PostgREST as `onConflict`; a delete zips them against `rowKey.split('::')` to
 * build a `.match()`. That is why the field ORDER here must stay identical to
 * the order the matching `*Pk()` helper in ./local.ts joins them in. Composite
 * keys used to be one special case for `activity_ksa` written out twice; Wave 2
 * added two more tables with composite keys, and a third and fourth copy of a
 * special case is how the two halves drift apart.
 *
 * `order` sorts upserts parents-first and deletes children-first, so foreign
 * keys hold at every point in the replay.
 */
const TABLE_SPEC: Record<ReferenceTable, { order: number; keyFields: string[] }> = {
  workshop: { order: 0, keyFields: ['id'] },
  team: { order: 1, keyFields: ['id'] },
  participant: { order: 2, keyFields: ['id'] },
  activity: { order: 3, keyFields: ['id'] },
  // `goal` sits above `ksa` because `ksa.goal_id` references it. Get this order
  // wrong and a replayed offline queue fails its foreign key on the first push of
  // a new goal and its questions together.
  goal: { order: 4, keyFields: ['id'] },
  ksa: { order: 5, keyFields: ['id'] },
  activity_ksa: { order: 6, keyFields: ['activity_id', 'ksa_id'] },
  workshop_setting: { order: 7, keyFields: ['workshop_id', 'key'] },
  report_assignment: {
    order: 8,
    keyFields: ['workshop_id', 'participant_id', 'evaluator_email', 'kind'],
  },
}

/** The columns forming a table's primary key, in the order `rowKey` joins them. */
export function referenceKeyFields(table: ReferenceTable): string[] {
  return TABLE_SPEC[table].keyFields
}

/**
 * Turn an outbox `rowKey` back into the column/value pairs that identify the
 * Postgres row, for a delete.
 *
 * Split out and exported so the round trip is testable without a network: this
 * is the exact function the delete branch calls, not a re-implementation of it.
 * The pairing it produces is correct only while the `*Pk()` helpers in ./local.ts
 * join their fields in the same order `TABLE_SPEC` lists them, which is what
 * test/referenceOutbox.test.ts pins.
 */
export function matchFromRowKey(table: ReferenceTable, rowKey: string): Record<string, string> {
  const fields = TABLE_SPEC[table].keyFields
  const parts = rowKey.split('::')
  return Object.fromEntries(fields.map((f, i) => [f, parts[i]]))
}

/**
 * Queue one backend write.
 *
 * Exported so the Wave 2 tables (db/settings.ts, db/assignments.ts) reach the
 * backend through this same replay rather than each growing its own push. They
 * live in their own modules because their local caches are shaped differently,
 * but there should only ever be one thing in this app that knows how to retry a
 * reference write and how to tell a refusal from a dropped connection.
 */
export async function enqueueReferenceWrite(
  entry: Omit<ReferenceOutboxEntry, 'at'>,
): Promise<void> {
  await db.referenceOutbox.put({ ...entry, at: new Date().toISOString() })
}

const enqueue = enqueueReferenceWrite

/**
 * Whether an error is the backend REFUSING the write rather than failing to
 * deliver it.
 *
 * `42501` is Postgres's insufficient_privilege, which is what both an RLS policy
 * violation and a missing table grant surface as. Matching on the message as well
 * because PostgREST does not always carry the code through, and being wrong in the
 * safe direction here means treating a permanent refusal as transient — which is
 * the failure this function exists to prevent.
 */
export function isAuthorizationRefusal(error: { code?: string; message?: string }): boolean {
  if (error.code === '42501') return true
  return /row-level security|permission denied|insufficient_privilege/i.test(error.message ?? '')
}

/**
 * How many times a failing entry is retried before it is set aside.
 *
 * Not a network-retry budget: `pushReferenceOutbox` returns early when offline,
 * so a phone with no signal burns none of these. It only counts round trips that
 * reached the server and came back failing, which after a handful is not a
 * connection problem but a request that cannot be satisfied.
 */
export const MAX_PUSH_ATTEMPTS = 5

/** Whether an entry has been set aside: refused outright, or failed too often. */
export const isSetAside = (e: ReferenceOutboxEntry): boolean =>
  e.rejected === true || (e.attempts ?? 0) >= MAX_PUSH_ATTEMPTS

/** Entries still worth retrying: queued, and not already set aside. */
async function pendingCount(): Promise<number> {
  const all = await db.referenceOutbox.toArray()
  return all.filter((e) => !isSetAside(e)).length
}

/**
 * Replay queued reference writes to Supabase. Parents are upserted before children
 * and children deleted before parents so foreign keys always hold.
 *
 * A transiently failed entry stays queued and retries on the next call. An entry
 * the backend REFUSES on authorization grounds is marked `rejected` and stops
 * counting as pending: retrying it cannot succeed, and leaving it in the pending
 * count would permanently block `loadReferenceData()` from ever refreshing this
 * device (pending > 0 is what protects unsynced authoring from the destructive
 * pull). The entry is kept rather than deleted so the local edit and the reason are
 * still inspectable.
 *
 * Returns how many pushed, how many remain worth retrying, and how many were
 * refused outright.
 *
 * SERIALIZED (tl-17), and the reason is a bug rather than tidiness. Callers fire
 * this from several places at once — `upsertWorkshop` kicks it off without
 * awaiting, the sync loop calls it, `loadReferenceData` drains before its pull.
 * Two overlapping drains both read the entry list before either deletes anything,
 * so both push the same row. The first INSERTs; the second arrives as PostgREST's
 * `INSERT … ON CONFLICT DO UPDATE`, which makes Postgres evaluate the UPDATE
 * policy's USING clause as well, and the row comes back `42501 … (USING
 * expression)`. The write SUCCEEDED and the app records it as refused, which is
 * the worst shape of wrong: a red entry in Setup's rejected-writes card for an
 * edit that is sitting in the database.
 *
 * Chained rather than deduplicated, deliberately: a caller that enqueued while a
 * drain was already running must get a drain that runs AFTER its enqueue, and
 * handing it the in-flight promise would tell it its own write had been attempted
 * when it had not.
 */
export function pushReferenceOutbox(): Promise<{
  pushed: number
  pending: number
  rejected: number
}> {
  const run = pushQueue.then(drainReferenceOutbox, drainReferenceOutbox)
  // Swallowed on the CHAIN only; `run` keeps its rejection for the caller.
  pushQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

let pushQueue: Promise<void> = Promise.resolve()

async function drainReferenceOutbox(): Promise<{
  pushed: number
  pending: number
  rejected: number
}> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return { pushed: 0, pending: await pendingCount(), rejected: 0 }
  }
  // Set-aside entries are not retried on every pass; they would just fail again.
  const entries = (await db.referenceOutbox.toArray()).filter((e) => !isSetAside(e))
  entries.sort((a, b) => {
    if (a.op !== b.op) return a.op === 'upsert' ? -1 : 1
    return a.op === 'upsert'
      ? TABLE_SPEC[a.table].order - TABLE_SPEC[b.table].order
      : TABLE_SPEC[b.table].order - TABLE_SPEC[a.table].order
  })

  let pushed = 0
  let rejected = 0
  for (const e of entries) {
    const keyFields = TABLE_SPEC[e.table].keyFields
    let error: { message: string; code?: string } | null
    if (e.op === 'upsert') {
      ;({ error } = await supabase
        .from(e.table)
        .upsert(e.payload as object, { onConflict: keyFields.join(',') }))
    } else {
      // `rowKey` is the same `::` join the Dexie primary key uses, so splitting
      // it against keyFields reconstructs the row's identity exactly.
      ;({ error } = await supabase.from(e.table).delete().match(matchFromRowKey(e.table, e.rowKey)))
    }
    if (!error) {
      await db.referenceOutbox.delete(e.id)
      pushed++
    } else if (isAuthorizationRefusal(error)) {
      // Not retryable. Keep the entry, stop counting it, and say so loudly: the
      // local edit stands on this device but will never reach the backend, and a
      // silent divergence between the two is exactly what this branch prevents.
      await db.referenceOutbox.update(e.id, { rejected: true, rejectedReason: error.message })
      rejected++
      console.warn(
        `[honest-eval] reference write REFUSED for ${e.id} (not retryable): ${error.message}`,
      )
    } else {
      // A real round trip that came back failing. Count it, and stop retrying
      // once the count says this is not a connection problem. Some permanently
      // unsatisfiable errors are NOT authorization refusals (a foreign key to a
      // row somebody else deleted is the common one), and an entry that retries
      // forever holds `pending` above zero forever, which silently stops
      // loadReferenceData() from ever refreshing this device again.
      const attempts = (e.attempts ?? 0) + 1
      await db.referenceOutbox.update(e.id, { attempts, rejectedReason: error.message })
      if (attempts >= MAX_PUSH_ATTEMPTS) {
        rejected++
        console.warn(
          `[honest-eval] reference write GIVEN UP for ${e.id} after ${attempts} attempts: ${error.message}`,
        )
      } else {
        console.warn(
          `[honest-eval] reference push failed for ${e.id} (attempt ${attempts}/${MAX_PUSH_ATTEMPTS}), will retry:`,
          error.message,
        )
      }
    }
  }
  return { pushed, pending: await pendingCount(), rejected }
}

/**
 * Queued reference writes that will never reach the backend: refused outright,
 * or failed enough times to be given up on. Kept rather than discarded, so the
 * local edit and the backend's reason are still inspectable.
 *
 * Nothing surfaces these yet; tl-07 owns the Setup surface where an
 * administrator should see "this edit was not accepted" rather than having to
 * open a console.
 */
export async function rejectedReferenceWrites(): Promise<ReferenceOutboxEntry[]> {
  return (await db.referenceOutbox.toArray()).filter(isSetAside)
}

// ---------------------------------------------------------------------------
// Workshops
// ---------------------------------------------------------------------------

export async function upsertWorkshop(w: Workshop): Promise<void> {
  await db.workshops.put(w)
  await enqueue({ id: `workshop:${w.id}`, table: 'workshop', op: 'upsert', rowKey: w.id, payload: w })
  void pushReferenceOutbox()
}

/**
 * Create a fresh, empty scenario (workshop).
 *
 * The optional meta is tl-17's addition, and it is not cosmetic: the end date is
 * what `deriveWorkshopState` reads to decide whether a workshop is `closed`, and
 * therefore whether every later setup save gets the closed-workshop warning. A
 * workshop created without dates reads as `draft` forever until somebody
 * remembers to go back and set them, so the create flow asks at the one moment
 * the answer is in front of the person typing.
 */
export async function createWorkshop(
  name: string,
  meta: Partial<Pick<Workshop, 'start_date' | 'end_date' | 'location'>> = {},
): Promise<Workshop> {
  const w: Workshop = {
    id: newId(),
    name: name.trim() || 'Untitled scenario',
    start_date: meta.start_date ?? null,
    end_date: meta.end_date ?? null,
    location: meta.location ?? null,
    languages: [],
  }
  await upsertWorkshop(w)
  return w
}

/**
 * Drain the outbox and report whether one workshop's own insert actually landed.
 *
 * The one thing a caller who has just made a workshop needs to know, and it
 * cannot be answered by "did createWorkshop resolve": that writes to Dexie and
 * kicks the outbox off without awaiting it, which is right everywhere except
 * here. The creator's `chief_admin` row is written by an AFTER INSERT trigger in
 * Postgres, so until the insert lands there is no membership — and a workshop
 * with no membership cannot become the active one, because
 * `resolveActiveWorkshopId` correctly discards a selection the memberships do not
 * support. The symptom is not an error: the workshop is created and the
 * administrator is silently returned to the one they were in.
 *
 * Asks about THIS workshop's entry rather than the outbox's total, so an
 * unrelated stale entry cannot report a perfectly good creation as queued.
 *
 * False offline, which is correct rather than a failure: the workshop is safely
 * queued and the caller should say so instead of switching into it.
 */
export async function workshopReachedBackend(id: string): Promise<boolean> {
  if (!isSupabaseConfigured) return true
  await pushReferenceOutbox()
  return (await db.referenceOutbox.get(`workshop:${id}`)) === undefined
}

/**
 * Duplicate a scenario as an editable starting template: clones the workshop, its
 * goals and questions, its events and their wiring, and the roster, all with
 * fresh ids.
 *
 * GOALS AND QUESTIONS ARE DEEP-COPIED (tl-08), and the spec is emphatic about why:
 * sharing them would undo per-workshop scoping at birth. Before tl-08 they could
 * not be copied — `ksa` was a global library keyed on a globally unique `code`, so
 * a duplicate reused the same question rows and editing the copy's question edited
 * the original's. Now the copy is independent, verified by editing it and
 * confirming the original is unchanged.
 *
 * Per-event overrides come along with the wiring, because the wording an admin
 * wrote for "Day 2 drafting" is part of what they are duplicating.
 */
export async function duplicateWorkshop(sourceId: string, newName: string): Promise<Workshop> {
  const src = await db.workshops.get(sourceId)
  if (!src) throw new Error('source scenario not found')
  const w: Workshop = { ...src, id: newId(), name: newName.trim() || `${src.name} (copy)` }
  await upsertWorkshop(w)

  const goals = await db.goals.where('workshop_id').equals(sourceId).toArray()
  const goalIdMap = new Map<string, string>()
  for (const g of goals.sort((a, b) => a.sort_order - b.sort_order)) {
    const ng: Goal = { ...g, id: newId(), workshop_id: w.id }
    goalIdMap.set(g.id, ng.id)
    await upsertGoal(ng)
  }

  const ksas = await db.ksas.where('workshop_id').equals(sourceId).toArray()
  const ksaIdMap = new Map<string, string>()
  for (const k of ksas) {
    const nk: Ksa = {
      ...k,
      id: newId(),
      workshop_id: w.id,
      goal_id: k.goal_id ? goalIdMap.get(k.goal_id) ?? null : null,
    }
    ksaIdMap.set(k.id, nk.id)
    await upsertKsa(nk)
  }

  const acts = await db.activities.where('workshop_id').equals(sourceId).sortBy('sort_order')
  for (const a of acts) {
    const newAct: Activity = { ...a, id: newId(), workshop_id: w.id }
    await upsertActivity(newAct)
    const links = await db.activityKsas.where('activity_id').equals(a.id).sortBy('sort_order')
    // A link whose question did not come along (it belonged to another workshop,
    // which tl-08's migration should have made impossible) is dropped rather than
    // pointed at the original's question, which would re-share what we just copied.
    const mapped = links
      .map((l) => ({ link: l, id: ksaIdMap.get(l.ksa_id) }))
      .filter((p): p is { link: (typeof links)[number]; id: string } => Boolean(p.id))
    if (mapped.length) {
      await setActivityKsas(newAct.id, mapped.map((p) => p.id))
      for (const p of mapped) {
        if (p.link.prompt_override != null || p.link.guiding_questions_override != null) {
          await setWiringOverride(newAct.id, p.id, {
            prompt_override: p.link.prompt_override ?? null,
            guiding_questions_override: p.link.guiding_questions_override ?? null,
          })
        }
      }
    }
  }

  const teams = await db.teams.where('workshop_id').equals(sourceId).toArray()
  const teamIdMap = new Map<string, string>()
  for (const t of teams) {
    const nt: Team = { ...t, id: newId(), workshop_id: w.id }
    teamIdMap.set(t.id, nt.id)
    await upsertTeam(nt)
  }
  const parts = await db.participants.where('workshop_id').equals(sourceId).toArray()
  for (const p of parts) {
    await upsertParticipant({
      ...p,
      id: newId(),
      workshop_id: w.id,
      team_id: p.team_id ? teamIdMap.get(p.team_id) ?? null : null,
    })
  }
  return w
}

/** Delete a workshop and everything under it (server cascades; mirror locally). */
export async function deleteWorkshop(id: string): Promise<void> {
  const [acts, ksaLinks, teams, participants, goals, ksas] = await Promise.all([
    db.activities.where('workshop_id').equals(id).toArray(),
    db.activityKsas.toArray(),
    db.teams.where('workshop_id').equals(id).toArray(),
    db.participants.where('workshop_id').equals(id).toArray(),
    db.goals.where('workshop_id').equals(id).toArray(),
    db.ksas.where('workshop_id').equals(id).toArray(),
  ])
  const actIds = new Set(acts.map((a) => a.id))
  const ksaIds = new Set(ksas.map((k) => k.id))
  // Wiring dies with either end: the event, or (new in tl-08) the question, which
  // now belongs to this workshop rather than to a shared library.
  const links = ksaLinks.filter((l) => actIds.has(l.activity_id) || ksaIds.has(l.ksa_id))
  await db.transaction(
    'rw',
    [db.workshops, db.activities, db.activityKsas, db.teams, db.participants, db.goals, db.ksas],
    async () => {
      await db.activityKsas.bulkDelete(links.map((l) => l.pk))
      await db.activities.bulkDelete([...actIds])
      await db.teams.bulkDelete(teams.map((t) => t.id))
      await db.participants.bulkDelete(participants.map((p) => p.id))
      await db.ksas.bulkDelete([...ksaIds])
      await db.goals.bulkDelete(goals.map((g) => g.id))
      await db.workshops.delete(id)
    },
  )
  // Only the workshop delete needs queueing; Postgres FKs cascade to the rest.
  await enqueue({ id: `workshop:${id}`, table: 'workshop', op: 'delete', rowKey: id, payload: null })
  void pushReferenceOutbox()
}

// ---------------------------------------------------------------------------
// Activities (events)
// ---------------------------------------------------------------------------

export async function upsertActivity(a: Activity): Promise<void> {
  await db.activities.put(a)
  await enqueue({ id: `activity:${a.id}`, table: 'activity', op: 'upsert', rowKey: a.id, payload: a })
  void pushReferenceOutbox()
}

export async function deleteActivity(id: string): Promise<void> {
  const links = await db.activityKsas.where('activity_id').equals(id).toArray()
  await db.transaction('rw', [db.activities, db.activityKsas], async () => {
    await db.activityKsas.bulkDelete(links.map((l) => l.pk))
    await db.activities.delete(id)
  })
  // Drop any queued wiring upserts for this activity so a delete doesn't race a re-add.
  await Promise.all(links.map((l) => db.referenceOutbox.delete(`activity_ksa:${l.pk}`)))
  await enqueue({ id: `activity:${id}`, table: 'activity', op: 'delete', rowKey: id, payload: null })
  void pushReferenceOutbox()
}

// ---------------------------------------------------------------------------
// Goals (tl-08) — the level above a question
// ---------------------------------------------------------------------------

export async function upsertGoal(g: Goal): Promise<void> {
  await db.goals.put(g)
  await enqueue({ id: `goal:${g.id}`, table: 'goal', op: 'upsert', rowKey: g.id, payload: g })
  void pushReferenceOutbox()
}

/**
 * Delete a goal. Its questions are NOT deleted: `ksa.goal_id` is
 * `on delete set null` server-side, and the local mirror does the same, so the
 * questions become ungrouped and visible rather than disappearing with the
 * heading they happened to sit under.
 *
 * That asymmetry is deliberate. Deleting a heading is a reorganization; deleting
 * the questions under it destroys evidence. The change dialog says which one is
 * about to happen, with the count.
 */
export async function deleteGoalRow(id: string): Promise<void> {
  const orphaned = await db.ksas.where('goal_id').equals(id).toArray()
  await db.transaction('rw', [db.goals, db.ksas], async () => {
    await db.ksas.bulkPut(orphaned.map((k) => ({ ...k, goal_id: null })))
    await db.goals.delete(id)
  })
  for (const k of orphaned) {
    await enqueue({
      id: `ksa:${k.id}`,
      table: 'ksa',
      op: 'upsert',
      rowKey: k.id,
      payload: toKsaRow({ ...k, goal_id: null }),
    })
  }
  await enqueue({ id: `goal:${id}`, table: 'goal', op: 'delete', rowKey: id, payload: null })
  void pushReferenceOutbox()
}

/** Set the exact order of a workshop's goals. */
export async function reorderGoals(goals: Goal[]): Promise<void> {
  const renumbered = goals.map((g, i) => ({ ...g, sort_order: i }))
  await db.goals.bulkPut(renumbered)
  for (const g of renumbered) {
    await enqueue({ id: `goal:${g.id}`, table: 'goal', op: 'upsert', rowKey: g.id, payload: g })
  }
  void pushReferenceOutbox()
}

// ---------------------------------------------------------------------------
// KSAs (questions)
// ---------------------------------------------------------------------------

/**
 * Every column of `ksa`, and nothing else.
 *
 * An ALLOW-LIST rather than a deny-list, and that choice is load-bearing. tl-08's
 * editors work on a RESOLVED question (`ResolvedKsa`, which carries `goal_title`
 * and `goal_sort` computed from the goal), so the object handed to `upsertKsa` now
 * has fields that are not columns. PostgREST refuses the whole write with "could
 * not find the 'goal_sort' column", which is a refusal the outbox retries five
 * times and then sets aside — an edit that looks saved on the device and never
 * reaches anybody. It was found by the browser harness, not by a type, because
 * `ResolvedKsa extends Ksa` and so satisfies every signature here.
 *
 * A deny-list would have fixed that one field and left the next computed field to
 * reintroduce it. This way a field is sent only if somebody added it here, which is
 * also where they would notice it needs a migration.
 *
 * `area` is deliberately absent: the legacy column survives one release cycle so a
 * pre-tl-08 client keeps working, but writing it would make it a second writable
 * copy of the group label, going stale the first time a goal was renamed.
 */
const KSA_COLUMNS = [
  'id',
  'workshop_id',
  'goal_id',
  'code',
  'short_label',
  'description',
  'evaluator_facing_prompt',
  'ai_facing_rubric',
  'evidence_levels',
  'cbc_subpoint_refs',
  'guiding_questions',
] as const

/** A question reduced to its real columns. Exported so a test can pin the shape. */
export function toKsaRow(k: Ksa): Ksa {
  const source = k as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const col of KSA_COLUMNS) {
    if (col in source) out[col] = source[col]
  }
  return out as unknown as Ksa
}

export async function upsertKsa(k: Ksa): Promise<void> {
  // The cache gets the reduced row too, so a resolved object never becomes the
  // stored one and `goal_title` cannot go stale against a renamed goal.
  const row = toKsaRow(k)
  await db.ksas.put(row)
  await enqueue({
    id: `ksa:${row.id}`,
    table: 'ksa',
    op: 'upsert',
    rowKey: row.id,
    payload: row,
  })
  void pushReferenceOutbox()
}

export async function deleteKsa(id: string): Promise<void> {
  const links = await db.activityKsas.where('ksa_id').equals(id).toArray()
  await db.transaction('rw', [db.ksas, db.activityKsas], async () => {
    await db.activityKsas.bulkDelete(links.map((l) => l.pk))
    await db.ksas.delete(id)
  })
  await Promise.all(links.map((l) => db.referenceOutbox.delete(`activity_ksa:${l.pk}`)))
  await enqueue({ id: `ksa:${id}`, table: 'ksa', op: 'delete', rowKey: id, payload: null })
  void pushReferenceOutbox()
}

// ---------------------------------------------------------------------------
// Wiring (which questions appear on which event, and in what order)
// ---------------------------------------------------------------------------

/**
 * Set the exact ordered list of KSAs wired to an activity. Diffs against current.
 *
 * PRESERVES PER-EVENT OVERRIDES (tl-08). This function rebuilt each wiring row
 * from scratch, which was correct while a row was only (activity, ksa, order) and
 * became a silent data loss the moment it carried wording: moving a question up
 * one place would have erased the prompt an administrator wrote for that event.
 * Overrides are re-attached from the existing row by ksa id.
 */
export async function setActivityKsas(activityId: string, ksaIds: string[]): Promise<void> {
  const existing = await db.activityKsas.where('activity_id').equals(activityId).toArray()
  const desiredSet = new Set(ksaIds)
  const toDelete = existing.filter((l) => !desiredSet.has(l.ksa_id))
  const priorByKsa = new Map(existing.map((l) => [l.ksa_id, l]))

  const rowFor = (ksa_id: string, i: number) => {
    const prior = priorByKsa.get(ksa_id)
    return {
      activity_id: activityId,
      ksa_id,
      sort_order: i,
      prompt_override: prior?.prompt_override ?? null,
      guiding_questions_override: prior?.guiding_questions_override ?? null,
    }
  }

  await db.transaction('rw', [db.activityKsas], async () => {
    await db.activityKsas.bulkDelete(toDelete.map((l) => l.pk))
    await db.activityKsas.bulkPut(
      ksaIds.map((ksa_id, i) => ({ ...rowFor(ksa_id, i), pk: activityKsaPk(activityId, ksa_id) })),
    )
  })

  for (const l of toDelete) {
    await enqueue({
      id: `activity_ksa:${l.pk}`,
      table: 'activity_ksa',
      op: 'delete',
      rowKey: l.pk,
      payload: null,
    })
  }
  for (let i = 0; i < ksaIds.length; i++) {
    const pk = activityKsaPk(activityId, ksaIds[i])
    await enqueue({
      id: `activity_ksa:${pk}`,
      table: 'activity_ksa',
      op: 'upsert',
      rowKey: pk,
      payload: rowFor(ksaIds[i], i),
    })
  }
  void pushReferenceOutbox()
}

/**
 * Set (or clear) one event's wording for one question.
 *
 * Null clears, and clearing must leave no residue: the next resolution falls back
 * to the question's own prompt, which is the spec's acceptance criterion. That is
 * why an empty string is normalized to null by the caller (lib/goals.ts) rather
 * than stored — a stored empty prompt renders as a question with nothing asked.
 */
export async function setWiringOverride(
  activityId: string,
  ksaId: string,
  override: { prompt_override?: string | null; guiding_questions_override?: string[] | null },
): Promise<void> {
  const pk = activityKsaPk(activityId, ksaId)
  const existing = await db.activityKsas.get(pk)
  if (!existing) throw new Error('this question is not wired to that event')
  const row = { ...existing, ...override }
  await db.activityKsas.put(row)
  const payload: Record<string, unknown> = { ...row }
  // `pk` is the flattened Dexie key, not a Postgres column.
  delete payload.pk
  await enqueue({
    id: `activity_ksa:${pk}`,
    table: 'activity_ksa',
    op: 'upsert',
    rowKey: pk,
    payload,
  })
  void pushReferenceOutbox()
}

// ---------------------------------------------------------------------------
// Roster (teams + participants) — same offline-first + queue pattern, so roster
// edits made in Admin also survive the reference pull instead of being clobbered.
// ---------------------------------------------------------------------------

export async function upsertTeam(t: Team): Promise<void> {
  await db.teams.put(t)
  await enqueue({ id: `team:${t.id}`, table: 'team', op: 'upsert', rowKey: t.id, payload: t })
  void pushReferenceOutbox()
}

export async function deleteTeamRow(id: string): Promise<void> {
  await db.teams.delete(id)
  await enqueue({ id: `team:${id}`, table: 'team', op: 'delete', rowKey: id, payload: null })
  void pushReferenceOutbox()
}

export async function upsertParticipant(p: Participant): Promise<void> {
  await db.participants.put(p)
  await enqueue({
    id: `participant:${p.id}`,
    table: 'participant',
    op: 'upsert',
    rowKey: p.id,
    payload: p,
  })
  void pushReferenceOutbox()
}

export async function deleteParticipantRow(id: string): Promise<void> {
  await db.participants.delete(id)
  await enqueue({
    id: `participant:${id}`,
    table: 'participant',
    op: 'delete',
    rowKey: id,
    payload: null,
  })
  void pushReferenceOutbox()
}

export { newId }
