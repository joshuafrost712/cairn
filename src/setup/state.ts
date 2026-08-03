import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import type { WorkshopState } from './impact'

/**
 * Where a workshop is in its life. The classifier's blanket rule depends on it, so
 * the derivation is pure and tested rather than inferred at each call site.
 *
 * Submitted evaluations come FIRST and dates second, deliberately. A workshop whose
 * calendar says it started but where nobody has captured anything is still safely
 * editable, and treating it as in progress would fire a warning layer over an empty
 * database — which is how admins learn to click through warnings. Conversely a
 * workshop whose end date has passed still holds evidence people are reading, so
 * `closed` is a real state rather than "nothing matters any more".
 *
 * "Submitted" means `attestation === true`, the same test db/coverage.ts uses to
 * decide a capture counts. A draft capture sitting half-typed on somebody's phone
 * is not work that a setup edit can invalidate.
 */
export function deriveWorkshopState(input: {
  submittedEvaluations: number
  endDate: string | null
  /** ISO date or datetime; injected so the derivation is testable. */
  now: string
}): WorkshopState {
  if (input.submittedEvaluations <= 0) return 'draft'
  if (input.endDate && endOfDay(input.endDate) < input.now) return 'closed'
  return 'in_progress'
}

/**
 * An end DATE means the end of that day, not midnight at its start.
 *
 * Same trap as the git `--since=DAY` one: a bare date compares as 00:00:00, so a
 * workshop ending today would read as closed all day. Being wrong here means the
 * final afternoon of every workshop gets the closed-workshop warning on every save.
 */
function endOfDay(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999Z` : date
}

/** Count of submitted (attested) captures in a workshop. */
export async function submittedEvaluationCount(workshopId: string): Promise<number> {
  const rows = await db.evaluations.where('workshop_id').equals(workshopId).toArray()
  return rows.filter((e) => e.attestation === true).length
}

export async function readWorkshopState(workshopId: string | null): Promise<WorkshopState> {
  if (!workshopId) return 'draft'
  const [submitted, workshop] = await Promise.all([
    submittedEvaluationCount(workshopId),
    db.workshops.get(workshopId),
  ])
  return deriveWorkshopState({
    submittedEvaluations: submitted,
    endDate: workshop?.end_date ?? null,
    now: new Date().toISOString(),
  })
}

/**
 * Live workshop state for the Setup surfaces.
 *
 * Defaults to `in_progress` while the query is in flight, not `draft`: an
 * unresolved read must not be the reason a destructive change saves without a
 * warning. Erring toward one unnecessary dialog on a cold start is the cheap
 * direction to be wrong in.
 */
export function useWorkshopState(workshopId: string | null): WorkshopState {
  return (
    useLiveQuery(() => readWorkshopState(workshopId), [workshopId], 'in_progress' as WorkshopState) ??
    'in_progress'
  )
}
