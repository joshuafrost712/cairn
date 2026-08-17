import { db, getOutbox } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { acquireChannel } from './channelRegistry'
import type {
  EvaluationRecord,
  MentoringConversation,
  ObservationRecord,
  VerificationVerdict,
} from '../lib/types'

/** Map a local record to the Postgres `evaluation` row shape. */
function toRow(e: EvaluationRecord) {
  return {
    client_id: e.client_id,
    evaluator_email: e.evaluator_email,
    activity_id: e.activity_id,
    workshop_id: e.workshop_id,
    source_language: e.source_language,
    answers: e.answers,
    quick_ratings: e.quick_ratings ?? {},
    focus_participant_id: e.focus_participant_id ?? null,
    source_text: e.source_text,
    participant_scope: e.participant_scope,
    attestation: e.attestation,
    ruleset_version: e.ruleset_version,
    edit_history: e.edit_history,
    created_at: e.created_at,
    updated_at: e.updated_at,
    // tl-30. Same reason as observationRow: the column defaults to 'participant',
    // so an instructor capture that did not send it would arrive readable by the
    // whole workshop. It is also what `evaluation_insert` tests, so omitting it
    // would have the server check the wrong rule rather than reject the row.
    subject_kind: e.subject_kind ?? 'participant',
  }
}

let running = false

/**
 * Push every pending evaluation to the backend. Safe to call repeatedly; it
 * no-ops when offline, unconfigured, or already running. Upserts on client_id so
 * re-sending an already-synced row is harmless (idempotent).
 */
export async function pushOutbox(): Promise<{ pushed: number; failed: number }> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine || running) {
    return { pushed: 0, failed: 0 }
  }
  running = true
  let pushed = 0
  let failed = 0
  try {
    const pending = await getOutbox()
    for (const e of pending) {
      const { data, error } = await supabase
        .from('evaluation')
        .upsert(toRow(e), { onConflict: 'client_id' })
        .select('id')
        .single()
      if (error) {
        failed++
        await db.evaluations.update(e.client_id, {
          sync_status: 'error',
          sync_error: error.message,
        })
      } else {
        pushed++
        await db.evaluations.update(e.client_id, {
          sync_status: 'synced',
          server_id: data?.id,
          sync_error: null,
        })
      }
    }
  } finally {
    running = false
  }
  return { pushed, failed }
}

/** Map a local MentoringConversation to the Postgres `mentoring_conversation` row shape. */
function toMentoringRow(m: MentoringConversation) {
  return {
    id: m.id,
    participant_id: m.participant_id,
    participant_name: m.participant_name,
    workshop_id: m.workshop_id,
    trigger_observation_id: m.trigger_observation_id,
    trigger_ksa_code: m.trigger_ksa_code,
    trigger_designation: m.trigger_designation,
    trigger_activity_id: m.trigger_activity_id,
    status: m.status,
    scheduled_for: m.scheduled_for,
    summary: m.summary,
    participant_response: m.participant_response,
    recorded_by: m.recorded_by,
    assigned_to: m.assigned_to,
    assigned_by: m.assigned_by,
    assigned_at: m.assigned_at,
    admin_guidance: m.admin_guidance,
    admin_guidance_updated_at: m.admin_guidance_updated_at,
    follow_up_needed: m.follow_up_needed === true,
    follow_up_note: m.follow_up_note ?? null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
}

/**
 * The columns an assigned evaluator owns: what happened, when, and who logged it.
 *
 * Sent as a narrow `update` rather than as part of the whole-row upsert, and that
 * is the point rather than an optimization. tl-05's guard trigger refuses an
 * update from a non-admin that CHANGES `admin_guidance`, and an upsert re-sends
 * every column — so an evaluator whose device is holding a guidance string the
 * admin has since reworded would send the old one, the trigger would read that as
 * an edit, and their perfectly legitimate outcome would be refused for a field
 * they never touched. Sending only what they own means a stale copy of an
 * admin-owned column cannot cost an evaluator their write.
 *
 * tl-06 added `follow_up_needed` and `follow_up_note`, which is the first time
 * this list has grown, so the rule for growing it again is worth stating: a column
 * belongs here only if the assignee owns it, and tl-05's guard trigger must not
 * freeze it. `test/evaluatorConversations.test.ts` asserts both directions against
 * the migration SQL, because the symptom of getting it wrong is every evaluator's
 * outcome write failing in the field with the cause three files away.
 *
 * The columns are sent with `=== true` / `?? null` rather than as-is because rows
 * written before tl-06 have no such property in IndexedDB at all, and an absent
 * key is dropped by JSON.stringify — which PostgREST reads as "leave it alone"
 * rather than as false.
 */
export function mentoringOutcomePatch(m: MentoringConversation) {
  return {
    status: m.status,
    scheduled_for: m.scheduled_for,
    summary: m.summary,
    participant_response: m.participant_response,
    recorded_by: m.recorded_by,
    follow_up_needed: m.follow_up_needed === true,
    follow_up_note: m.follow_up_note ?? null,
    updated_at: m.updated_at,
  }
}

const NO_WORKSHOP_CONVERSATION =
  'No workshop on this conversation, so it cannot be shared. Reconcile from the conversations page to repair it.'

/**
 * Whether the signed-in user administers this workshop, per the cached
 * memberships.
 *
 * Not a security boundary and not treated as one: it chooses which SHAPE of write
 * to send, and the backend decides whether that write is allowed. Getting it
 * wrong costs a refusal recorded on the row, never an unauthorized write.
 */
async function administersWorkshop(workshopId: string | null): Promise<boolean> {
  if (!workshopId) return false
  const mine = await db.workshopMembers.where('workshop_id').equals(workshopId).toArray()
  return mine.some((m) => m.role === 'admin' || m.role === 'chief_admin')
}

let mentoringRunning = false

/**
 * Push this device's unsynced mentoring conversations.
 *
 * Two shapes, because two roles write to this table for different reasons. An
 * administrator owns the queue: they upsert the whole row, which is also how a
 * derived conversation first reaches the backend at all (tl-05 made insert an
 * administrator's act, since every device derives the same deterministic ids from
 * the same observations and twenty devices racing to create identical rows is not
 * a design). An assigned evaluator owns only the outcome, and sends only that.
 *
 * A row nobody on this device may write is skipped rather than sent and refused.
 * That matters more than it sounds: reconcile runs on every visit to the
 * conversations page, so an evaluator's device derives the whole workshop's
 * conversations locally, and sending them would put one guaranteed RLS refusal
 * per participant into the sync log every cycle.
 */
export async function pushMentoringOutbox(): Promise<{
  pushed: number
  failed: number
  skipped: number
}> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine || mentoringRunning) {
    return { pushed: 0, failed: 0, skipped: 0 }
  }
  mentoringRunning = true
  let pushed = 0
  let failed = 0
  let skipped = 0
  try {
    const mine = await sessionEmail()
    const pending = await db.mentoringConversations
      .where('sync_status')
      .anyOf('local', 'queued', 'error')
      .toArray()

    const adminCache = new Map<string, boolean>()
    for (const m of pending) {
      if (!m.workshop_id) {
        failed++
        await db.mentoringConversations.update(m.id, {
          sync_status: 'error',
          sync_error: NO_WORKSHOP_CONVERSATION,
        })
        continue
      }

      let isAdmin = adminCache.get(m.workshop_id)
      if (isAdmin === undefined) {
        isAdmin = await administersWorkshop(m.workshop_id)
        adminCache.set(m.workshop_id, isAdmin)
      }
      const isAssignee =
        mine !== null && m.assigned_to !== null && m.assigned_to.trim().toLowerCase() === mine

      if (!isAdmin && !isAssignee) {
        skipped++
        continue
      }

      const { error } = isAdmin
        ? await supabase.from('mentoring_conversation').upsert(toMentoringRow(m), { onConflict: 'id' })
        : await supabase
            .from('mentoring_conversation')
            .update(mentoringOutcomePatch(m))
            .eq('id', m.id)

      if (error) {
        failed++
        await db.mentoringConversations.update(m.id, {
          sync_status: 'error',
          sync_error: error.message,
        })
      } else {
        pushed++
        await db.mentoringConversations.update(m.id, {
          sync_status: 'synced',
          sync_error: null,
        })
      }
    }
  } finally {
    mentoringRunning = false
  }
  return { pushed, failed, skipped }
}

/**
 * Pull the conversations the backend will show this account, and adopt them.
 *
 * This did not exist before tl-05, and without it the whole spec is decorative:
 * an admin assigns a conversation on a laptop and the evaluator's phone, which
 * only ever pushed, would never learn about it. RLS decides what comes back — the
 * workshop's queue for an admin, exactly their own rows for everybody else — so
 * the filter is the server's, not a `.eq()` the client could be talked out of.
 *
 * Non-destructive in the same way tl-04's observation pull is: a local row that
 * has not reached the backend yet is left alone, because the copy upstream is by
 * definition older than the edit sitting in the outbox.
 */
export async function pullMentoringConversations(
  workshopId: string,
): Promise<{ pulled: number; adopted: number }> {
  if (!canReachBackend()) return { pulled: 0, adopted: 0 }
  const { data, error } = await supabase!
    .from('mentoring_conversation')
    .select('*')
    .eq('workshop_id', workshopId)
  if (error) {
    console.warn('[cairn] mentoring conversation pull failed', error)
    return { pulled: 0, adopted: 0 }
  }
  const remote = (data ?? []) as unknown as MentoringConversation[]
  if (remote.length === 0) return { pulled: 0, adopted: 0 }

  const localStatus = new Map<string, string | undefined>()
  for (const c of await db.mentoringConversations.toArray()) {
    localStatus.set(c.id, c.sync_status)
  }
  const adopt = remote
    .filter((r) => {
      const local = localStatus.get(r.id)
      return local === undefined || local === 'synced'
    })
    .map((r) => ({ ...r, sync_status: 'synced' as const, sync_error: null }))

  if (adopt.length > 0) await db.mentoringConversations.bulkPut(adopt)
  return { pulled: remote.length, adopted: adopt.length }
}

// ---------------------------------------------------------------------------
// tl-04: observations down, verdicts up.
//
// Before this, an observation lived only in the IndexedDB of the device that
// imported it and a verdict was shared by committing a JSON file to a private
// GitHub repo. Both facts had the same consequence: a capture made on a phone
// never reached the reports built on a laptop.
//
// Ordering inside a cycle is load-bearing and is stated in one place, the loop
// at the bottom of this file: push before pull (so this device's work is never
// clobbered by a stale server read), observations before verdicts (so a verdict
// arriving on a device lands next to the observation it is about).
// ---------------------------------------------------------------------------

/**
 * Which workshop an ingested observation belongs to (tl-04).
 *
 * Pure, and separated from the Dexie lookups that feed it, because getting this
 * wrong is silent: a null means the observation cannot be shared, and an
 * observation that cannot be shared is exactly the bug this spec exists to fix.
 * Three sources, most authoritative first — the originating capture, then any
 * participant the observation is about, then the workshop this device is working
 * in. The third is not a guess: somebody routing a capture is by definition
 * inside the workshop whose captures they are routing.
 */
export function pickWorkshopId(
  captureWorkshopId: string | null | undefined,
  participantWorkshopIds: Array<string | null | undefined>,
  activeWorkshopId: string | null,
): string | null {
  if (captureWorkshopId) return captureWorkshopId
  for (const id of participantWorkshopIds) {
    if (id) return id
  }
  return activeWorkshopId ?? null
}

/**
 * Server-side observations for one capture that the local store no longer has.
 *
 * Re-routing a capture can produce fewer observations than last time, because
 * Claude split a compound statement differently. The ids are positional
 * (`${capture}::${index}`), so the surplus is not overwritten by the upsert — it
 * is left behind, still counting toward the participant's evidence, and nothing
 * on any screen would say so.
 */
export function surplusObservationIds(remoteIds: string[], localIds: string[]): string[] {
  const local = new Set(localIds)
  return remoteIds.filter((id) => !local.has(id))
}

/**
 * Which of a workshop's remote verdicts this device should adopt.
 *
 * Two are held back, and both would otherwise be silent regressions. My own
 * unsynced verdict, whose local copy is newer than the server's by definition.
 * And any verdict I have withdrawn but not yet withdrawn upstream, which the pull
 * would otherwise restore looking exactly like a verdict I meant to leave.
 *
 * A colleague's unsynced local verdict is NOT held back: it can only have arrived
 * through the local-only GitHub fallback, where the server's copy is the fresher
 * of the two.
 */
export function verdictsToAdopt<T extends { id: string }>(
  remote: T[],
  myUnsyncedIds: Iterable<string>,
  withdrawnIds: Iterable<string>,
): { adopt: T[]; held: number } {
  const unsynced = new Set(myUnsyncedIds)
  const withdrawn = new Set(withdrawnIds)
  const adopt: T[] = []
  let held = 0
  for (const r of remote) {
    if (unsynced.has(r.id) || withdrawn.has(r.id)) held++
    else adopt.push(r)
  }
  return { adopt, held }
}

export function observationRow(o: ObservationRecord) {
  return {
    id: o.id,
    capture_client_id: o.capture_client_id,
    workshop_id: o.workshop_id,
    participant_id: o.participant_id,
    participant_name: o.participant_name,
    ksa_code: o.ksa_code,
    text: o.text,
    source_excerpt: o.source_excerpt,
    evidence_designation: o.evidence_designation,
    sentiment_flag: o.sentiment_flag,
    confidence: o.confidence,
    needs_review: o.needs_review,
    origin: o.origin,
    imported_at: o.imported_at,
    evaluator_email: o.evaluator_email ?? null,
    // tl-30. Sent explicitly rather than left to the column default, because the
    // default is 'participant' and an instructor observation arriving without it
    // would become readable by every evaluating member of the workshop the
    // instant it synced.
    subject_kind: o.subject_kind ?? 'participant',
  }
}

export function verdictRow(v: VerificationVerdict) {
  return {
    id: v.id,
    observation_id: v.observation_id,
    capture_client_id: v.capture_client_id,
    workshop_id: v.workshop_id,
    evaluator_email: v.evaluator_email,
    decision: v.decision,
    adjusted_designation: v.adjusted_designation ?? null,
    note: v.note ?? null,
    at: v.at,
  }
}

/** True when there is a configured, reachable backend to talk to. */
function canReachBackend(): boolean {
  return Boolean(isSupabaseConfigured && supabase && navigator.onLine)
}

/**
 * The signed-in address, lowercased, or null. Read from the session rather than
 * passed in, so a caller cannot push verdicts under somebody else's name by
 * accident. Never throws: no session and "could not tell" both mean the same
 * thing here, which is to push nothing.
 */
async function sessionEmail(): Promise<string | null> {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    const email = data.session?.user?.email
    return email ? email.trim().toLowerCase() : null
  } catch {
    return null
  }
}

const NO_WORKSHOP =
  'No workshop on this observation, so it cannot be shared. Re-import it while the workshop is active.'

let observationsRunning = false

/**
 * Push every unsynced observation. Upserts on `id`, which is
 * `${capture_client_id}::${index}` and therefore stable across re-imports, so
 * re-sending is harmless.
 *
 * Rows with no `workshop_id` are refused locally rather than sent: the backend's
 * column is NOT NULL and its read policy is written against it, so a null would
 * come back as an opaque constraint error on every single cycle. Saying why in
 * `sync_error` is what lets tl-18 count them and tell a human what to do.
 *
 * Re-routing a capture can produce FEWER observations than last time (Claude
 * split a compound statement differently), which would leave the surplus rows
 * stranded on the server, still counting toward a participant's evidence. So
 * after a capture's rows go up, the server rows for that capture that are no
 * longer local come down. Only an administrator can do this, which is exactly
 * who re-routes.
 */
export async function pushObservations(): Promise<{ pushed: number; failed: number; pruned: number }> {
  if (!canReachBackend() || observationsRunning) return { pushed: 0, failed: 0, pruned: 0 }
  const client = supabase!
  observationsRunning = true
  let pushed = 0
  let failed = 0
  let pruned = 0
  try {
    const pending = await db.observations
      .where('sync_status')
      .anyOf('local', 'queued', 'error')
      .toArray()
    const touchedCaptures = new Set<string>()
    for (const o of pending) {
      if (!o.workshop_id) {
        failed++
        await db.observations.update(o.id, { sync_status: 'error', sync_error: NO_WORKSHOP })
        continue
      }
      const { error } = await client.from('observation').upsert(observationRow(o), { onConflict: 'id' })
      if (error) {
        failed++
        await db.observations.update(o.id, { sync_status: 'error', sync_error: error.message })
      } else {
        pushed++
        touchedCaptures.add(o.capture_client_id)
        await db.observations.update(o.id, { sync_status: 'synced', sync_error: null })
      }
    }
    for (const capture of touchedCaptures) {
      const localIds = await db.observations.where('capture_client_id').equals(capture).primaryKeys()
      const { data, error } = await client
        .from('observation')
        .select('id')
        .eq('capture_client_id', capture)
      if (error || !data) continue
      const surplus = surplusObservationIds(
        data.map((r) => r.id as string),
        localIds as string[],
      )
      if (surplus.length === 0) continue
      const { error: delError } = await client.from('observation').delete().in('id', surplus)
      if (!delError) pruned += surplus.length
    }
  } finally {
    observationsRunning = false
  }
  return { pushed, failed, pruned }
}

// ---------------------------------------------------------------------------
// tl-03: the administrator pulls other people's captures down to route them.
//
// The transport for the other direction. tl-04 moved observations and verdicts;
// this moves the CAPTURE, which is what an administrator has to be holding
// before they can route anything they did not personally record. Before it, the
// routing queue was `db.evaluations` on one device, so the only captures anybody
// could route were their own — which is why the page had to be evaluator-facing,
// and why an evaluator's phone had to hold a repo token.
// ---------------------------------------------------------------------------

/** The subset of a remote `evaluation` row this device needs to route it. */
export type RemoteCaptureRow = ReturnType<typeof toRow> & { id?: string | null }

/**
 * Which pulled captures may be written over the local copy.
 *
 * A row this device has NOT finished sending is newer than the server's copy of
 * it by definition, so adopting the server version would silently discard the
 * administrator's own unsent edit. Everything else is safe: the server is
 * authoritative for a capture that has already synced, and for one this device
 * has never seen.
 *
 * Pure, because the alternative failure is invisible — the clobbered row still
 * renders, just with yesterday's text in it.
 */
export function capturesToAdopt<T extends { client_id: string }>(
  remote: T[],
  localSyncStatus: Map<string, string | undefined>,
): T[] {
  return remote.filter((r) => {
    const status = localSyncStatus.get(r.client_id)
    if (status === undefined) return true // not held locally at all
    return status === 'synced'
  })
}

/**
 * Map a pulled row into a local record.
 *
 * `sync_status` is 'synced' because it came FROM the server. `routing_status` is
 * the interesting field: it lives only in Dexie (`toRow` never sends it), so the
 * server has no opinion about it, and a `bulkPut` of the mapped row would erase
 * whatever this device knew. That erasure is the double-routing bug in miniature:
 * a capture this device routed, whose observations have not managed to push yet,
 * would come back looking pending and be routed a second time. So a local value is
 * carried forward, and only a capture with no local value is left for
 * `markRoutedFromObservations` to decide.
 */
export function captureRecordFromRow(
  r: RemoteCaptureRow,
  localRoutingStatus?: 'sent' | 'routed',
): EvaluationRecord {
  return {
    ...(localRoutingStatus ? { routing_status: localRoutingStatus } : {}),
    client_id: r.client_id,
    server_id: r.id ?? undefined,
    evaluator_email: r.evaluator_email ?? null,
    activity_id: r.activity_id ?? null,
    workshop_id: r.workshop_id ?? null,
    source_language: r.source_language,
    answers: r.answers ?? {},
    quick_ratings: r.quick_ratings ?? {},
    focus_participant_id: r.focus_participant_id ?? null,
    // tl-30. Adopted from the server rather than defaulted, so an administrator
    // pulling somebody else's capture down to route it routes it as the kind it
    // was written as.
    subject_kind: r.subject_kind ?? 'participant',
    source_text: r.source_text ?? '',
    participant_scope: r.participant_scope ?? [],
    attestation: Boolean(r.attestation),
    ruleset_version: r.ruleset_version ?? null,
    edit_history: r.edit_history ?? [],
    created_at: r.created_at,
    updated_at: r.updated_at,
    sync_status: 'synced',
    sync_error: null,
  }
}

/**
 * Pull every submitted capture for a workshop so an administrator can route the
 * ones they did not record.
 *
 * Admin-only by call site, not by policy: RLS lets any member read the workshop's
 * evaluations, but pulling them onto an evaluator's phone would fill their own
 * capture list with other people's work and buy nothing, since they have no
 * routing surface any more. Called from the routing page (mount and on demand)
 * rather than from `startSyncLoop` for exactly that reason.
 */
export async function pullPendingCaptures(
  workshopId: string,
): Promise<{ pulled: number; adopted: number; markedRouted: number }> {
  if (!canReachBackend()) return { pulled: 0, adopted: 0, markedRouted: 0 }
  const client = supabase!
  const { data, error } = await client
    .from('evaluation')
    .select('*')
    .eq('workshop_id', workshopId)
    .eq('attestation', true)
  if (error) {
    console.warn('[cairn] capture pull failed', error)
    return { pulled: 0, adopted: 0, markedRouted: 0 }
  }
  const remote = (data ?? []) as unknown as RemoteCaptureRow[]
  if (remote.length === 0) return { pulled: 0, adopted: 0, markedRouted: 0 }

  const localStatus = new Map<string, string | undefined>()
  const localRouting = new Map<string, 'sent' | 'routed' | undefined>()
  for (const e of await db.evaluations.toArray()) {
    localStatus.set(e.client_id, e.sync_status)
    localRouting.set(e.client_id, e.routing_status)
  }
  const adopt = capturesToAdopt(remote, localStatus)
  if (adopt.length > 0) {
    await db.evaluations.bulkPut(
      adopt.map((r) => captureRecordFromRow(r, localRouting.get(r.client_id))),
    )
  }

  const markedRouted = await markRoutedFromObservations(remote.map((r) => r.client_id))
  return { pulled: remote.length, adopted: adopt.length, markedRouted }
}

/**
 * Set `routing_status: 'routed'` on any capture whose observations already exist
 * on the server.
 *
 * The recovery window is why this matters rather than being a tidy-up. Joshua's
 * phone holds captures that reached Supabase months ago and were routed on the
 * desktop; without this the administrator's queue offers every one of them again,
 * and re-routing them would produce a second set of observations for evidence that
 * has already been verified. Only captures with no local routing state are
 * touched, so a locally-known 'sent' is never downgraded.
 */
export async function markRoutedFromObservations(captureIds: string[]): Promise<number> {
  if (!canReachBackend() || captureIds.length === 0) return 0
  const unknown = (
    await db.evaluations.where('client_id').anyOf(captureIds).toArray()
  ).filter((e) => !e.routing_status)
  if (unknown.length === 0) return 0
  const { data, error } = await supabase!
    .from('observation')
    .select('capture_client_id')
    .in(
      'capture_client_id',
      unknown.map((e) => e.client_id),
    )
  if (error || !data) return 0
  const routed = new Set(data.map((r) => r.capture_client_id as string))
  let marked = 0
  for (const e of unknown) {
    if (!routed.has(e.client_id)) continue
    await db.evaluations.update(e.client_id, { routing_status: 'routed' })
    marked++
  }
  return marked
}

/**
 * Pull one workshop's observations into the local store.
 *
 * Server-authoritative for rows it returns, and deliberately NOT destructive: a
 * local row absent from the pull is left alone rather than deleted, because the
 * likeliest reason for its absence is that it has not been pushed yet. An
 * unsynced local observation deleted by its own device's pull is the failure this
 * whole spec exists to remove.
 */
export async function pullObservations(workshopId: string): Promise<{ pulled: number }> {
  if (!canReachBackend()) return { pulled: 0 }
  const { data, error } = await supabase!.from('observation').select('*').eq('workshop_id', workshopId)
  if (error) {
    console.warn('[cairn] observation pull failed', error)
    return { pulled: 0 }
  }
  const rows = (data ?? []).map(
    (r: Record<string, unknown>) =>
      ({ ...r, sync_status: 'synced', sync_error: null }) as unknown as ObservationRecord,
  )
  if (rows.length > 0) await db.observations.bulkPut(rows)
  return { pulled: rows.length }
}

let verdictsRunning = false

/**
 * Push this device's unsynced verdicts, then flush withdrawals.
 *
 * Both halves are here rather than in two functions because their order matters:
 * a verdict recorded, withdrawn, and re-recorded within one offline stretch must
 * end up present, and the tombstone for the middle step is deleted by
 * `recordVerdict` precisely so this ordering stays safe.
 *
 * A push refused because RLS says the email is not yours is recorded on the row
 * and retried. It should never happen from this app, which only ever records
 * under the signed-in address; if it does, the message is the thing worth
 * reading, so it is stored rather than swallowed.
 */
export async function pushVerdicts(): Promise<{ pushed: number; failed: number; withdrawn: number }> {
  if (!canReachBackend() || verdictsRunning) return { pushed: 0, failed: 0, withdrawn: 0 }
  const client = supabase!
  verdictsRunning = true
  let pushed = 0
  let failed = 0
  let withdrawn = 0
  try {
    // Only my own. Another evaluator's verdict can reach this store through the
    // local-only GitHub fallback, and the backend would refuse it — correctly,
    // since a verdict is a signature. Filtering here keeps a refusal that is
    // nobody's mistake from being recorded as an error on their row.
    const mine = await sessionEmail()
    const pending = (
      await db.verifications.where('sync_status').anyOf('local', 'queued', 'error').toArray()
    ).filter((v) => mine !== null && v.evaluator_email.trim().toLowerCase() === mine)
    for (const v of pending) {
      if (!v.workshop_id) {
        failed++
        await db.verifications.update(v.id, {
          sync_status: 'error',
          sync_error: NO_WORKSHOP,
        })
        continue
      }
      const { error } = await client
        .from('verification_verdict')
        .upsert(verdictRow(v), { onConflict: 'id' })
      if (error) {
        failed++
        await db.verifications.update(v.id, { sync_status: 'error', sync_error: error.message })
      } else {
        pushed++
        await db.verifications.update(v.id, { sync_status: 'synced', sync_error: null })
      }
    }

    const tombstones = await db.verdictTombstones
      .where('sync_status')
      .anyOf('local', 'queued', 'error')
      .toArray()
    for (const t of tombstones) {
      const { error } = await client.from('verification_verdict').delete().eq('id', t.id)
      if (error) {
        await db.verdictTombstones.update(t.id, { sync_status: 'error', sync_error: error.message })
      } else {
        withdrawn++
        await db.verdictTombstones.delete(t.id)
      }
    }
  } finally {
    verdictsRunning = false
  }
  return { pushed, failed, withdrawn }
}

/**
 * Pull one workshop's verdicts.
 *
 * Two rows are held back. This device's own unsynced verdicts, because the
 * server's copy of a verdict you have just changed is older than yours. And any
 * verdict this device has withdrawn but not yet managed to withdraw upstream,
 * which is the second half of the tombstone contract: without the filter the pull
 * would restore it and the withdrawal would look like it never happened.
 *
 * A verdict whose observation has not arrived is stored anyway. It is not
 * displayable, and it is not the pull's job to decide that — dropping it would
 * make a partial sync permanent instead of self-healing on the next cycle.
 */
export async function pullVerdicts(workshopId: string): Promise<{ pulled: number; held: number }> {
  if (!canReachBackend()) return { pulled: 0, held: 0 }
  const { data, error } = await supabase!
    .from('verification_verdict')
    .select('*')
    .eq('workshop_id', workshopId)
  if (error) {
    console.warn('[cairn] verdict pull failed', error)
    return { pulled: 0, held: 0 }
  }
  // Only MY unsynced rows are held back. A colleague's verdict sitting locally
  // unsynced can only have arrived through the local-only GitHub fallback, where
  // the server's copy is the fresher of the two, so holding it back would pin
  // this device to a stale reading of somebody else's verdict.
  const mine = await sessionEmail()
  const unsynced = new Set(
    (await db.verifications.where('sync_status').anyOf('local', 'queued', 'error').toArray())
      .filter((v) => mine !== null && v.evaluator_email.trim().toLowerCase() === mine)
      .map((v) => v.id),
  )
  const withdrawn = await db.verdictTombstones.toCollection().primaryKeys()
  const { adopt, held } = verdictsToAdopt(
    (data ?? []) as unknown as VerificationVerdict[],
    unsynced,
    withdrawn as string[],
  )
  const rows = adopt.map((v) => ({ ...v, sync_status: 'synced' as const, sync_error: null }))
  if (rows.length > 0) await db.verifications.bulkPut(rows)
  return { pulled: rows.length, held }
}

/**
 * One full cycle for the two new tables, across every workshop this device has
 * cached (normally one). Sequential rather than parallel: the pulls are
 * server-authoritative writes into the same two Dexie tables the pushes just
 * read, and interleaving them would make which version wins a matter of timing.
 */
async function syncObservationsAndVerdicts(): Promise<void> {
  if (!canReachBackend()) return
  await pushObservations()
  await pushVerdicts()
  const workshops = await db.workshops.toArray()
  for (const w of workshops) {
    await pullObservations(w.id)
    await pullVerdicts(w.id)
  }
}

/**
 * Everything this device is holding, sent now, in the loop's own order (tl-18).
 *
 * The status bar's button used to call `pushOutbox` alone, so a device with a
 * queued verdict and no queued evaluation showed "1 to send", sent nothing, and
 * still showed "1 to send". Awaited rather than fired off, so a caller can tell
 * the user when it has actually finished.
 */
export async function syncNow(): Promise<void> {
  await pushOutbox()
  await pushMentoringOutbox()
  await syncMentoringConversations()
  await syncObservationsAndVerdicts()
}

/**
 * The conversation table's pull half (tl-05), after its push, per workshop.
 *
 * Push first for the same reason tl-04's cycle does: the pull refuses to
 * overwrite an unsynced local row, so a device with a queued outcome would
 * otherwise hold that row back from every subsequent pull and never see the
 * guidance the admin attached to it. Sending first clears the row to 'synced' and
 * lets the pull bring the whole thing up to date in the same cycle.
 */
async function syncMentoringConversations(): Promise<void> {
  if (!canReachBackend()) return
  const workshops = await db.workshops.toArray()
  for (const w of workshops) {
    await pullMentoringConversations(w.id)
  }
}

/**
 * Live observations: a newly routed observation reaches the evaluator who has to
 * verify it without waiting for the interval. Additive — the pull is still the
 * reliable path, and this subscription is dropped without ceremony if it proves
 * unreliable on mobile. Mirrors subscribeCoverage in db/coverage.ts.
 */
export function subscribeObservations(workshopId: string): () => void {
  if (!isSupabaseConfigured || !supabase) return () => {}
  const client = supabase
  // Refcounted by topic (tl-18). Same StrictMode hazard as subscribeCoverage:
  // supabase-js returns the channel it already holds for a topic, and `.on()`
  // after `.subscribe()` throws, killing live observations with no error on any
  // screen — the exact class of failure the sync-health page exists to surface.
  return acquireChannel(`observations:${workshopId}`, () => {
  const channel = client
    .channel(`observations:${workshopId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'observation', filter: `workshop_id=eq.${workshopId}` },
      (payload) => {
        const row = payload.new as Record<string, unknown> | null
        if (!row || typeof row.id !== 'string') return
        void (async () => {
          // Same non-destructive rule as the pull: never overwrite a local row
          // that has not been pushed yet. On an administrator's own device the
          // broadcast of a row it just wrote arrives while the push is still in
          // flight, and this is what keeps that from resetting its own state.
          const local = await db.observations.get(row.id as string)
          if (local && local.sync_status !== 'synced') return
          await db.observations.put({
            ...(row as unknown as ObservationRecord),
            sync_status: 'synced',
            sync_error: null,
          })
        })()
      },
    )
    .subscribe()
    return () => {
      void client.removeChannel(channel)
    }
  })
}

/**
 * Wire automatic sync: on reconnect, on a gentle interval, and live for
 * observations. Returns a cleanup fn.
 *
 * One loop for every synced table, which is the point. Five tables now reach the
 * backend from here and there is a single place to reason about their ordering;
 * a second timer would make "which cycle am I in" unanswerable.
 */
export function startSyncLoop(): () => void {
  const cycle = () => {
    void syncNow()
  }
  window.addEventListener('online', cycle)
  const interval = window.setInterval(cycle, 30_000)
  cycle()

  // Subscriptions need the workshop cache, which loads asynchronously. Started
  // after the first cycle so a cold start subscribes to whatever that cycle
  // pulled rather than to nothing.
  let channels: Array<() => void> = []
  let cancelled = false
  void (async () => {
    if (!isSupabaseConfigured || !supabase) return
    const workshops = await db.workshops.toArray()
    if (cancelled) return
    channels = workshops.map((w) => subscribeObservations(w.id))
  })()

  return () => {
    cancelled = true
    window.removeEventListener('online', cycle)
    window.clearInterval(interval)
    for (const close of channels) close()
    channels = []
  }
}
