import { pickWorkshopId } from './sync'

/**
 * The tl-04 Dexie v11 backfill, as pure logic.
 *
 * This is the desktop half of the phone-evaluations recovery, and it is the only
 * part of it that can be tested without a real device holding a real v10
 * database. Marking every existing row 'local' is what makes the first sync cycle
 * push the entire pilot history to the backend, so "one private database" becomes
 * true retroactively rather than only for work captured from today.
 *
 * Kept separate from the `.modify()` calls that apply it because a wrong answer
 * here is invisible: a row that ends up with a null workshop is a row that can
 * never be shared, which is the exact failure the spec exists to remove.
 */

export interface BackfillInputs {
  observations: Array<{ id: string; capture_client_id: string; participant_id: string | null }>
  verdicts: Array<{ id: string; observation_id: string }>
  /** capture client_id -> workshop_id, from the local evaluations. */
  captureWorkshops: Map<string, string | null>
  /** participant id -> workshop_id, from the local roster cache. */
  participantWorkshops: Map<string, string | null>
  /** This device's active workshop, the last resort. */
  activeWorkshopId: string | null
}

export interface BackfillResult {
  /** observation id -> the workshop it belongs to (null when unresolvable). */
  observationWorkshops: Map<string, string | null>
  /** verdict id -> the workshop of the observation it is about. */
  verdictWorkshops: Map<string, string | null>
  /** How many observations could not be placed, so a caller can report it. */
  unresolved: number
}

export function planBackfill(inputs: BackfillInputs): BackfillResult {
  const observationWorkshops = new Map<string, string | null>()
  let unresolved = 0
  for (const o of inputs.observations) {
    const ws = pickWorkshopId(
      inputs.captureWorkshops.get(o.capture_client_id),
      o.participant_id ? [inputs.participantWorkshops.get(o.participant_id)] : [],
      inputs.activeWorkshopId,
    )
    if (!ws) unresolved++
    observationWorkshops.set(o.id, ws)
  }

  const verdictWorkshops = new Map<string, string | null>()
  for (const v of inputs.verdicts) {
    // A verdict inherits its observation's workshop rather than being resolved
    // independently. The two must agree or the backend refuses the verdict, and
    // resolving twice from the same three sources is two chances to disagree.
    verdictWorkshops.set(v.id, observationWorkshops.get(v.observation_id) ?? null)
  }

  return { observationWorkshops, verdictWorkshops, unresolved }
}
