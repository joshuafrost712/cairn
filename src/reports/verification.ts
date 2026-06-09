// The multi-evaluator verification gate — pure logic, no IO. Turns evaluator
// verdicts into a per-observation status and a per-participant gate, so a report
// cannot be finalized while the evidence behind it is unconfirmed or disputed.
//
// A designation counts toward a *finalized* report only once at least N evaluators
// have confirmed it (REQUIRED_CONFIRMATIONS, default 2; set VITE_REQUIRED_CONFIRMATIONS=1
// for a solo deployment). Any reject, or confirmations that disagree on the value,
// marks the observation disputed and blocks the gate until a human resolves it.

import type { ObservationRecord, VerificationVerdict } from '../lib/types'

const REQUIRED_KEY = 'cairn.required_confirmations'

function envDefault(): number {
  const raw = typeof import.meta !== 'undefined' ? Number((import.meta as { env?: Record<string, string> }).env?.VITE_REQUIRED_CONFIRMATIONS) : NaN
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2
}

/**
 * How many evaluators must confirm an observation. Runtime-configurable on-device
 * (localStorage), falling back to VITE_REQUIRED_CONFIRMATIONS, then 2. Read live so
 * a change takes effect without a rebuild.
 */
export function getRequiredConfirmations(): number {
  try {
    const stored = Number(localStorage.getItem(REQUIRED_KEY))
    if (Number.isFinite(stored) && stored >= 1) return Math.floor(stored)
  } catch {
    /* no localStorage (e.g. tests) */
  }
  return envDefault()
}

export function setRequiredConfirmations(n: number): void {
  localStorage.setItem(REQUIRED_KEY, String(Math.max(1, Math.floor(n))))
}

export type VerificationStatus = 'pending' | 'verified' | 'adjusted' | 'disputed'

export interface AnnotatedObservation extends ObservationRecord {
  vstatus: VerificationStatus
  /** the designation a finalized report should use (adjusted value when agreed) */
  effective_designation: 0 | 1 | 2 | 3
  confirmCount: number
  rejectCount: number
  verdicts: VerificationVerdict[]
}

/** Status of one observation given its verdicts. */
export function observationStatus(
  obs: ObservationRecord,
  verdicts: VerificationVerdict[],
): { status: VerificationStatus; effective_designation: 0 | 1 | 2 | 3; confirmCount: number; rejectCount: number } {
  const rejects = verdicts.filter((v) => v.decision === 'reject')
  const confirms = verdicts.filter((v) => v.decision === 'confirm' || v.decision === 'adjust')
  // What each confirming evaluator thinks the designation should be.
  const intended = confirms.map((v) =>
    v.decision === 'adjust' && v.adjusted_designation != null ? v.adjusted_designation : obs.evidence_designation,
  )

  if (rejects.length > 0) {
    return { status: 'disputed', effective_designation: obs.evidence_designation, confirmCount: confirms.length, rejectCount: rejects.length }
  }
  if (confirms.length < getRequiredConfirmations()) {
    return { status: 'pending', effective_designation: obs.evidence_designation, confirmCount: confirms.length, rejectCount: 0 }
  }
  const allAgree = intended.every((d) => d === intended[0])
  if (!allAgree) {
    return { status: 'disputed', effective_designation: obs.evidence_designation, confirmCount: confirms.length, rejectCount: 0 }
  }
  const agreed = intended[0]
  return {
    status: agreed === obs.evidence_designation ? 'verified' : 'adjusted',
    effective_designation: agreed,
    confirmCount: confirms.length,
    rejectCount: 0,
  }
}

/** Attach verification status to each observation. */
export function annotateObservations(
  observations: ObservationRecord[],
  verdicts: VerificationVerdict[],
): AnnotatedObservation[] {
  const byObs = new Map<string, VerificationVerdict[]>()
  for (const v of verdicts) {
    const list = byObs.get(v.observation_id) ?? []
    list.push(v)
    byObs.set(v.observation_id, list)
  }
  return observations.map((o) => {
    const vs = byObs.get(o.id) ?? []
    const s = observationStatus(o, vs)
    return { ...o, vstatus: s.status, effective_designation: s.effective_designation, confirmCount: s.confirmCount, rejectCount: s.rejectCount, verdicts: vs }
  })
}

export interface Gate {
  status: 'locked' | 'ready'
  total: number
  verified: number
  pending: number
  disputed: number
  required: number
}

/**
 * A participant's gate. Ready only when there is at least one observation and
 * every one of them is verified/adjusted (nothing pending, nothing disputed).
 */
export function participantGate(annotated: AnnotatedObservation[]): Gate {
  const total = annotated.length
  const verified = annotated.filter((o) => o.vstatus === 'verified' || o.vstatus === 'adjusted').length
  const pending = annotated.filter((o) => o.vstatus === 'pending').length
  const disputed = annotated.filter((o) => o.vstatus === 'disputed').length
  return {
    status: total > 0 && pending === 0 && disputed === 0 ? 'ready' : 'locked',
    total,
    verified,
    pending,
    disputed,
    required: getRequiredConfirmations(),
  }
}
