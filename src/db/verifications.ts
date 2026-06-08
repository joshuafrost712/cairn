import { db } from './local'
import type { ObservationRecord, VerificationDecision, VerificationVerdict } from '../lib/types'

// Record/clear one evaluator's verdict on one observation. Keyed by
// `${observation_id}::${evaluator_email}` so re-recording overwrites that
// evaluator's prior verdict (one current verdict per evaluator per observation).

const verdictId = (observationId: string, evaluatorEmail: string) => `${observationId}::${evaluatorEmail}`

export async function recordVerdict(
  observation: ObservationRecord,
  evaluatorEmail: string,
  decision: VerificationDecision,
  opts: { adjusted_designation?: 0 | 1 | 2 | 3 | null; note?: string | null } = {},
): Promise<void> {
  const verdict: VerificationVerdict = {
    id: verdictId(observation.id, evaluatorEmail),
    observation_id: observation.id,
    capture_client_id: observation.capture_client_id,
    evaluator_email: evaluatorEmail,
    decision,
    adjusted_designation: decision === 'adjust' ? (opts.adjusted_designation ?? null) : null,
    note: opts.note ?? null,
    at: new Date().toISOString(),
  }
  await db.verifications.put(verdict)
}

export async function clearVerdict(observationId: string, evaluatorEmail: string): Promise<void> {
  await db.verifications.delete(verdictId(observationId, evaluatorEmail))
}

export function getAllVerdicts() {
  return db.verifications.toArray()
}
