// High-level routing operations. Ties the device store (Dexie) to the routing
// workspace shapes and the GitHub client. Two paths, same file shapes:
//
//   Automated (a GitHub token is set): pushPendingCaptures() writes inbox/<id>.json;
//     you route on the repo with Claude Max; pullObservationsFromRepo() reads outbox/<id>.json.
//   Manual (no token, fully phone-native): buildExportBundle() gives JSON you paste
//     into Claude with a pointer to ROUTING.md; importObservationsText() ingests what
//     Claude returns. No credentials, no API spend.

import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { isOnScale, validateObservation } from '../ai/contract'
import { excerptIsGrounded } from '../ai/provenance'
import { scaleForWorkshop } from '../db/scale'
import {
  buildCaptureFile,
  inboxPath,
  type CaptureFile,
  type ObservationsFile,
} from '../ai/workspace'
import { listDir, getFile, putFile } from './github'
import { getRoutingToken } from './config'
import { getActiveWorkshopId } from '../lib/activeWorkshop'
import { pickWorkshopId, pushObservations } from '../db/sync'
import type { EvaluationRecord, ObservationRecord } from '../lib/types'

export const CAPTURE_BUNDLE_SCHEMA_ID = 'cairn.capture-bundle/v1'
export const OBSERVATIONS_BUNDLE_SCHEMA_ID = 'cairn.observations-bundle/v1'

/**
 * Why one item of a returned file was not kept (tl-15).
 *
 * Chrome ids rather than sentences, because a per-item reason is a sentence somebody
 * reads on a screen and the app's copy lives in one file. `shape` carries the
 * validator's own English along with it, since "missing/invalid ksa_code" is more
 * useful to whoever has to fix the agent than a generic id.
 */
export type ImportRejection =
  | 'shape'
  | 'unknown_participant'
  | 'unknown_question'
  | 'off_scale'
  | 'unsupported_quotation'

export interface ImportItemReport {
  index: number
  participant: string | null
  ksaCode: string | null
  status: 'stored' | 'rejected'
  rejection?: ImportRejection
  /** The validator's own words, for `shape` only. */
  detail?: string
}

export type ImportFileStatus = 'imported' | 'already_routed' | 'unknown_capture' | 'malformed'

export interface ImportFileReport {
  /** The file's own name where there was one (the pack path), else the capture id. */
  name: string
  capture: string | null
  status: ImportFileStatus
  stored: number
  rejected: number
  items: ImportItemReport[]
}

export interface ImportReport {
  files: ImportFileReport[]
  stored: number
  rejected: number
  /** Items in files that were skipped whole: already routed, unknown, malformed. */
  skipped: number
  shared: number
}

/** Per-file caps on an upload, which is arbitrary text from outside the app. */
export const MAX_IMPORT_FILE_BYTES = 2_000_000
export const MAX_IMPORT_FILES = 500

/**
 * Submitted captures not yet routed back. (routing_status 'routed' = done.)
 *
 * Scoped to the active workshop since tl-03, because the queue is no longer only
 * this device's own work: `pullPendingCaptures` brings down every submitted
 * capture in the workshop, and once one deployment hosts several workshops an
 * unscoped queue would offer an administrator Bali's captures while they are
 * working the Crash Course. A capture with no workshop at all is kept rather than
 * hidden — it is real work, and dropping it from the only screen that can route it
 * is how it goes missing.
 */
export async function listPendingCaptures(): Promise<EvaluationRecord[]> {
  const all = await db.evaluations.toArray()
  const active = getActiveWorkshopId()
  return all
    .filter((e) => e.attestation && e.routing_status !== 'routed' && e.source_text.trim())
    .filter((e) => !active || !e.workshop_id || e.workshop_id === active)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * Assemble the self-contained capture file for one evaluation from the local cache.
 *
 * Exported since tl-15, which writes the same file into a pack's `input/` folder. One
 * builder for every transport is the point: a pack whose captures were assembled
 * differently from the repo's would be a second contract nobody had noticed writing.
 */
export async function captureFileFor(e: EvaluationRecord): Promise<CaptureFile> {
  const workshop = e.workshop_id ? (await db.workshops.get(e.workshop_id)) ?? null : null
  const activity = e.activity_id ? (await db.activities.get(e.activity_id)) ?? null : null
  const ksasInScope = e.activity_id ? await ksasForActivity(e.activity_id) : []
  // The CAPTURE's workshop, not the active one: routing is a queue and a queue
  // outlives a workshop switch.
  const scale = await scaleForWorkshop(e.workshop_id ?? null)
  return buildCaptureFile(
    {
      client_id: e.client_id,
      evaluator_email: e.evaluator_email,
      source_language: e.source_language,
      source_text: e.source_text,
      ruleset_version: e.ruleset_version,
      created_at: e.created_at,
    },
    {
      workshop: workshop ? { id: workshop.id, name: workshop.name } : null,
      activity: activity ? { id: activity.id, title: activity.title, day: activity.day } : null,
      ksasInScope,
      participantScope: e.participant_scope.map((p) => ({ name: p.name, participant_id: p.participant_id })),
      scale,
    },
  )
}

// ---- automated path (GitHub token set) -----------------------------------

export async function pushPendingCaptures(): Promise<{ pushed: number; skipped: number }> {
  const pending = await listPendingCaptures()
  let pushed = 0
  for (const e of pending) {
    const file = await captureFileFor(e)
    await putFile(inboxPath(e.client_id), JSON.stringify(file, null, 2) + '\n', `capture ${e.client_id}`)
    await db.evaluations.update(e.client_id, { routing_status: 'sent' })
    pushed++
  }
  return { pushed, skipped: 0 }
}

/**
 * Pull routed observations out of the GitHub repo. Named for its transport since
 * tl-04, because `db/sync.ts` now has a `pullObservations` that pulls the same
 * records from Supabase, and two functions of one name across two transports is
 * how a device ends up reading from the wrong one.
 */
export async function pullObservationsFromRepo(): Promise<{
  files: number
  observations: number
  rejected: number
  shared: number
}> {
  const entries = await listDir('routing/outbox')
  let files = 0
  let observations = 0
  let rejected = 0
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue
    const got = await getFile(entry.path)
    if (!got) continue
    const result = await ingestObservationsFile(got.text)
    files++
    observations += result.stored
    rejected += result.rejected
  }
  // Straight up to the backend rather than waiting for the 30-second cycle. What
  // the administrator has just imported is the thing every other device is
  // waiting for, and "routed but not yet shared" is a state worth keeping as
  // short as possible. The loop remains the reliable path if this fails.
  const shared = await shareImported()
  return { files, observations, rejected, shared }
}

/**
 * Push freshly imported observations now (tl-03 build step 3).
 *
 * Best-effort by design: the import has already committed to Dexie, and a failure
 * here means the next sync cycle sends them instead. Returning the count lets the
 * page say "shared with the other devices" rather than leaving the administrator
 * to guess.
 */
async function shareImported(): Promise<number> {
  try {
    return (await pushObservations()).pushed
  } catch {
    return 0
  }
}

// ---- manual path (no token) ----------------------------------------------

/** JSON to paste into Claude alongside ROUTING.md. */
export async function buildExportBundle(): Promise<{ json: string; count: number }> {
  const pending = await listPendingCaptures()
  const captures = await Promise.all(pending.map(captureFileFor))
  const bundle = { schema: CAPTURE_BUNDLE_SCHEMA_ID, generated_at: new Date().toISOString(), captures }
  return { json: JSON.stringify(bundle, null, 2), count: captures.length }
}

/**
 * Ingest whatever Claude returns. Accepts: an observations bundle
 * ({results: ObservationsFile[]}), a single ObservationsFile, or a bare array of
 * ObservationsFile. Validates every observation; stores the valid ones.
 */
export async function importObservationsText(text: string): Promise<{
  files: number
  stored: number
  rejected: number
  shared: number
}> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON.')
  }
  const fileList = extractObservationsFiles(parsed)
  if (fileList.length === 0) throw new Error('No observation results found in that JSON.')
  let files = 0
  let stored = 0
  let rejected = 0
  for (const f of fileList) {
    const r = await storeObservationsFile(f)
    files++
    stored += r.stored
    rejected += r.rejected
  }
  const shared = await shareImported()
  return { files, stored, rejected, shared }
}

/**
 * Ingest an agent's `output/` folder (tl-15): a set of uploaded files, per-item verdicts.
 *
 * THREE THINGS THIS DOES THAT THE PASTE PATH DOES NOT, and each is in the spec's
 * acceptance list rather than invented here.
 *
 * **Round-trip identity.** Every item is matched to a capture by the id the pack handed
 * out. A file naming a capture this device does not hold is `unknown_capture`; one naming
 * a capture already routed is `already_routed` and is not written, so a stale pack from
 * last week cannot overwrite work that has since been done properly. Neither is an
 * exception thrown: both are reported per file, because an operator uploading twenty
 * files needs to know which two were ignored.
 *
 * **Nothing partially imports, and nothing all-or-nothings either.** One invalid item
 * rejects that item, names it, and the rest of its file proceeds — which is what
 * `importObservationsText` already did and what this reports properly for the first time.
 *
 * **Caps at the boundary.** A file over 2MB, or more than 500 of them, is refused before
 * anything is parsed: this is arbitrary content from a tool the app does not control.
 */
export async function importObservationsPack(
  uploads: { name: string; text: string }[],
): Promise<ImportReport> {
  if (uploads.length > MAX_IMPORT_FILES) {
    throw new Error(`That is more than ${MAX_IMPORT_FILES} files. Upload the output folder only.`)
  }
  const reports: ImportFileReport[] = []
  let stored = 0
  let rejected = 0
  let skipped = 0

  for (const upload of uploads) {
    const name = upload.name.split('/').pop() || upload.name
    if (upload.text.length > MAX_IMPORT_FILE_BYTES) {
      reports.push({ name, capture: null, status: 'malformed', stored: 0, rejected: 0, items: [] })
      skipped++
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(upload.text)
    } catch {
      reports.push({ name, capture: null, status: 'malformed', stored: 0, rejected: 0, items: [] })
      skipped++
      continue
    }
    const files = extractObservationsFiles(parsed)
    if (files.length === 0) {
      reports.push({ name, capture: null, status: 'malformed', stored: 0, rejected: 0, items: [] })
      skipped++
      continue
    }
    for (const file of files) {
      const r = await storeObservationsFile(file, {
        refuseUnknownCapture: true,
        refuseAlreadyRouted: true,
      })
      reports.push({
        name,
        capture: file.capture_client_id,
        status: r.status,
        stored: r.stored,
        rejected: r.rejected,
        items: r.items,
      })
      stored += r.stored
      rejected += r.rejected
      if (r.status !== 'imported') skipped++
    }
  }

  const shared = await shareImported()
  return { files: reports, stored, rejected, skipped, shared }
}

// ---- shared ingest --------------------------------------------------------

async function ingestObservationsFile(text: string): Promise<{ stored: number; rejected: number }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { stored: 0, rejected: 0 }
  }
  const files = extractObservationsFiles(parsed)
  let stored = 0
  let rejected = 0
  for (const f of files) {
    const r = await storeObservationsFile(f)
    stored += r.stored
    rejected += r.rejected
  }
  return { stored, rejected }
}

function extractObservationsFiles(parsed: unknown): ObservationsFile[] {
  if (Array.isArray(parsed)) return parsed.filter(isObservationsFile)
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.results)) return obj.results.filter(isObservationsFile)
    if (isObservationsFile(parsed)) return [parsed]
  }
  return []
}

function isObservationsFile(x: unknown): x is ObservationsFile {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return typeof o.capture_client_id === 'string' && Array.isArray(o.observations)
}

/**
 * Who produced this capture, so the end-of-day email can attribute observations to
 * an evaluator. The router's own captures are in local Dexie; another evaluator's
 * capture lives only in the routing inbox file (which carries evaluator_email), so
 * fall back to that. Resolved before the write transaction because the inbox fetch
 * is network IO. Best-effort: null when neither source is reachable.
 */
async function resolveEvaluatorEmail(captureId: string): Promise<string | null> {
  const local = await db.evaluations.get(captureId)
  if (local) return local.evaluator_email
  if (!getRoutingToken()) return null
  try {
    const got = await getFile(inboxPath(captureId))
    if (got) return (JSON.parse(got.text) as CaptureFile).evaluator_email ?? null
  } catch {
    /* offline / not found — fall through to null */
  }
  return null
}

/**
 * Which workshop's record these observations belong to (tl-04).
 *
 * The backend's read policy is "member of this observation's workshop", so an
 * observation without one cannot be shared, which is the whole problem this
 * resolution exists to prevent. Three sources, most authoritative first: the
 * originating capture, the participant the observation is about, and the workshop
 * this device is currently working in. The third is a genuine fallback rather
 * than a guess dressed up as one: a router is by definition working inside the
 * workshop whose captures they are routing.
 */
async function resolveWorkshopId(
  captureId: string,
  participantIds: Array<string | null>,
): Promise<string | null> {
  const local = await db.evaluations.get(captureId)
  const fromParticipants: Array<string | null> = []
  for (const pid of participantIds) {
    if (!pid) continue
    const participant = await db.participants.get(pid)
    fromParticipants.push(participant?.workshop_id ?? null)
  }
  return pickWorkshopId(local?.workshop_id, fromParticipants, getActiveWorkshopId())
}

/**
 * How strictly to read a returned file (tl-15).
 *
 * The pack path is the strict one, and the asymmetry is the whole point rather than an
 * inconsistency. A pack is generated FROM this device's pending queue, so a capture id
 * it does not recognize is a stale or forged pack rather than a colleague's work, and a
 * capture already routed must not be overwritten by a pack somebody generated last
 * week. The repo path is the loose one because both of those are legitimate there: it
 * pulls captures this device never recorded, and re-reading `outbox/` after a
 * correction is how a router fixes a bad batch. That escape hatch survives on the paste
 * path too, which keeps its replace semantics.
 */
interface StoreOptions {
  /** Refuse a capture this device holds no evaluation for. */
  refuseUnknownCapture?: boolean
  /** Refuse a capture already marked routed rather than replacing its observations. */
  refuseAlreadyRouted?: boolean
}

/** Replace any prior observations for this capture with the validated set. */
async function storeObservationsFile(
  file: ObservationsFile,
  options: StoreOptions = {},
): Promise<{ stored: number; rejected: number; items: ImportItemReport[]; status: ImportFileStatus }> {
  const captureId = file.capture_client_id
  const importedAt = new Date().toISOString()
  const local = await db.evaluations.get(captureId)
  if (options.refuseUnknownCapture && !local) {
    return { stored: 0, rejected: 0, items: [], status: 'unknown_capture' }
  }
  if (options.refuseAlreadyRouted && local?.routing_status === 'routed') {
    return { stored: 0, rejected: 0, items: [], status: 'already_routed' }
  }
  const evaluatorEmail = await resolveEvaluatorEmail(captureId)
  const validated = file.observations.map((raw) => validateObservation(raw))
  const workshopId = await resolveWorkshopId(
    captureId,
    validated.map((v) => (v.ok ? v.value.participant_id : null)),
  )
  // THE SECOND HALF OF THE IMPORT BOUNDARY (tl-09). `validateObservation` checked
  // the shape; this checks the designation against the scale of the workshop the
  // capture actually belongs to, which could only be resolved once the file's
  // participants had been read. A routed observation carrying a value the
  // workshop does not define is rejected exactly as a malformed one is: it would
  // otherwise sit in a report as a number no legend can label.
  const scale = await scaleForWorkshop(workshopId)
  /**
   * THE THIRD PART OF THE IMPORT BOUNDARY (tl-21). `validateObservation` checks the
   * shape and `isOnScale` checks the designation; neither has ever checked that the
   * participant the observation names actually exists.
   *
   * It was found by writing this spec's negative test — "a result whose JSON is valid but
   * names a participant who is not in the workshop must be rejected, not created" — and
   * discovering that it was not true of any mode, including the copy/paste path this
   * check now also covers. An observation carrying an invented id is worse than a
   * rejected one: reports roll up BY participant, so it lands in the store, appears in no
   * report, and nothing anywhere says a word about it.
   *
   * THE GUARD ON THE GUARD. It only applies when this device actually holds a roster for
   * the workshop. A device that has not pulled reference data yet knows no participants at
   * all, and rejecting real work against an empty roster would be a far worse failure than
   * the one being prevented. Unmatched names are still legal: the runbook tells the router
   * to send `participant_id: null` with `needs_review` when it cannot match somebody, and
   * that path is untouched.
   */
  const roster = new Set(
    (workshopId ? await db.participants.where('workshop_id').equals(workshopId).toArray() : []).map((p) => p.id),
  )
  /**
   * THE FOURTH PART OF THE IMPORT BOUNDARY (tl-15): a question code the workshop does
   * not define.
   *
   * The same silent failure as the participant check and found the same way — by
   * writing the negative test the spec asks for. Reports roll up BY question code, so an
   * observation carrying an invented code lands in the store, appears in no report, and
   * nothing anywhere says a word about it. `ksa_code` is a string on the record and
   * nothing has ever checked it against the workshop's own questions.
   *
   * Guarded like the roster check: only when this device actually holds questions for
   * the workshop, because a device that has not pulled reference data yet knows none of
   * them and rejecting real work against an empty set would be the worse failure.
   */
  const questionCodes = new Set(
    (workshopId ? await db.ksas.where('workshop_id').equals(workshopId).toArray() : []).map((k) => k.code),
  )
  const records: ObservationRecord[] = []
  const items: ImportItemReport[] = []
  let rejected = 0
  const reject = (i: number, rejection: ImportRejection, raw: unknown, detail?: string) => {
    rejected++
    const o = (raw ?? {}) as Record<string, unknown>
    items.push({
      index: i,
      participant: typeof o.participant_name === 'string' ? o.participant_name : null,
      ksaCode: typeof o.ksa_code === 'string' ? o.ksa_code : null,
      status: 'rejected',
      rejection,
      detail,
    })
    console.warn(`[honest-eval] routed observation ${captureId}::${i} rejected: ${rejection}${detail ? ` (${detail})` : ''}`)
  }
  validated.forEach((v, i) => {
    const raw = file.observations[i]
    if (!v.ok) {
      reject(i, 'shape', raw, v.reason)
      return
    }
    if (v.value.participant_id && roster.size > 0 && !roster.has(v.value.participant_id)) {
      reject(i, 'unknown_participant', raw, v.value.participant_id)
      return
    }
    if (questionCodes.size > 0 && !questionCodes.has(v.value.ksa_code)) {
      reject(i, 'unknown_question', raw, v.value.ksa_code)
      return
    }
    if (!isOnScale(v.value, scale)) {
      reject(i, 'off_scale', raw, String(v.value.evidence_designation))
      return
    }
    /**
     * THE FIFTH PART OF THE IMPORT BOUNDARY (tl-15): a quotation that is not in the
     * source. See ai/provenance.ts for why this is the check that matters most and why
     * it is deliberately generous. It runs only where this device holds the capture's
     * own text, which is every path that generated the work locally.
     */
    if (!excerptIsGrounded(v.value.source_excerpt, local?.source_text)) {
      reject(i, 'unsupported_quotation', raw, v.value.source_excerpt.slice(0, 60))
      return
    }
    items.push({
      index: i,
      participant: v.value.participant_name,
      ksaCode: v.value.ksa_code,
      status: 'stored',
    })
    records.push({
      id: `${captureId}::${i}`,
      capture_client_id: captureId,
      workshop_id: workshopId,
      imported_at: importedAt,
      evaluator_email: evaluatorEmail,
      // Fresh imports start unsynced; db/sync.ts pushes them on the next cycle.
      sync_status: 'local',
      sync_error: null,
      ...v.value,
    })
  })
  await db.transaction('rw', [db.observations, db.evaluations], async () => {
    const old = await db.observations.where('capture_client_id').equals(captureId).primaryKeys()
    await db.observations.bulkDelete(old)
    await db.observations.bulkPut(records)
    const ev = await db.evaluations.get(captureId)
    if (ev) await db.evaluations.update(captureId, { routing_status: 'routed' })
  })
  return { stored: records.length, rejected, items, status: 'imported' as const }
}

export function getObservationsForCapture(captureId: string) {
  return db.observations.where('capture_client_id').equals(captureId).toArray()
}
