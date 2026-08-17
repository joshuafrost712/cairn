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

/**
 * What became of one returned file.
 *
 * `all_rejected` is its own status rather than an `imported` with a zero, because the two
 * mean opposite things to whoever is looking: one says the router's answer was kept, the
 * other says none of it could be and the capture is still waiting. Nothing is written in
 * that case — see the note at the end of `storeObservationsFile`.
 */
export type ImportFileStatus =
  | 'imported'
  | 'all_rejected'
  | 'already_routed'
  | 'unknown_capture'
  | 'malformed'
  | 'too_large'

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
  /**
   * FILES skipped whole, not items: already routed, unknown, unreadable, oversize.
   *
   * Named for what it counts after the review found the doc comment claiming items — two
   * skipped files holding five observations each are two here, and a later caller trusting
   * the old wording would have reported a fifth of the real figure.
   */
  filesSkipped: number
  shared: number
}

/**
 * How many items each rejection rule refused, so a surface with no per-item report can
 * still say WHY (tl-15).
 *
 * The pack screen lists every rejected item. The repo pull, the relay and the hosted
 * fan-out do not and should not — they are batch operations with a one-line result — but
 * "2 rejected" with no reason is exactly the kind of silence the two new rules would
 * otherwise introduce into three paths that were working before this spec.
 */
export type RejectionCounts = Partial<Record<ImportRejection, number>>

export function countRejections(items: ImportItemReport[]): RejectionCounts {
  const counts: RejectionCounts = {}
  for (const item of items) {
    if (item.status !== 'rejected' || !item.rejection) continue
    counts[item.rejection] = (counts[item.rejection] ?? 0) + 1
  }
  return counts
}

/**
 * The two rules tl-15 added, as a sentence for a surface that shows no per-item report.
 *
 * Only those two, deliberately: the shape, the roster and the scale have refused items on
 * every path since long before this spec, and their counts are not news. Returns null when
 * neither fired, so a caller appends nothing rather than appending "0 and 0".
 */
export function rejectionNoteTokens(
  rejections: RejectionCounts,
): { quotation: number; question: number } | null {
  const quotation = rejections.unsupported_quotation ?? 0
  const question = rejections.unknown_question ?? 0
  if (quotation === 0 && question === 0) return null
  return { quotation, question }
}

export function mergeRejections(into: RejectionCounts, from: RejectionCounts): RejectionCounts {
  for (const [key, n] of Object.entries(from)) {
    const rule = key as ImportRejection
    into[rule] = (into[rule] ?? 0) + (n ?? 0)
  }
  return into
}

/**
 * Per-file caps on an upload, which is arbitrary content from a tool the app does not
 * control.
 *
 * Measured in BYTES against the browser's own `File.size`, before the file is read. The
 * first draft measured `text.length` after `await f.text()`, which is neither a byte count
 * (a Devanagari answer is ~3 bytes a character, so a 6MB file passed a "2MB" cap) nor a
 * guard (the whole file was already in memory by the time the check ran).
 */
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
  /** Which rules did the rejecting, so the page can say more than a count (tl-15). */
  rejections: RejectionCounts
}> {
  const entries = await listDir('routing/outbox')
  let files = 0
  let observations = 0
  let rejected = 0
  const rejections: RejectionCounts = {}
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue
    const got = await getFile(entry.path)
    if (!got) continue
    const result = await ingestObservationsFile(got.text)
    files++
    observations += result.stored
    rejected += result.rejected
    mergeRejections(rejections, result.rejections)
  }
  // Straight up to the backend rather than waiting for the 30-second cycle. What
  // the administrator has just imported is the thing every other device is
  // waiting for, and "routed but not yet shared" is a state worth keeping as
  // short as possible. The loop remains the reliable path if this fails.
  const shared = await shareImported()
  return { files, observations, rejected, shared, rejections }
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
  /**
   * Which rules did the rejecting (tl-15). Added because two new item-level rules — an
   * unknown question code and an ungrounded quotation — now apply on this path as well, and
   * this is the return value the relay, the hosted fan-out and the paste box all report
   * from. "2 rejected" with no reason would have been a silence introduced into three
   * working paths.
   */
  rejections: RejectionCounts
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
  const rejections: RejectionCounts = {}
  for (const f of fileList) {
    const r = await storeObservationsFile(f)
    files++
    stored += r.stored
    rejected += r.rejected
    mergeRejections(rejections, countRejections(r.items))
  }
  const shared = await shareImported()
  return { files, stored, rejected, shared, rejections }
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
export async function importObservationsPack(uploads: PackUpload[]): Promise<ImportReport> {
  if (uploads.length > MAX_IMPORT_FILES) {
    throw new Error(
      `That is ${uploads.length} files, and ${MAX_IMPORT_FILES} is the most that can be imported at once. Upload the output folder in batches.`,
    )
  }
  const reports: ImportFileReport[] = []
  let stored = 0
  let rejected = 0
  let filesSkipped = 0
  const skip = (name: string, status: ImportFileStatus) => {
    reports.push({ name, capture: null, status, stored: 0, rejected: 0, items: [] })
    filesSkipped++
  }

  for (const upload of uploads) {
    const name = upload.name.split('/').pop() || upload.name
    // Bytes, from the file itself, before it is read. An oversize file is `too_large` and
    // not `malformed`: a 10MB answer that is perfectly good JSON reported as "unreadable"
    // sends an operator to look for a syntax error that is not there.
    if (upload.bytes != null && upload.bytes > MAX_IMPORT_FILE_BYTES) {
      skip(name, 'too_large')
      continue
    }
    let text: string
    try {
      text = await upload.read()
    } catch {
      skip(name, 'malformed')
      continue
    }
    if (text.length > MAX_IMPORT_FILE_BYTES) {
      // A belt for a caller that could not supply a size. Character count, so it is a
      // looser bound than the byte cap above rather than a second, disagreeing one.
      skip(name, 'too_large')
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      skip(name, 'malformed')
      continue
    }
    const files = extractObservationsFiles(parsed)
    if (files.length === 0) {
      skip(name, 'malformed')
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
      if (r.status !== 'imported' && r.status !== 'all_rejected') filesSkipped++
    }
  }

  const shared = await shareImported()
  return { files: reports, stored, rejected, filesSkipped, shared }
}

/**
 * One uploaded answer file, read lazily.
 *
 * `read()` rather than a string, so the size cap can refuse a file BEFORE its contents are
 * pulled into memory — which is the only version of that cap that is also a guard. `bytes`
 * is the browser's own `File.size`; a caller that genuinely has no size (a test, a paste)
 * omits it and gets the character-count belt instead.
 */
export interface PackUpload {
  name: string
  bytes?: number
  read: () => Promise<string>
}

// ---- shared ingest --------------------------------------------------------

async function ingestObservationsFile(
  text: string,
): Promise<{ stored: number; rejected: number; rejections: RejectionCounts }> {
  const rejections: RejectionCounts = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { stored: 0, rejected: 0, rejections }
  }
  const files = extractObservationsFiles(parsed)
  let stored = 0
  let rejected = 0
  for (const f of files) {
    const r = await storeObservationsFile(f)
    stored += r.stored
    rejected += r.rejected
    mergeRejections(rejections, countRejections(r.items))
  }
  return { stored, rejected, rejections }
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
 * How strictly to read a returned file (tl-15). These two options, and ONLY these two.
 *
 * The asymmetry is deliberate and it is narrow, which the first draft of this comment got
 * wrong by calling the repo path "the loose one" without saying loose about what. What
 * differs between the paths is the two CAPTURE-level questions below. Every ITEM-level rule
 * — the shape, the roster, the question code, the quotation — applies identically on every
 * path, because an invented quotation is no better for having arrived from a repository.
 *
 * A pack is generated FROM this device's pending queue, so a capture id it does not
 * recognize is a stale or forged pack rather than a colleague's work, and a capture already
 * routed must not be overwritten by a pack somebody generated last week. Neither is true of
 * the repo pull: it brings down captures this device never recorded, and re-reading
 * `outbox/` after a correction is how a router fixes a bad batch. That escape hatch survives
 * on the paste path too, which keeps its replace semantics.
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
      // tl-30. Carried from the capture, never inferred from the participant.
      //
      // The capture is the authority because it is what the insert policy checked
      // when the reviewer wrote it, and because `observation_select` has to agree
      // with `evaluation_select` about who may read the same evidence in its two
      // forms. Absent (a capture this device no longer holds) resolves to
      // 'participant', which is what the Postgres column defaults to and what
      // every row written before this migration means.
      //
      // Placed AFTER the spread, unlike the fields above it: those are trusted
      // defaults a router file may legitimately not carry, whereas this one is a
      // permission fact and a file must never be able to relabel its own evidence
      // as being about a trainee.
      // Fresh imports start unsynced; db/sync.ts pushes them on the next cycle.
      sync_status: 'local',
      sync_error: null,
      ...v.value,
      subject_kind: local?.subject_kind ?? 'participant',
    })
  })
  /**
   * A FILE WHOSE EVERY ITEM WAS REJECTED WRITES NOTHING (tl-15), and this is the most
   * expensive thing this spec found.
   *
   * Before it, the transaction below ran unconditionally: it deleted the capture's existing
   * observations, put an empty set in their place, and marked the capture `routed`. A file
   * that was entirely bad therefore destroyed good evidence AND took the capture out of the
   * pending queue, so it appeared in no future pack and on no routing screen — with nothing
   * anywhere saying so. tl-15 would have made that unrecoverable, because
   * `refuseAlreadyRouted` then declines the corrected re-upload of a capture already marked
   * routed. Two new rejection rules (an unknown question code, an ungrounded quotation) also
   * make an all-rejected file much likelier than it was.
   *
   * An EMPTY answer is deliberately not this case. "An empty `observations` array is a valid
   * result when a capture contains nothing routable" is what the runbook tells the router, so
   * zero items and zero rejections stays what it always was: the capture is routed, and the
   * router has said there was nothing in it.
   */
  if (records.length === 0 && rejected > 0) {
    return { stored: 0, rejected, items, status: 'all_rejected' as const }
  }
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
