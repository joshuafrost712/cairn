import { db } from './local'
import { pushVerdicts } from './sync'
import { scaleForWorkshop } from './scale'
import { isValidDesignation } from '../lib/scale'
import type { ObservationRecord, VerificationDecision, VerificationVerdict } from '../lib/types'

// Record/clear one evaluator's verdict on one observation. Keyed by
// `${observation_id}::${evaluator_email}` so re-recording overwrites that
// evaluator's prior verdict (one current verdict per evaluator per observation).
//
// Since tl-04 a verdict is a synced record: written to Dexie immediately, marked
// 'local', then pushed. The Dexie write is awaited and the push is not, matching
// db/assignments.ts, so recording a verdict is exactly as fast offline as on and
// the caller never waits on a network round trip. The push is also NOT the only
// one that will happen: the 30-second loop retries whatever this one could not
// send, which is what makes fire-and-forget safe here.

const verdictId = (observationId: string, evaluatorEmail: string) => `${observationId}::${evaluatorEmail}`

export async function recordVerdict(
  observation: ObservationRecord,
  evaluatorEmail: string,
  decision: VerificationDecision,
  opts: { adjusted_designation?: number | null; note?: string | null } = {},
): Promise<void> {
  const id = verdictId(observation.id, evaluatorEmail)
  // A BOUNDARY (tl-09). `adjusted_designation` was `0 | 1 | 2 | 3 | null` and the
  // compiler kept a foreign value out; it is a plain number now, so the check has
  // to be made rather than assumed. Resolved against the OBSERVATION's workshop,
  // not the active one: verifying is done from a queue that can outlive a
  // workshop switch, and validating against the wrong scale would either reject a
  // legitimate adjustment or admit a number this workshop cannot label.
  if (decision === 'adjust' && opts.adjusted_designation != null) {
    const scale = await scaleForWorkshop(observation.workshop_id ?? null)
    if (!isValidDesignation(opts.adjusted_designation, scale)) {
      throw new Error(
        `${opts.adjusted_designation} is not a point on this workshop's scale`,
      )
    }
  }
  const verdict: VerificationVerdict = {
    id,
    observation_id: observation.id,
    capture_client_id: observation.capture_client_id,
    workshop_id: observation.workshop_id ?? null,
    evaluator_email: evaluatorEmail,
    decision,
    adjusted_designation: decision === 'adjust' ? (opts.adjusted_designation ?? null) : null,
    note: opts.note ?? null,
    at: new Date().toISOString(),
    sync_status: 'local',
    sync_error: null,
  }
  await db.transaction('rw', [db.verifications, db.verdictTombstones], async () => {
    await db.verifications.put(verdict)
    // Re-verifying after withdrawing cancels the withdrawal. Leaving the
    // tombstone in place would have the next sync cycle delete the verdict that
    // was just recorded.
    await db.verdictTombstones.delete(id)
  })
  void pushVerdicts()
}

/**
 * Withdraw this evaluator's verdict.
 *
 * The tombstone is what makes withdrawal survive being offline. Delete the local
 * row alone and the server still holds the verdict, so the next pull restores it
 * and the evaluator's un-verify is silently reversed — the failure is invisible
 * precisely because the restored row looks exactly like a verdict they meant to
 * leave. A tombstone is only written for a verdict that could have reached the
 * backend; one that never left the device has nothing to withdraw.
 */
export async function clearVerdict(observationId: string, evaluatorEmail: string): Promise<void> {
  const id = verdictId(observationId, evaluatorEmail)
  await db.transaction('rw', [db.verifications, db.verdictTombstones], async () => {
    const existing = await db.verifications.get(id)
    await db.verifications.delete(id)
    if (existing && existing.sync_status !== 'local') {
      await db.verdictTombstones.put({
        id,
        workshop_id: existing.workshop_id ?? null,
        evaluator_email: existing.evaluator_email,
        at: new Date().toISOString(),
        sync_status: 'local',
        sync_error: null,
      })
    }
  })
  void pushVerdicts()
}

export function getAllVerdicts() {
  return db.verifications.toArray()
}
