// Dashboard aggregation — pure functions, no Dexie, no React, no wall-clock reads.
// Sits alongside build.ts / verification.ts / discrepancy.ts in the pure tier, and
// obeys the same rule: everything here is a function of its arguments, so a test
// can pin it and two views computing the same number cannot disagree.
//
// Three facts about this app shape everything below.
//
//  1. ObservationRecord has no activity_id. The event is only reachable through
//     capture_client_id -> EvaluationRecord.activity_id, and THAT JOIN CAN MISS:
//     observations arrive from routing/outbox/ and may name a capture made on
//     another evaluator's device that never reached this one. So "which event was
//     this?" is a question with three answers — that one, none, and unknowable —
//     and every activity aggregate reports how many it could not place rather
//     than quietly dropping them.
//
//  2. "Average score" is two different statistics. buildParticipantReport sets
//     representative = max(designations) on purpose ("a KSA is demonstrated by
//     the best evidence of it"). So the mean over participant representatives and
//     the mean over raw observations differ, and diverge further the more
//     observations a participant has. Both are legitimate; they answer different
//     questions. KsaAnalytics carries both, and nothing in the UI may show one
//     without saying which it is.
//
//  3. Small n is the normal case. Four evaluators over 28 participants and 7 KSAs
//     leaves most cells with one or two observations. designationStats therefore
//     separates the arithmetic mean from the mean it is honest to print.

import type {
  Activity,
  DiscrepancyResolution,
  EvaluationRecord,
  Ksa,
  MentoringConversation,
  Participant,
  VerificationVerdict,
} from '../lib/types'
import { designationOf, isSetAside } from './build'
import type { ParticipantReport } from './build'
import type { AnnotatedObservation, Gate } from './verification'
import type { Discrepancy } from './discrepancy'
import { discrepancyId } from './discrepancy'

/** Bucket label for observations whose evaluator cannot be resolved. */
export const UNKNOWN_EVALUATOR = '(unknown)'

// ---------------------------------------------------------------------------
// 1. The join layer
// ---------------------------------------------------------------------------

/** What an observation inherits from the capture that produced it. */
export interface CaptureFacts {
  capture_client_id: string
  activity_id: string | null
  evaluator_email: string | null
  created_at: string
}

export interface CaptureIndex {
  byCapture: Map<string, CaptureFacts>
}

export function buildCaptureIndex(evaluations: EvaluationRecord[]): CaptureIndex {
  const byCapture = new Map<string, CaptureFacts>()
  for (const e of evaluations) {
    byCapture.set(e.client_id, {
      capture_client_id: e.client_id,
      activity_id: e.activity_id,
      evaluator_email: e.evaluator_email,
      created_at: e.created_at,
    })
  }
  return { byCapture }
}

/**
 * An observation with its capture resolved.
 *
 * `activity_id: null` means unattributable, NOT "no event", and `orphaned` says
 * which of the two it is: orphaned means the capture row is not on this device,
 * so the event is unknowable here rather than absent.
 */
export interface SituatedObservation extends AnnotatedObservation {
  activity_id: string | null
  /** the observation's own evaluator_email, else the capture's, else null */
  evaluator: string | null
  captured_at: string | null
  /** capture_client_id was not found in the evaluations passed in */
  orphaned: boolean
}

export function situate(
  observations: AnnotatedObservation[],
  index: CaptureIndex,
): SituatedObservation[] {
  return observations.map((o) => {
    const cap = index.byCapture.get(o.capture_client_id)
    return {
      ...o,
      activity_id: cap?.activity_id ?? null,
      // The observation's own attribution wins when present: it is stamped at
      // ingest and survives even when the capture itself never synced here.
      evaluator: o.evaluator_email ?? cap?.evaluator_email ?? null,
      captured_at: cap?.created_at ?? null,
      orphaned: cap == null,
    }
  })
}

export interface AttributionHealth {
  total: number
  withActivity: number
  withEvaluator: number
  /** distinct capture ids referenced by observations but absent locally */
  orphanedCaptures: string[]
  /** participant_id === null; mirrors unattributedObservations in build.ts */
  unattributedParticipant: number
}

export function attributionHealth(situated: SituatedObservation[]): AttributionHealth {
  const orphaned = new Set<string>()
  let withActivity = 0
  let withEvaluator = 0
  let unattributedParticipant = 0
  for (const o of situated) {
    if (o.activity_id) withActivity++
    if (o.evaluator) withEvaluator++
    if (o.participant_id === null) unattributedParticipant++
    if (o.orphaned) orphaned.add(o.capture_client_id)
  }
  return {
    total: situated.length,
    withActivity,
    withEvaluator,
    orphanedCaptures: [...orphaned].sort(),
    unattributedParticipant,
  }
}

// ---------------------------------------------------------------------------
// 2. Counting policy
// ---------------------------------------------------------------------------

/**
 * Which observations a statistic counts, and at what value.
 *
 * 'counting' — exactly what a report would use, via build.ts's own isSetAside and
 *   designationOf. Verified and adjusted items count even if routing flagged
 *   them; disputed and unverified-needs-review do not. Use for anything that
 *   describes a PARTICIPANT, so the dashboard and the report agree.
 *
 * 'all' — every observation at its raw evidence_designation. Use for anything
 *   that describes an EVALUATOR: an observation later rejected is still a thing
 *   that evaluator said, and excluding it would make a harsh evaluator look
 *   moderate by deleting the evidence of harshness.
 */
export type CountingPolicy = 'counting' | 'all'

export function countsToward(o: SituatedObservation, policy: CountingPolicy): boolean {
  return policy === 'all' ? true : !isSetAside(o)
}

export function valueOf(o: SituatedObservation, policy: CountingPolicy): number {
  return policy === 'all' ? o.evidence_designation : designationOf(o)
}

// ---------------------------------------------------------------------------
// 3. Descriptive stats, with the small-n guardrail built into the type
// ---------------------------------------------------------------------------

/** Counts by designation; the index IS the designation. */
export type Distribution = readonly [number, number, number, number]

/** Below this many values, a mean is not a number worth printing on its own. */
export const MIN_N_FOR_MEAN = 3

/**
 * A designation at or below this is "at risk". Matches the mentoring trigger
 * (MentoringConversation fires on a confirmed 0 or 1), so the dashboard's idea
 * of trouble and the app's idea of trouble are the same idea.
 */
export const AT_RISK_MAX = 1

export interface DesignationStats {
  n: number
  dist: Distribution
  /**
   * Arithmetic mean; null only when n === 0. Correct to compute over, which is
   * why the leniency delta uses it on cells of one or two observations.
   */
  mean: number | null
  /**
   * The mean it is honest to PRINT: null when lowN. Render this one. Showing
   * "2.0" off a single observation invites a reader to treat one person's note
   * as a cohort finding, and on this dataset that is the common case, not the
   * edge case.
   */
  reportableMean: number | null
  /** Midpoint. On even n the LOWER middle: 2.5 is not a designation. */
  median: number | null
  min: number | null
  max: number | null
  /** n < MIN_N_FOR_MEAN. Callers must show the n and must not rank on the mean. */
  lowN: boolean
  /** How many values are at or below AT_RISK_MAX. The honest thing to sort on. */
  atRisk: number
}

export const EMPTY_STATS: DesignationStats = {
  n: 0,
  dist: [0, 0, 0, 0],
  mean: null,
  reportableMean: null,
  median: null,
  min: null,
  max: null,
  lowN: true,
  atRisk: 0,
}

export function designationStats(values: number[]): DesignationStats {
  if (values.length === 0) return EMPTY_STATS
  const sorted = [...values].sort((a, b) => a - b)
  const dist: [number, number, number, number] = [0, 0, 0, 0]
  let atRisk = 0
  for (const v of sorted) {
    const i = Math.max(0, Math.min(3, Math.round(v)))
    dist[i]++
    if (v <= AT_RISK_MAX) atRisk++
  }
  const n = sorted.length
  const mean = sorted.reduce((a, b) => a + b, 0) / n
  const lowN = n < MIN_N_FOR_MEAN
  return {
    n,
    dist,
    mean,
    reportableMean: lowN ? null : mean,
    // Lower middle on even n, so the result is always an achievable designation.
    median: sorted[n % 2 === 1 ? (n - 1) / 2 : n / 2 - 1],
    min: sorted[0],
    max: sorted[n - 1],
    lowN,
    atRisk,
  }
}

/** Sample standard deviation. Null below two values, where it is undefined. */
function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null
  const m = values.reduce((a, b) => a + b, 0) / values.length
  const ss = values.reduce((a, b) => a + (b - m) * (b - m), 0)
  return Math.sqrt(ss / (values.length - 1))
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// 4. Per-activity (the event view)
// ---------------------------------------------------------------------------

export interface ParticipantValue {
  participant_id: string | null
  participant_name: string
  /** The MAX of their counting observations on this area, mirroring build.ts. */
  value: number
  observationIds: string[]
}

export interface ActivityKsaCell {
  ksa_code: string
  area: string
  short_label: string
  /** over raw observations in this event, not over participant representatives */
  stats: DesignationStats
  /**
   * One row per participant observed on this area in this event, rolled up the
   * same way a report rolls one up: the max of their counting observations.
   *
   * This is the right denominator for any "how many of the group" question.
   * Counting observations instead would let one participant with four low notes
   * on the same area read as four people, which is precisely the inference the
   * event digest's pattern threshold exists to support.
   */
  byParticipant: ParticipantValue[]
  /** The subset of byParticipant at or below the at-risk ceiling, worst first. */
  weak: ParticipantValue[]
}

export interface ActivityFlag {
  participant_id: string | null
  participant_name: string
  lowest: number
  ksaCodes: string[]
  /** the drill-down target */
  observationIds: string[]
}

export interface ActivityAnalytics {
  activity_id: string
  title: string
  day: string | null
  genre_group: string | null
  captureCount: number
  submittedCaptureCount: number
  routedCaptureCount: number
  /** captures for this activity that produced no observations yet */
  unroutedCaptures: number
  evaluators: string[]
  participantsObserved: number
  observationCount: number
  /** every KSA passed in, including those with no evidence */
  perKsa: ActivityKsaCell[]
  overall: DesignationStats
  /** participants with at least one at-risk value in THIS event, worst first */
  flagged: ActivityFlag[]
}

export function activityAnalytics(
  activity: Activity,
  ksas: Ksa[],
  situated: SituatedObservation[],
  evaluations: EvaluationRecord[],
  opts?: { policy?: CountingPolicy; atRiskMax?: number },
): ActivityAnalytics {
  const policy = opts?.policy ?? 'counting'
  const atRiskMax = opts?.atRiskMax ?? AT_RISK_MAX

  const mine = situated.filter((o) => o.activity_id === activity.id && countsToward(o, policy))
  const captures = evaluations.filter((e) => e.activity_id === activity.id)
  const capturesWithObs = new Set(
    situated.filter((o) => o.activity_id === activity.id).map((o) => o.capture_client_id),
  )

  const byKsa = new Map<string, SituatedObservation[]>()
  for (const o of mine) {
    const list = byKsa.get(o.ksa_code) ?? []
    list.push(o)
    byKsa.set(o.ksa_code, list)
  }

  const perKsa: ActivityKsaCell[] = ksas.map((k) => {
    const obs = byKsa.get(k.code) ?? []

    // Roll up to one value per participant before anything counts people. An
    // unattributed observation keys on its name so it still surfaces rather
    // than collapsing every unattributed row into one phantom participant.
    const pMap = new Map<string, ParticipantValue>()
    for (const o of obs) {
      const key = o.participant_id ?? `name::${o.participant_name}`
      const v = valueOf(o, policy)
      const existing = pMap.get(key)
      if (existing) {
        existing.value = Math.max(existing.value, v)
        existing.observationIds.push(o.id)
      } else {
        pMap.set(key, {
          participant_id: o.participant_id,
          participant_name: o.participant_name,
          value: v,
          observationIds: [o.id],
        })
      }
    }
    const byParticipant = [...pMap.values()].sort(
      (a, b) => a.value - b.value || a.participant_name.localeCompare(b.participant_name),
    )

    return {
      ksa_code: k.code,
      area: k.area,
      short_label: k.short_label || k.code,
      stats: designationStats(obs.map((o) => valueOf(o, policy))),
      byParticipant,
      weak: byParticipant.filter((p) => p.value <= atRiskMax),
    }
  })

  // Flagged participants: keyed by id where we have one, else by name, so an
  // unattributed observation still surfaces instead of collapsing into one blob.
  const flagMap = new Map<string, ActivityFlag>()
  for (const o of mine) {
    const v = valueOf(o, policy)
    if (v > atRiskMax) continue
    const key = o.participant_id ?? `name::${o.participant_name}`
    const existing = flagMap.get(key)
    if (existing) {
      existing.lowest = Math.min(existing.lowest, v)
      if (!existing.ksaCodes.includes(o.ksa_code)) existing.ksaCodes.push(o.ksa_code)
      existing.observationIds.push(o.id)
    } else {
      flagMap.set(key, {
        participant_id: o.participant_id,
        participant_name: o.participant_name,
        lowest: v,
        ksaCodes: [o.ksa_code],
        observationIds: [o.id],
      })
    }
  }

  const evaluators = [
    ...new Set(mine.map((o) => o.evaluator ?? UNKNOWN_EVALUATOR)),
  ].sort((a, b) =>
    // the unknown bucket sorts last, never interleaved with real people
    a === UNKNOWN_EVALUATOR ? 1 : b === UNKNOWN_EVALUATOR ? -1 : a.localeCompare(b),
  )

  return {
    activity_id: activity.id,
    title: activity.title,
    day: activity.day,
    genre_group: activity.genre_group,
    captureCount: captures.length,
    submittedCaptureCount: captures.filter((e) => e.attestation).length,
    routedCaptureCount: captures.filter((e) => e.routing_status === 'routed').length,
    unroutedCaptures: captures.filter((e) => !capturesWithObs.has(e.client_id)).length,
    evaluators,
    participantsObserved: new Set(
      mine.map((o) => o.participant_id ?? `name::${o.participant_name}`),
    ).size,
    observationCount: mine.length,
    perKsa,
    overall: designationStats(mine.map((o) => valueOf(o, policy))),
    flagged: [...flagMap.values()].sort(
      (a, b) => a.lowest - b.lowest || b.observationIds.length - a.observationIds.length,
    ),
  }
}

export function allActivityAnalytics(
  activities: Activity[],
  ksas: Ksa[],
  situated: SituatedObservation[],
  evaluations: EvaluationRecord[],
  opts?: { policy?: CountingPolicy; atRiskMax?: number },
): ActivityAnalytics[] {
  return activities.map((a) => activityAnalytics(a, ksas, situated, evaluations, opts))
}

// ---------------------------------------------------------------------------
// 5. Per-participant risk
// ---------------------------------------------------------------------------

export type RiskReason =
  | { kind: 'low_representative'; ksa_code: string; value: number }
  | { kind: 'conflict'; ksa_code: string; lo: number; hi: number }
  | { kind: 'disputed'; count: number }
  | { kind: 'thin_coverage'; evidenced: number; total: number }
  | { kind: 'no_evidence' }

export interface FlaggedParticipant {
  participant_id: string
  participant_name: string
  team_name: string | null
  reasons: RiskReason[]
  /**
   * ORDERING KEY ONLY. Never rendered, never labelled, never exported. The
   * moment a number like this reaches the screen a reader treats it as a rating
   * of a person, which is precisely what this app exists not to do.
   */
  severity: number
  lowestRepresentative: number | null
  evidencedKsas: number
  totalKsas: number
  gate: Gate | null
}

function severityOf(reason: RiskReason): number {
  switch (reason.kind) {
    case 'low_representative':
      return 10 - 3 * reason.value
    case 'conflict':
      return 4
    case 'disputed':
      return 3
    case 'thin_coverage':
      return 2
    case 'no_evidence':
      return 1
  }
}

export function flagParticipants(
  reports: ParticipantReport<AnnotatedObservation>[],
  gates: Map<string, Gate>,
  opts?: { atRiskMax?: number; coverageFloor?: number },
): FlaggedParticipant[] {
  const atRiskMax = opts?.atRiskMax ?? AT_RISK_MAX
  const coverageFloor = opts?.coverageFloor ?? 0.4

  const out: FlaggedParticipant[] = []
  for (const r of reports) {
    const reasons: RiskReason[] = []
    let lowest: number | null = null

    for (const k of r.ksaRollups) {
      if (k.representative !== null) {
        lowest = lowest === null ? k.representative : Math.min(lowest, k.representative)
        if (k.representative <= atRiskMax) {
          reasons.push({ kind: 'low_representative', ksa_code: k.ksa_code, value: k.representative })
        }
      }
      if (k.conflict && k.designations.length > 1) {
        reasons.push({
          kind: 'conflict',
          ksa_code: k.ksa_code,
          lo: k.designations[0],
          hi: k.designations[k.designations.length - 1],
        })
      }
    }

    const disputed = r.ksaRollups.reduce(
      (n, k) => n + k.toVerify.filter((o) => o.vstatus === 'disputed').length,
      0,
    )
    if (disputed > 0) reasons.push({ kind: 'disputed', count: disputed })

    const { evidencedKsas, totalKsas } = r.totals
    if (totalKsas > 0 && evidencedKsas === 0) {
      reasons.push({ kind: 'no_evidence' })
    } else if (totalKsas > 0 && evidencedKsas / totalKsas < coverageFloor) {
      reasons.push({ kind: 'thin_coverage', evidenced: evidencedKsas, total: totalKsas })
    }

    if (reasons.length === 0) continue

    out.push({
      participant_id: r.participant_id,
      participant_name: r.participant_name,
      team_name: r.team_name,
      reasons,
      severity: Math.max(...reasons.map(severityOf)),
      lowestRepresentative: lowest,
      evidencedKsas,
      totalKsas,
      gate: gates.get(r.participant_id) ?? null,
    })
  }

  return out.sort(
    (a, b) => b.severity - a.severity || a.participant_name.localeCompare(b.participant_name),
  )
}

// ---------------------------------------------------------------------------
// 6. Per-evaluator, including the paired leniency delta
// ---------------------------------------------------------------------------

export interface LeniencyCell {
  participant_id: string
  participant_name: string
  ksa_code: string
  /** this evaluator's mean on this (participant, KSA) */
  mine: number
  /** mean of every OTHER evaluator's mean on the same cell */
  others: number
  /** how many other evaluators contributed to `others` */
  peers: number
}

/** Below this many shared cells, no delta is reported at all. */
export const MIN_PAIRED_CELLS = 5

export interface LeniencyDelta {
  pairedCells: number
  /**
   * mean(mine - others) across paired cells. Positive = more generous than
   * peers. Null when pairedCells < MIN_PAIRED_CELLS.
   */
  delta: number | null
  suppressed: 'insufficient_overlap' | null
  /**
   * Spread of the per-cell differences. A large sd with a near-zero delta means
   * INCONSISTENT, which is a different and more actionable finding than lenient,
   * and one the delta alone hides completely.
   */
  sd: number | null
  /** the receipts, worst disagreement first */
  cells: LeniencyCell[]
}

export interface EvaluatorAnalytics {
  evaluator: string
  captureCount: number
  observationCount: number
  participantsCovered: number
  ksasCovered: number
  activities: { activity_id: string; title: string; n: number }[]
  topParticipants: { participant_id: string | null; participant_name: string; n: number }[]
  /**
   * Raw mean given. CONFOUNDED by which participants this evaluator happened to
   * observe: someone who only watched the strongest cohort looks generous and
   * someone assigned the strugglers looks harsh. The UI must label it
   * "unadjusted" and place `leniency` beside it.
   */
  given: DesignationStats
  leniency: LeniencyDelta
  verdicts: { confirm: number; adjust: number; reject: number; total: number }
  /** verdicts cast on other evaluators' observations: the review workload */
  verdictsOnOthers: number
  firstAt: string | null
  lastAt: string | null
}

const EMPTY_LENIENCY: LeniencyDelta = {
  pairedCells: 0,
  delta: null,
  suppressed: 'insufficient_overlap',
  sd: null,
  cells: [],
}

export function evaluatorAnalytics(
  situated: SituatedObservation[],
  verdicts: VerificationVerdict[],
  evaluations: EvaluationRecord[],
  activities: Activity[],
  opts?: { policy?: CountingPolicy; minPairedCells?: number },
): EvaluatorAnalytics[] {
  // An evaluator's own behaviour is described with 'all': a rejected observation
  // is still something they said.
  const policy = opts?.policy ?? 'all'
  const minPaired = opts?.minPairedCells ?? MIN_PAIRED_CELLS

  const counted = situated.filter((o) => countsToward(o, policy))
  const activityTitle = new Map(activities.map((a) => [a.id, a.title]))
  const obsOwner = new Map(situated.map((o) => [o.id, o.evaluator ?? UNKNOWN_EVALUATOR]))

  // --- the paired-cell structure, built once for everyone -------------------
  // cell key -> evaluator -> their values on that (participant, KSA)
  const cells = new Map<string, { participant_name: string; byEvaluator: Map<string, number[]> }>()
  for (const o of counted) {
    if (o.participant_id === null) continue // an unattributed obs has no comparable cell
    const key = `${o.participant_id}::${o.ksa_code}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { participant_name: o.participant_name, byEvaluator: new Map() }
      cells.set(key, cell)
    }
    const who = o.evaluator ?? UNKNOWN_EVALUATOR
    const list = cell.byEvaluator.get(who) ?? []
    list.push(valueOf(o, policy))
    cell.byEvaluator.set(who, list)
  }

  const names = [...new Set(counted.map((o) => o.evaluator ?? UNKNOWN_EVALUATOR))].sort((a, b) =>
    a === UNKNOWN_EVALUATOR ? 1 : b === UNKNOWN_EVALUATOR ? -1 : a.localeCompare(b),
  )

  return names.map((who) => {
    const mine = counted.filter((o) => (o.evaluator ?? UNKNOWN_EVALUATOR) === who)
    const myCaptures = evaluations.filter((e) => (e.evaluator_email ?? UNKNOWN_EVALUATOR) === who)

    const byActivity = new Map<string, number>()
    for (const o of mine) {
      if (!o.activity_id) continue
      byActivity.set(o.activity_id, (byActivity.get(o.activity_id) ?? 0) + 1)
    }
    const byParticipant = new Map<string, { participant_id: string | null; participant_name: string; n: number }>()
    for (const o of mine) {
      const key = o.participant_id ?? `name::${o.participant_name}`
      const cur = byParticipant.get(key)
      if (cur) cur.n++
      else
        byParticipant.set(key, {
          participant_id: o.participant_id,
          participant_name: o.participant_name,
          n: 1,
        })
    }

    // --- leniency: paired against peers on the SAME (participant, KSA) ------
    const paired: LeniencyCell[] = []
    for (const [key, cell] of cells) {
      const mineValues = cell.byEvaluator.get(who)
      if (!mineValues || cell.byEvaluator.size < 2) continue
      // Mean of per-evaluator means, so an evaluator who logged three
      // observations on a cell does not outweigh a peer who logged one.
      const otherMeans = [...cell.byEvaluator.entries()]
        .filter(([e]) => e !== who)
        .map(([, vs]) => mean(vs))
      if (otherMeans.length === 0) continue
      const [participant_id, ksa_code] = key.split('::')
      paired.push({
        participant_id,
        participant_name: cell.participant_name,
        ksa_code,
        mine: mean(mineValues),
        others: mean(otherMeans),
        peers: otherMeans.length,
      })
    }
    const diffs = paired.map((c) => c.mine - c.others)
    const enough = paired.length >= minPaired
    const leniency: LeniencyDelta = paired.length
      ? {
          pairedCells: paired.length,
          delta: enough ? mean(diffs) : null,
          suppressed: enough ? null : 'insufficient_overlap',
          sd: sampleSd(diffs),
          cells: paired.sort(
            (a, b) => Math.abs(b.mine - b.others) - Math.abs(a.mine - a.others),
          ),
        }
      : EMPTY_LENIENCY

    const myVerdicts = verdicts.filter((v) => v.evaluator_email === who)
    const times = mine.map((o) => o.captured_at).filter((t): t is string => t != null).sort()

    return {
      evaluator: who,
      captureCount: myCaptures.length,
      observationCount: mine.length,
      participantsCovered: byParticipant.size,
      ksasCovered: new Set(mine.map((o) => o.ksa_code)).size,
      activities: [...byActivity.entries()]
        .map(([activity_id, n]) => ({
          activity_id,
          title: activityTitle.get(activity_id) ?? activity_id,
          n,
        }))
        .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title)),
      topParticipants: [...byParticipant.values()].sort(
        (a, b) => b.n - a.n || a.participant_name.localeCompare(b.participant_name),
      ),
      given: designationStats(mine.map((o) => valueOf(o, policy))),
      leniency,
      verdicts: {
        confirm: myVerdicts.filter((v) => v.decision === 'confirm').length,
        adjust: myVerdicts.filter((v) => v.decision === 'adjust').length,
        reject: myVerdicts.filter((v) => v.decision === 'reject').length,
        total: myVerdicts.length,
      },
      verdictsOnOthers: myVerdicts.filter((v) => obsOwner.get(v.observation_id) !== who).length,
      firstAt: times[0] ?? null,
      lastAt: times[times.length - 1] ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// 7. Per-KSA, workshop-wide
// ---------------------------------------------------------------------------

export interface KsaDayPoint {
  day: string
  stats: DesignationStats
}

export interface KsaAnalytics {
  ksa_code: string
  area: string
  short_label: string
  /** one value per participant (the max rule from build.ts). The reported view. */
  representative: DesignationStats
  /** every counting observation. The evidence view. These WILL differ. */
  observed: DesignationStats
  participantsWithEvidence: number
  participantsTotal: number
  weakParticipants: { participant_id: string; participant_name: string; value: number }[]
  conflictCount: number
  /**
   * Chronological. Days with no data are OMITTED, never zero-filled: a
   * zero-filled gap on a 0-3 scale reads as "everyone scored 0".
   */
  byDay: KsaDayPoint[]
}

export function ksaAnalytics(
  ksas: Ksa[],
  participants: Participant[],
  reports: ParticipantReport<AnnotatedObservation>[],
  situated: SituatedObservation[],
  activities: Activity[],
  opts?: { policy?: CountingPolicy },
): KsaAnalytics[] {
  const policy = opts?.policy ?? 'counting'
  const activityDay = new Map(activities.map((a) => [a.id, a.day]))

  return ksas.map((k) => {
    const rollups = reports
      .map((r) => r.ksaRollups.find((x) => x.ksa_code === k.code))
      .filter((x): x is NonNullable<typeof x> => x != null)

    const reps: number[] = []
    const weak: { participant_id: string; participant_name: string; value: number }[] = []
    let conflictCount = 0
    reports.forEach((r) => {
      const roll = r.ksaRollups.find((x) => x.ksa_code === k.code)
      if (!roll) return
      if (roll.conflict) conflictCount++
      if (roll.representative === null) return
      reps.push(roll.representative)
      if (roll.representative <= AT_RISK_MAX) {
        weak.push({
          participant_id: r.participant_id,
          participant_name: r.participant_name,
          value: roll.representative,
        })
      }
    })

    const obs = situated.filter((o) => o.ksa_code === k.code && countsToward(o, policy))

    // byDay: prefer the activity's own day label, fall back to the capture date.
    const dayBuckets = new Map<string, number[]>()
    for (const o of obs) {
      const day =
        (o.activity_id ? activityDay.get(o.activity_id) : null) ??
        (o.captured_at ? o.captured_at.slice(0, 10) : null)
      if (!day) continue
      const list = dayBuckets.get(day) ?? []
      list.push(valueOf(o, policy))
      dayBuckets.set(day, list)
    }

    return {
      ksa_code: k.code,
      area: k.area,
      short_label: k.short_label || k.code,
      representative: designationStats(reps),
      observed: designationStats(obs.map((o) => valueOf(o, policy))),
      participantsWithEvidence: reps.length,
      participantsTotal: participants.length || rollups.length,
      weakParticipants: weak.sort((a, b) => a.value - b.value),
      conflictCount,
      byDay: [...dayBuckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, values]) => ({ day, stats: designationStats(values) })),
    }
  })
}

// ---------------------------------------------------------------------------
// 8. The participant x KSA heatmap
// ---------------------------------------------------------------------------

export interface HeatCell {
  participant_id: string
  ksa_code: string
  /** representative; null = no counting evidence. NULL IS NOT ZERO. */
  value: number | null
  conflict: boolean
  contributing: number
  toVerify: number
}

export type HeatSort = 'roster' | 'weakest' | 'team' | 'least-evidence'

export interface HeatmapMatrix {
  rows: {
    participant_id: string
    name: string
    team_name: string | null
    rowStats: DesignationStats
  }[]
  cols: { ksa_code: string; short_label: string; area: string; colStats: DesignationStats }[]
  /** [rowIdx][colIdx] */
  cells: HeatCell[][]
}

export function buildHeatmap(
  reports: ParticipantReport<AnnotatedObservation>[],
  ksas: Ksa[],
  opts?: { sort?: HeatSort },
): HeatmapMatrix {
  const sort = opts?.sort ?? 'roster'

  const built = reports.map((r) => {
    const cells: HeatCell[] = ksas.map((k) => {
      const roll = r.ksaRollups.find((x) => x.ksa_code === k.code)
      return {
        participant_id: r.participant_id,
        ksa_code: k.code,
        value: roll?.representative ?? null,
        conflict: roll?.conflict ?? false,
        contributing: roll?.contributing.length ?? 0,
        toVerify: roll?.toVerify.length ?? 0,
      }
    })
    const values = cells.map((c) => c.value).filter((v): v is number => v !== null)
    return {
      row: {
        participant_id: r.participant_id,
        name: r.participant_name,
        team_name: r.team_name,
        rowStats: designationStats(values),
      },
      cells,
    }
  })

  const ordered = [...built]
  if (sort === 'weakest') {
    // Most at-risk cells first. Sorting on the mean here would let a participant
    // with one 3 outrank one with six 2s, which is the opposite of useful.
    ordered.sort(
      (a, b) =>
        b.row.rowStats.atRisk - a.row.rowStats.atRisk ||
        (a.row.rowStats.mean ?? 99) - (b.row.rowStats.mean ?? 99) ||
        a.row.name.localeCompare(b.row.name),
    )
  } else if (sort === 'team') {
    ordered.sort(
      (a, b) =>
        (a.row.team_name ?? '~').localeCompare(b.row.team_name ?? '~') ||
        a.row.name.localeCompare(b.row.name),
    )
  } else if (sort === 'least-evidence') {
    ordered.sort((a, b) => a.row.rowStats.n - b.row.rowStats.n || a.row.name.localeCompare(b.row.name))
  }

  const cols = ksas.map((k, i) => ({
    ksa_code: k.code,
    short_label: k.short_label || k.code,
    area: k.area,
    colStats: designationStats(
      ordered.map((r) => r.cells[i].value).filter((v): v is number => v !== null),
    ),
  }))

  return { rows: ordered.map((r) => r.row), cols, cells: ordered.map((r) => r.cells) }
}

// ---------------------------------------------------------------------------
// 9. The one summary the sidebar and the overview both read
// ---------------------------------------------------------------------------

export interface WorkbenchSummary {
  reportsReady: number
  reportsLocked: number
  observationsPending: number
  observationsDisputed: number
  openDiscrepancies: number
  conversationsNeeded: number
  /** excluded from every report until a human attributes them */
  unattributedObservations: number
  /** evidence captured but not yet through routing */
  capturesNotRouted: number
  /** observations naming a capture this device has never seen */
  orphanedCaptures: number
}

export function workbenchSummary(input: {
  reports: ParticipantReport<AnnotatedObservation>[]
  gates: Map<string, Gate>
  situated: SituatedObservation[]
  discrepancies: Discrepancy[]
  resolutions: DiscrepancyResolution[]
  conversations: MentoringConversation[]
  evaluations: EvaluationRecord[]
}): WorkbenchSummary {
  const { reports, gates, situated, discrepancies, resolutions, conversations, evaluations } = input
  const resolved = new Set(resolutions.map((r) => r.id))
  const health = attributionHealth(situated)

  let ready = 0
  let locked = 0
  for (const r of reports) {
    const gate = gates.get(r.participant_id)
    if (!gate || gate.total === 0) continue
    if (gate.status === 'ready') ready++
    else locked++
  }

  return {
    reportsReady: ready,
    reportsLocked: locked,
    observationsPending: situated.filter((o) => o.vstatus === 'pending').length,
    observationsDisputed: situated.filter((o) => o.vstatus === 'disputed').length,
    openDiscrepancies: discrepancies.filter(
      (d) => !resolved.has(discrepancyId(d.participant_id, d.ksa_code)),
    ).length,
    conversationsNeeded: conversations.filter((c) => c.status === 'needed').length,
    unattributedObservations: health.unattributedParticipant,
    capturesNotRouted: evaluations.filter((e) => e.attestation && e.routing_status !== 'routed')
      .length,
    orphanedCaptures: health.orphanedCaptures.length,
  }
}
