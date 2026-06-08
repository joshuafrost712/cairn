// High-level routing operations. Ties the device store (Dexie) to the routing
// workspace shapes and the GitHub client. Two paths, same file shapes:
//
//   Automated (a GitHub token is set): pushPendingCaptures() writes inbox/<id>.json;
//     you route on the repo with Claude Max; pullObservations() reads outbox/<id>.json.
//   Manual (no token, fully phone-native): buildExportBundle() gives JSON you paste
//     into Claude with a pointer to ROUTING.md; importObservationsText() ingests what
//     Claude returns. No credentials, no API spend.

import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { validateObservation } from '../ai/contract'
import {
  buildCaptureFile,
  inboxPath,
  type CaptureFile,
  type ObservationsFile,
} from '../ai/workspace'
import { listDir, getFile, putFile } from './github'
import type { EvaluationRecord, ObservationRecord } from '../lib/types'

export const CAPTURE_BUNDLE_SCHEMA_ID = 'cairn.capture-bundle/v1'
export const OBSERVATIONS_BUNDLE_SCHEMA_ID = 'cairn.observations-bundle/v1'

/** Submitted captures not yet routed back. (routing_status 'routed' = done.) */
export async function listPendingCaptures(): Promise<EvaluationRecord[]> {
  const all = await db.evaluations.toArray()
  return all
    .filter((e) => e.attestation && e.routing_status !== 'routed' && e.source_text.trim())
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** Assemble the self-contained capture file for one evaluation from the local cache. */
async function captureFileFor(e: EvaluationRecord): Promise<CaptureFile> {
  const workshop = e.workshop_id ? (await db.workshops.get(e.workshop_id)) ?? null : null
  const activity = e.activity_id ? (await db.activities.get(e.activity_id)) ?? null : null
  const ksasInScope = e.activity_id ? await ksasForActivity(e.activity_id) : []
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

export async function pullObservations(): Promise<{ files: number; observations: number; rejected: number }> {
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
  return { files, observations, rejected }
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
export async function importObservationsText(text: string): Promise<{ files: number; stored: number; rejected: number }> {
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
  return { files, stored, rejected }
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

/** Replace any prior observations for this capture with the validated set. */
async function storeObservationsFile(file: ObservationsFile): Promise<{ stored: number; rejected: number }> {
  const captureId = file.capture_client_id
  const importedAt = new Date().toISOString()
  const records: ObservationRecord[] = []
  let rejected = 0
  file.observations.forEach((raw, i) => {
    const v = validateObservation(raw)
    if (!v.ok) {
      rejected++
      return
    }
    records.push({ id: `${captureId}::${i}`, capture_client_id: captureId, imported_at: importedAt, ...v.value })
  })
  await db.transaction('rw', [db.observations, db.evaluations], async () => {
    const old = await db.observations.where('capture_client_id').equals(captureId).primaryKeys()
    await db.observations.bulkDelete(old)
    await db.observations.bulkPut(records)
    const ev = await db.evaluations.get(captureId)
    if (ev) await db.evaluations.update(captureId, { routing_status: 'routed' })
  })
  return { stored: records.length, rejected }
}

export function getObservationsForCapture(captureId: string) {
  return db.observations.where('capture_client_id').equals(captureId).toArray()
}
