// Discrepancy detection — pure functions, no IO.
//
// A "discrepancy" occurs when two or more evaluators scored the same participant
// on the same KSA and their designations span ≥2 on the 0–3 scale (i.e. the
// `conflict` flag that build.ts sets is true). This module surfaces those into a
// structured object the Inbox page renders and the email renderer uses.

import type { EvaluationRecord } from '../lib/types'
import type { AnnotatedObservation } from './verification'
import type { ParticipantReport } from './build'

// How far apart (in hours) capture timestamps must be before we call out the
// time gap as a possible explanation for the discrepancy.
const TIME_GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000 // 4 hours

export interface Discrepancy {
  participant_id: string
  participant_name: string
  ksa_code: string
  area: string
  /** Lowest designation among the conflicting counting observations. */
  lo: number
  /** Highest designation among the conflicting counting observations. */
  hi: number
  /** All counting observations that contributed to this KSA rollup. */
  observations: AnnotatedObservation[]
  /** Span in ms between earliest and latest capture_client_id creation time, or null when <2 times are known. */
  timeGapMs: number | null
  /** Human-readable note when the gap is ≥ TIME_GAP_THRESHOLD_MS. */
  timeGapNote: string | null
}

/**
 * Build a Map<capture_client_id, created_at ISO string> from the evaluations
 * table so we can compute the time span between conflicting captures.
 */
export function buildCaptureTimeMap(evaluations: EvaluationRecord[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of evaluations) {
    m.set(e.client_id, e.created_at)
  }
  return m
}

/**
 * Walk every participant report and every conflicting KSA rollup, and emit
 * one Discrepancy per (participant, KSA) pair where `conflict === true`.
 */
export function findDiscrepancies(
  reports: ParticipantReport<AnnotatedObservation>[],
  captureTimes: Map<string, string>,
): Discrepancy[] {
  const result: Discrepancy[] = []

  for (const report of reports) {
    for (const rollup of report.ksaRollups) {
      if (!rollup.conflict) continue

      const lo = rollup.designations[0]
      const hi = rollup.designations[rollup.designations.length - 1]

      // Compute time gap across the contributing observations.
      const timestamps: number[] = []
      for (const o of rollup.contributing) {
        const raw = captureTimes.get(o.capture_client_id)
        if (raw) {
          const t = Date.parse(raw)
          if (Number.isFinite(t)) timestamps.push(t)
        }
      }

      let timeGapMs: number | null = null
      let timeGapNote: string | null = null
      if (timestamps.length >= 2) {
        const earliest = Math.min(...timestamps)
        const latest = Math.max(...timestamps)
        timeGapMs = latest - earliest
        if (timeGapMs >= TIME_GAP_THRESHOLD_MS) {
          const hours = Math.round(timeGapMs / (60 * 60 * 1000))
          timeGapNote = `Observations were captured ${hours} hour${hours === 1 ? '' : 's'} apart; they may reflect different moments in the activity.`
        }
      }

      result.push({
        participant_id: report.participant_id,
        participant_name: report.participant_name,
        ksa_code: rollup.ksa_code,
        area: rollup.area,
        lo,
        hi,
        observations: rollup.contributing,
        timeGapMs,
        timeGapNote,
      })
    }
  }

  return result
}

/** Deterministic id used both for the Dexie key and dedup checks. */
export function discrepancyId(participantId: string, ksaCode: string): string {
  return `disc::${participantId}::${ksaCode}`
}
