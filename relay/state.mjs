/**
 * The relay's queue on disk (tl-21).
 *
 * A DIRECTORY OF JSON FILES, one per job, written by atomic rename, in a persistent
 * state directory. `node:sqlite` exists on the Node this was built against and was
 * rejected: a helper's laptop in tl-22 may be several majors behind, and a queue that
 * holds tens of items does not need a database. The file layout is also worth more than
 * elegance at a workshop — a stuck job can be read, fixed or deleted with a text
 * editor, on a hotel wifi, by somebody who is not going to open a SQL prompt.
 *
 * NEVER /tmp. The state directory is `~/Library/Application Support/honest-eval-relay`,
 * per the standing persistence rule: an in-flight job holds a capture's evidence and is
 * the only durable record that the work was asked for, so a reboot must not eat it.
 * `HONEST_EVAL_RELAY_HOME` overrides it, which is what the harnesses use.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  collectPatch,
  completePatch,
  failurePatch,
  leasePatch,
  pickNext,
  purgeIds,
  reapExpired,
  summarize,
  uncollected,
} from './queue.mjs'

export function relayHome() {
  const override = process.env.HONEST_EVAL_RELAY_HOME
  if (override) return override
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'honest-eval-relay')
    : join(homedir(), '.honest-eval-relay')
}

export const jobsDir = () => join(relayHome(), 'jobs')
export const dropInDir = () => join(relayHome(), 'drop', 'in')
export const dropOutDir = () => join(relayHome(), 'drop', 'out')
export const dropDoneDir = () => join(relayHome(), 'drop', 'done')
export const tokenPath = () => join(relayHome(), 'token')
export const logPath = () => join(relayHome(), 'relay.log')
const throttlePath = () => join(relayHome(), 'throttle.json')

export async function ensureState() {
  for (const dir of [jobsDir(), dropInDir(), dropOutDir(), dropDoneDir()]) {
    await mkdir(dir, { recursive: true })
  }
  return relayHome()
}

/**
 * Atomic write. A job file is read by a second process (the drop watcher, a text
 * editor, a `cat` at a workshop) and a partially written one parses as nothing; rename
 * within the same directory is the platform's own guarantee against that.
 */
async function writeJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

const jobPath = (id) => join(jobsDir(), `${id}.json`)

/** Job ids come from us and index a filename, so they are checked before they touch one. */
export function isJobId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

export async function readJob(id) {
  if (!isJobId(id)) return null
  try {
    return JSON.parse(await readFile(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

/** Every job on disk. A file that does not parse is skipped rather than fatal. */
export async function readJobs() {
  let names = []
  try {
    names = await readdir(jobsDir())
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await readFile(join(jobsDir(), name), 'utf8')))
    } catch {
      /* a half-written or hand-edited file: skipped, not fatal */
    }
  }
  return out
}

async function patchJob(id, patch) {
  const job = await readJob(id)
  if (!job) return null
  const next = { ...job, ...patch }
  await writeJson(jobPath(id), next)
  return next
}

export async function enqueue({ workshop_id = null, fn, payload, transport = 'http' }) {
  await ensureState()
  const now = new Date().toISOString()
  const job = {
    id: randomUUID(),
    workshop_id,
    fn,
    transport,
    status: 'queued',
    attempts: 0,
    lease_until: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
    collected_at: null,
    payload,
    result: null,
    result_raw: null,
    error: null,
  }
  await writeJson(jobPath(job.id), job)
  return job
}

/**
 * Claim the next job, reaping expired leases first.
 *
 * The reap is here rather than on a timer because this is the only place that cares:
 * a dispatcher asking for work is exactly the moment an abandoned job should become
 * available again, and a timer would be a second thing that could stop.
 */
export async function claimNext({ now = Date.now(), leaseMs } = {}) {
  const jobs = await readJobs()
  for (const { id, patch } of reapExpired(jobs, now)) await patchJob(id, patch)
  const fresh = await readJobs()
  const next = pickNext(fresh, now)
  if (!next) return null
  return patchJob(next.id, leasePatch(next, now, leaseMs))
}

export async function complete(id, result, { now = Date.now() } = {}) {
  return patchJob(id, completePatch(now, result))
}

export async function fail(id, reason, options = {}) {
  const job = await readJob(id)
  if (!job) return null
  return patchJob(id, failurePatch(job, options.now ?? Date.now(), reason, options))
}

/** Hand a leased job back without spending a further attempt: the shutdown path. */
export async function release(id, { now = Date.now() } = {}) {
  return patchJob(id, { status: 'queued', lease_until: null, updated_at: new Date(now).toISOString() })
}

/**
 * Add a field the queue policy has no opinion about (the drop file's name, so far).
 *
 * Deliberately narrow: it merges into the record and cannot change `status`, because a
 * status transition is the queue's business and belongs to one of the functions above.
 */
export async function annotate(id, patch) {
  const { status, ...rest } = patch ?? {}
  void status
  return patchJob(id, rest)
}

export async function listUncollected(workshopId) {
  return uncollected(await readJobs(), workshopId)
}

export async function markCollected(ids, { now = Date.now() } = {}) {
  let n = 0
  for (const id of ids) {
    if (await patchJob(id, collectPatch(now))) n++
  }
  return n
}

export async function purge({ now = Date.now(), doneTtlMs, failedTtlMs } = {}) {
  const ids = purgeIds(await readJobs(), now, { doneTtlMs, failedTtlMs })
  for (const id of ids) await rm(jobPath(id), { force: true })
  return ids.length
}

export async function stats() {
  return summarize(await readJobs())
}

/** Empty the state directory. `npm run relay:wipe` is this, and nothing else. */
export async function wipe() {
  await rm(relayHome(), { recursive: true, force: true })
  await ensureState()
  return relayHome()
}

// ---- the token -------------------------------------------------------------

/**
 * The relay's bearer token, minted on first run and kept in the state directory.
 *
 * It is what stops any page in the browser from posting jobs to a service on loopback.
 * `HONEST_EVAL_RELAY_TOKEN` overrides it for a scripted run; otherwise the file is the
 * one place it lives and the operator copies it into the app once per device.
 */
export async function loadOrCreateToken() {
  if (process.env.HONEST_EVAL_RELAY_TOKEN) return process.env.HONEST_EVAL_RELAY_TOKEN
  await ensureState()
  try {
    const existing = (await readFile(tokenPath(), 'utf8')).trim()
    if (existing) return existing
  } catch {
    /* first run */
  }
  const token = randomUUID().replace(/-/g, '')
  await writeFile(tokenPath(), token + '\n', { encoding: 'utf8', mode: 0o600 })
  return token
}

// ---- the throttle flag -----------------------------------------------------

/**
 * Persisted so a restart does not immediately re-hit a limit it already knows about,
 * and so an administrator restarting the relay to "fix" the throttle is told the same
 * true thing rather than a different one.
 */
export async function readThrottle() {
  try {
    const raw = JSON.parse(await readFile(throttlePath(), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    if (raw.until && Date.parse(raw.until) <= Date.now()) return null
    return raw
  } catch {
    return null
  }
}

export async function writeThrottle(value) {
  await ensureState()
  if (!value) {
    await rm(throttlePath(), { force: true })
    return null
  }
  await writeJson(throttlePath(), value)
  return value
}

// ---- the log ---------------------------------------------------------------

/**
 * One line per event, to stdout and to `relay.log`.
 *
 * NO PAYLOAD TEXT, EVER. Every call site passes named scalars and this function has no
 * way to render an object, which is the difference between a rule and a habit: the log
 * is the file most likely to be pasted into a support conversation, and a capture's
 * dictated evidence must not travel that way.
 */
export async function logLine(event, fields = {}) {
  const parts = [new Date().toISOString(), event]
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue
    parts.push(`${k}=${String(v).replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  const line = parts.join(' ')
  process.stdout.write(line + '\n')
  try {
    await writeFile(logPath(), line + '\n', { encoding: 'utf8', flag: 'a' })
  } catch {
    /* a log that cannot be written must not stop a job that can be run */
  }
}
