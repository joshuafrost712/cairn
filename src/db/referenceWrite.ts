import { db, activityKsaPk, newId } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type {
  Activity,
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
  ksa: { order: 4, keyFields: ['id'] },
  activity_ksa: { order: 5, keyFields: ['activity_id', 'ksa_id'] },
  workshop_setting: { order: 6, keyFields: ['workshop_id', 'key'] },
  report_assignment: {
    order: 7,
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
 */
export async function pushReferenceOutbox(): Promise<{
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

/** Create a fresh, empty scenario (workshop). */
export async function createWorkshop(name: string): Promise<Workshop> {
  const w: Workshop = {
    id: newId(),
    name: name.trim() || 'Untitled scenario',
    start_date: null,
    end_date: null,
    location: null,
    languages: [],
  }
  await upsertWorkshop(w)
  return w
}

/**
 * Duplicate a scenario as an editable starting template: clones the workshop, its
 * events (fresh activity ids) and their wiring, and the roster (fresh team +
 * participant ids). KSAs are a shared global library (the `ksa` table has no
 * workshop_id and `code` is globally unique), so wiring reuses the same KSA ids
 * rather than cloning questions — edit a question and note it changes everywhere
 * it is used.
 */
export async function duplicateWorkshop(sourceId: string, newName: string): Promise<Workshop> {
  const src = await db.workshops.get(sourceId)
  if (!src) throw new Error('source scenario not found')
  const w: Workshop = { ...src, id: newId(), name: newName.trim() || `${src.name} (copy)` }
  await upsertWorkshop(w)

  const acts = await db.activities.where('workshop_id').equals(sourceId).sortBy('sort_order')
  for (const a of acts) {
    const newAct: Activity = { ...a, id: newId(), workshop_id: w.id }
    await upsertActivity(newAct)
    const links = await db.activityKsas.where('activity_id').equals(a.id).sortBy('sort_order')
    if (links.length) await setActivityKsas(newAct.id, links.map((l) => l.ksa_id))
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
  const [acts, ksaLinks, teams, participants] = await Promise.all([
    db.activities.where('workshop_id').equals(id).toArray(),
    db.activityKsas.toArray(),
    db.teams.where('workshop_id').equals(id).toArray(),
    db.participants.where('workshop_id').equals(id).toArray(),
  ])
  const actIds = new Set(acts.map((a) => a.id))
  const links = ksaLinks.filter((l) => actIds.has(l.activity_id))
  await db.transaction(
    'rw',
    [db.workshops, db.activities, db.activityKsas, db.teams, db.participants],
    async () => {
      await db.activityKsas.bulkDelete(links.map((l) => l.pk))
      await db.activities.bulkDelete([...actIds])
      await db.teams.bulkDelete(teams.map((t) => t.id))
      await db.participants.bulkDelete(participants.map((p) => p.id))
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
// KSAs (questions)
// ---------------------------------------------------------------------------

export async function upsertKsa(k: Ksa): Promise<void> {
  await db.ksas.put(k)
  await enqueue({ id: `ksa:${k.id}`, table: 'ksa', op: 'upsert', rowKey: k.id, payload: k })
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

/** Set the exact ordered list of KSAs wired to an activity. Diffs against current. */
export async function setActivityKsas(activityId: string, ksaIds: string[]): Promise<void> {
  const existing = await db.activityKsas.where('activity_id').equals(activityId).toArray()
  const desiredSet = new Set(ksaIds)
  const toDelete = existing.filter((l) => !desiredSet.has(l.ksa_id))

  await db.transaction('rw', [db.activityKsas], async () => {
    await db.activityKsas.bulkDelete(toDelete.map((l) => l.pk))
    await db.activityKsas.bulkPut(
      ksaIds.map((ksa_id, i) => ({
        activity_id: activityId,
        ksa_id,
        sort_order: i,
        pk: activityKsaPk(activityId, ksa_id),
      })),
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
      payload: { activity_id: activityId, ksa_id: ksaIds[i], sort_order: i },
    })
  }
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
