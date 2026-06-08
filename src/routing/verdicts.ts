// Cross-device verdict sync over the routing repo, so the multi-evaluator gate
// works when people confirm on different devices (not just one).
//
// Conflict-free by construction: each evaluator owns exactly one file,
// routing/verdicts/<evaluator>.json, and a device only ever writes its OWN file.
// Pulling reads every other evaluator's file and replaces that evaluator's local
// verdicts wholesale (so their deletions propagate too). Your own file is never
// overwritten on pull — your local store is authoritative for you.
//
// Observations already sync through routing/outbox/ (operations.pullObservations),
// so every evaluator's device can hold the same observations to verify.

import { db } from '../db/local'
import { getFile, putFile, listDir } from './github'
import { pullObservations } from './operations'
import type { VerificationVerdict } from '../lib/types'

export const VERDICTS_FILE_SCHEMA_ID = 'cairn.verdicts/v1'
const DIR = 'routing/verdicts'

interface VerdictsFile {
  schema: typeof VERDICTS_FILE_SCHEMA_ID
  evaluator_email: string
  updated_at: string
  verdicts: VerificationVerdict[]
}

const safeName = (email: string) => email.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
const verdictsPath = (email: string) => `${DIR}/${safeName(email)}.json`

function myVerdictsFile(myEmail: string, verdicts: VerificationVerdict[]): VerdictsFile {
  return { schema: VERDICTS_FILE_SCHEMA_ID, evaluator_email: myEmail, updated_at: new Date().toISOString(), verdicts }
}

function asVerdictsFiles(parsed: unknown): VerdictsFile[] {
  const isFile = (x: unknown): x is VerdictsFile => {
    if (typeof x !== 'object' || x === null) return false
    const o = x as Record<string, unknown>
    return typeof o.evaluator_email === 'string' && Array.isArray(o.verdicts)
  }
  if (Array.isArray(parsed)) return parsed.filter(isFile)
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.results)) return o.results.filter(isFile)
    if (isFile(parsed)) return [parsed]
  }
  return []
}

/** Replace one evaluator's local verdicts with the given set (never touches mine). */
async function replaceEvaluatorVerdicts(file: VerdictsFile, myEmail: string): Promise<number> {
  if (file.evaluator_email === myEmail) return 0
  await db.transaction('rw', db.verifications, async () => {
    const old = await db.verifications.where('evaluator_email').equals(file.evaluator_email).primaryKeys()
    await db.verifications.bulkDelete(old)
    await db.verifications.bulkPut(file.verdicts)
  })
  return file.verdicts.length
}

// ---- automated path (GitHub token) ---------------------------------------

export async function pushMyVerdicts(myEmail: string): Promise<{ pushed: number }> {
  const mine = await db.verifications.where('evaluator_email').equals(myEmail).toArray()
  await putFile(verdictsPath(myEmail), JSON.stringify(myVerdictsFile(myEmail, mine), null, 2) + '\n', `verdicts ${myEmail} (${mine.length})`)
  return { pushed: mine.length }
}

export async function pullVerdicts(myEmail: string): Promise<{ evaluators: number; merged: number }> {
  const entries = await listDir(DIR)
  let evaluators = 0
  let merged = 0
  for (const e of entries) {
    if (e.type !== 'file' || !e.name.endsWith('.json')) continue
    const got = await getFile(e.path)
    if (!got) continue
    let file: VerdictsFile | undefined
    try {
      file = asVerdictsFiles(JSON.parse(got.text))[0]
    } catch {
      continue
    }
    if (!file || file.evaluator_email === myEmail) continue
    merged += await replaceEvaluatorVerdicts(file, myEmail)
    evaluators++
  }
  return { evaluators, merged }
}

export async function syncVerdicts(myEmail: string): Promise<{ pushed: number; evaluators: number; merged: number }> {
  const push = await pushMyVerdicts(myEmail)
  const pull = await pullVerdicts(myEmail)
  return { ...push, ...pull }
}

/** One tap for an evaluator: pull the latest observations, push my verdicts, pull everyone else's. */
export async function syncAll(myEmail: string): Promise<{ observations: number; pushed: number; evaluators: number; merged: number }> {
  let observations = 0
  try {
    observations = (await pullObservations()).observations
  } catch {
    // no outbox yet, or transient; verdict sync still proceeds
  }
  const v = await syncVerdicts(myEmail)
  return { observations, ...v }
}

// ---- manual path (no token) ----------------------------------------------

export async function buildMyVerdictBundle(myEmail: string): Promise<{ json: string; count: number }> {
  const mine = await db.verifications.where('evaluator_email').equals(myEmail).toArray()
  return { json: JSON.stringify(myVerdictsFile(myEmail, mine), null, 2), count: mine.length }
}

export async function importVerdictsText(text: string, myEmail: string): Promise<{ evaluators: number; merged: number }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON.')
  }
  const files = asVerdictsFiles(parsed).filter((f) => f.evaluator_email !== myEmail)
  if (files.length === 0) throw new Error("No other evaluators' verdicts found in that JSON.")
  let merged = 0
  for (const f of files) merged += await replaceEvaluatorVerdicts(f, myEmail)
  return { evaluators: files.length, merged }
}
