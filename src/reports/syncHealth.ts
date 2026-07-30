// The pipeline gauge — pure logic, no IO. Turns the four synced tables into the
// one question nobody could previously answer: between "an evaluator tapped
// Submit" and "it counts toward the participant", where is this evaluation?
//
// It exists because every stage of that pipeline has failed silently at least
// once. A capture sat in a phone's IndexedDB for months because the installed
// build had no backend compiled into it. An evaluation reached Supabase and was
// never routed because routing ran per-device. An observation was routed on a
// laptop and never reached the phone that had to verify it. In all three cases
// the app's own status line said the same reassuring thing.
//
// Kept free of Dexie on purpose: tl-17's cross-workshop overview reads the same
// rollup for its pending-work number, and a module that knows about a local
// database cannot be asked about a workshop the device is not currently in.

import type {
  EvaluationRecord,
  ObservationRecord,
  VerificationVerdict,
} from '../lib/types'
import { observationStatus } from './verification'

/**
 * Where one submitted evaluation has got to.
 *
 * Ordered, and each stage is defined by the failure that strands work there:
 *  - `unsynced`            still only on the device that recorded it
 *  - `synced-unrouted`     on the server, no observations derived from it yet
 *  - `routed-unverified`   observations exist, not all of them count yet
 *  - `verified-counting`   every observation confirmed; it reaches the report
 */
export type FunnelStage = 'unsynced' | 'synced-unrouted' | 'routed-unverified' | 'verified-counting'

export const FUNNEL_STAGES: FunnelStage[] = [
  'unsynced',
  'synced-unrouted',
  'routed-unverified',
  'verified-counting',
]

export interface FunnelRow {
  client_id: string
  workshop_id: string | null
  activity_id: string | null
  evaluator_email: string | null
  /** When the evaluator submitted it; what the age column counts from. */
  submitted_at: string
  stage: FunnelStage
  /** Verbatim from the record, so an error row can show what the backend said. */
  sync_status: EvaluationRecord['sync_status']
  sync_error: string | null
  observations: number
  /** Observations at or past the confirmation threshold, in agreement. */
  counting: number
  /** Observations still short of the threshold. */
  awaitingVerdicts: number
  /** Observations an evaluator rejected, or confirmed at conflicting values. */
  disputed: number
}

export interface FunnelRollup {
  total: number
  unsynced: number
  syncedUnrouted: number
  routedUnverified: number
  verifiedCounting: number
  /** Rows whose last push came back failing. A subset of `unsynced`. */
  errored: number
  /** Rows holding at least one disputed observation. A subset of routedUnverified. */
  disputed: number
}

export interface EvaluatorFunnel extends FunnelRollup {
  evaluator_email: string
}

export interface SyncFunnel {
  rows: FunnelRow[]
  rollup: FunnelRollup
  byEvaluator: EvaluatorFunnel[]
  /** How many confirmations a designation needed, echoed so a page can say it. */
  threshold: number
  /**
   * Unattested drafts left out of every count above. Reported rather than
   * dropped in silence: a draft is not late work, but "why does this say 12 when
   * my phone says 14" has to have an answer on the page.
   */
  draftsExcluded: number
}

function emptyRollup(): FunnelRollup {
  return {
    total: 0,
    unsynced: 0,
    syncedUnrouted: 0,
    routedUnverified: 0,
    verifiedCounting: 0,
    errored: 0,
    disputed: 0,
  }
}

const STAGE_FIELD: Record<FunnelStage, keyof FunnelRollup> = {
  unsynced: 'unsynced',
  'synced-unrouted': 'syncedUnrouted',
  'routed-unverified': 'routedUnverified',
  'verified-counting': 'verifiedCounting',
}

function accumulate(into: FunnelRollup, row: FunnelRow): void {
  into.total += 1
  into[STAGE_FIELD[row.stage]] += 1
  if (row.sync_status === 'error') into.errored += 1
  if (row.disputed > 0) into.disputed += 1
}

/**
 * Stage one evaluation and its derived work.
 *
 * "Verified-counting" deliberately requires at least one observation. A capture
 * that produced none is not finished work with nothing to check; it is a routing
 * run that returned nothing, and calling it counted would hide exactly the case
 * an administrator most needs to see.
 */
export function stageOf(
  evaluation: EvaluationRecord,
  observations: ObservationRecord[],
  verdictsByObservation: Map<string, VerificationVerdict[]>,
  threshold: number,
): FunnelRow {
  const synced = evaluation.sync_status === 'synced'
  let counting = 0
  let awaitingVerdicts = 0
  let disputed = 0
  for (const o of observations) {
    const s = observationStatus(o, verdictsByObservation.get(o.id) ?? [], threshold)
    if (s.status === 'verified' || s.status === 'adjusted') counting += 1
    else if (s.status === 'disputed') disputed += 1
    else awaitingVerdicts += 1
  }

  let stage: FunnelStage
  if (!synced) stage = 'unsynced'
  else if (observations.length === 0) stage = 'synced-unrouted'
  else if (counting === observations.length) stage = 'verified-counting'
  else stage = 'routed-unverified'

  return {
    client_id: evaluation.client_id,
    workshop_id: evaluation.workshop_id ?? null,
    activity_id: evaluation.activity_id ?? null,
    evaluator_email: evaluation.evaluator_email ?? null,
    submitted_at: evaluation.updated_at || evaluation.created_at,
    stage,
    sync_status: evaluation.sync_status,
    sync_error: evaluation.sync_error ?? null,
    observations: observations.length,
    counting,
    awaitingVerdicts,
    disputed,
  }
}

/**
 * The whole funnel for a set of evaluations.
 *
 * Unattested drafts are excluded and counted separately: they are not work an
 * evaluator has finished, and letting them sit in `unsynced` would put a
 * permanent non-zero number under the one heading that has to mean "somebody's
 * finished work has not left their device."
 */
export function buildSyncFunnel(
  evaluations: EvaluationRecord[],
  observations: ObservationRecord[],
  verdicts: VerificationVerdict[],
  threshold: number,
): SyncFunnel {
  const byCapture = new Map<string, ObservationRecord[]>()
  for (const o of observations) {
    const list = byCapture.get(o.capture_client_id)
    if (list) list.push(o)
    else byCapture.set(o.capture_client_id, [o])
  }
  const byObservation = new Map<string, VerificationVerdict[]>()
  for (const v of verdicts) {
    const list = byObservation.get(v.observation_id)
    if (list) list.push(v)
    else byObservation.set(v.observation_id, [v])
  }

  const rows: FunnelRow[] = []
  const rollup = emptyRollup()
  const evaluators = new Map<string, EvaluatorFunnel>()
  let draftsExcluded = 0

  for (const e of evaluations) {
    if (e.attestation !== true) {
      draftsExcluded += 1
      continue
    }
    const row = stageOf(e, byCapture.get(e.client_id) ?? [], byObservation, threshold)
    rows.push(row)
    accumulate(rollup, row)
    const key = row.evaluator_email ?? 'unattributed'
    let per = evaluators.get(key)
    if (!per) {
      per = { evaluator_email: key, ...emptyRollup() }
      evaluators.set(key, per)
    }
    accumulate(per, row)
  }

  rows.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : a.submitted_at > b.submitted_at ? -1 : 0))
  const byEvaluator = [...evaluators.values()].sort((a, b) =>
    a.evaluator_email.localeCompare(b.evaluator_email),
  )
  return { rows, rollup, byEvaluator, threshold, draftsExcluded }
}

/** Rows an administrator has to do something about, in the order they matter. */
export function exceptionRows(funnel: SyncFunnel): {
  errored: FunnelRow[]
  unrouted: FunnelRow[]
  unverified: FunnelRow[]
} {
  return {
    errored: funnel.rows.filter((r) => r.sync_status === 'error'),
    unrouted: funnel.rows.filter((r) => r.stage === 'synced-unrouted'),
    unverified: funnel.rows.filter((r) => r.stage === 'routed-unverified'),
  }
}

/**
 * How old something is, in the coarsest unit that is still true.
 *
 * Coarse on purpose. The number's job is to separate "sent a moment ago" from
 * "has been sitting here since Tuesday", and a minute-accurate age on a
 * four-day-old row is precision the reader cannot use and should not trust.
 */
export function formatAge(iso: string | null | undefined, now: number): string {
  if (!iso) return 'unknown'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown'
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/**
 * What the device's own status line says about work waiting to be sent.
 *
 * Pure and separate from the component because the sentence is the thing that
 * failed: "local-only" in muted grey next to an online dot was, for months, the
 * app's entire account of a phone that could not send anything at all.
 */
export interface PendingSummary {
  /** Everything queued across the three tables that push. */
  total: number
  evaluations: number
  observations: number
  verdicts: number
  /** Age of the oldest queued item, already formatted. */
  oldestAge: string | null
  /** True when there is queued work and this build has no backend to send it to. */
  stranded: boolean
}

export function summarizePending(
  input: {
    evaluations: Array<{ updated_at?: string; created_at?: string }>
    observations: Array<{ imported_at?: string }>
    verdicts: Array<{ at?: string }>
  },
  backendConfigured: boolean,
  now: number,
): PendingSummary {
  const stamps = [
    ...input.evaluations.map((e) => e.updated_at || e.created_at),
    ...input.observations.map((o) => o.imported_at),
    ...input.verdicts.map((v) => v.at),
  ].filter((s): s is string => Boolean(s) && Number.isFinite(Date.parse(s!)))
  const total = input.evaluations.length + input.observations.length + input.verdicts.length
  const oldest = stamps.length > 0 ? stamps.reduce((a, b) => (a < b ? a : b)) : null
  return {
    total,
    evaluations: input.evaluations.length,
    observations: input.observations.length,
    verdicts: input.verdicts.length,
    oldestAge: oldest ? formatAge(oldest, now) : null,
    stranded: total > 0 && !backendConfigured,
  }
}
