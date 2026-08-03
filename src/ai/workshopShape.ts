import { db } from '../db/local'
import { activitiesForWorkshop, ksasForActivity } from '../db/reference'
import { scaleForWorkshop } from '../db/scale'
import { renderRubricDoc, renderRosterDoc } from './workspace'
import { EMPTY_SHAPE, type WorkshopShape } from './estimate'
import type { AiCallLogEntry } from '../lib/types'

/**
 * The workshop's shape, read from this device's store (tl-14).
 *
 * The impure counterpart to `estimate.ts`: everything that touches Dexie lives here,
 * so the estimator itself stays a function of its arguments and the test suite can
 * check its arithmetic without a database. The split is the same one `lib/scale.ts`
 * has with `db/scale.ts`.
 *
 * THE RUBRIC AND ROSTER ARE MEASURED, NOT ESTIMATED, and that is the point of this
 * module existing at all. Every capture carries both documents — that is
 * `buildCaptureFile`'s design, which is what makes a self-contained capture routable
 * on its own — so they dominate the input side of routing at any realistic capture
 * length. Guessing them would have made the largest term in the estimate the least
 * grounded one. Here they are rendered with the same functions the real routing pass
 * uses and their actual length is counted, so a workshop with 6 questions and a
 * workshop with 40 get honestly different numbers.
 */

/**
 * Read one workshop's shape.
 *
 * Never throws: a workshop with nothing in it returns `EMPTY_SHAPE` and the estimator
 * returns zeros, which is the right answer rather than an error. An administrator
 * opening the AI section of a workshop they have only just created should see "not
 * enough of a workshop to estimate yet", not a stack trace.
 */
export async function deriveWorkshopShape(workshopId: string | null): Promise<WorkshopShape> {
  if (!workshopId) return EMPTY_SHAPE

  const [activities, participants, teams, scale] = await Promise.all([
    activitiesForWorkshop(workshopId),
    db.participants.where('workshop_id').equals(workshopId).toArray(),
    db.teams.where('workshop_id').equals(workshopId).toArray(),
    scaleForWorkshop(workshopId),
  ])

  // Questions per activity, averaged over the activities that have any wiring. An
  // activity with nothing wired to it yet would otherwise drag the mean toward zero
  // and understate a half-built workshop, which is exactly when somebody is looking
  // at this panel.
  const perActivity = await Promise.all(activities.map((a) => ksasForActivity(a.id)))
  const wired = perActivity.filter((list) => list.length > 0)
  const questionsPerActivity = wired.length
    ? wired.reduce((sum, list) => sum + list.length, 0) / wired.length
    : 0

  // The rubric as a capture actually carries it: every distinct question in the
  // workshop, rendered by the real renderer against the real scale.
  const seen = new Set<string>()
  const distinctKsas = perActivity.flat().filter((k) => {
    if (seen.has(k.id)) return false
    seen.add(k.id)
    return true
  })
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? '(no team)'
  const rubricChars = distinctKsas.length ? renderRubricDoc(distinctKsas, scale).length : 0
  const rosterChars = participants.length ? renderRosterDoc(participants, teamName).length : 0

  const conversations = await db.mentoringConversations
    .where('workshop_id')
    .equals(workshopId)
    .count()

  return {
    activities: activities.length,
    participants: participants.length,
    questionsPerActivity,
    rubricChars,
    rosterChars,
    conversations,
    observedCaptureChars: await meanCaptureChars(workshopId),
  }
}

/**
 * The mean length of this workshop's real captures, or null when it has none.
 *
 * Null rather than zero, because the estimator treats null as "fall back to the
 * assumption" and zero as a measurement — and a workshop on its first morning would
 * otherwise be told routing costs nothing.
 */
async function meanCaptureChars(workshopId: string): Promise<number | null> {
  const rows = await db.evaluations.where('workshop_id').equals(workshopId).toArray()
  const lengths = rows
    .map((r) => (typeof r.source_text === 'string' ? r.source_text.trim().length : 0))
    .filter((n) => n > 0)
  if (!lengths.length) return null
  return Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
}

/**
 * What this workshop has actually spent, from tl-13's trace.
 *
 * THE CHEAPEST FEEDBACK LOOP THERE IS, and the spec is right that it costs one query.
 * An estimator that is never compared to an outcome stays wrong indefinitely, so the
 * panel shows actuals beside the estimate as soon as there are any.
 *
 * Only `result` outcomes carry token counts — the operator-action outcomes that are
 * the normal state of two of the three modes have nothing to report, since no model
 * was called from this app. `calls` counts the rows that contributed, so the panel can
 * say "over 3 calls" rather than implying the figure covers the whole workshop.
 */
export interface ActualSpend {
  inputTokens: number
  outputTokens: number
  calls: number
}

export async function actualSpendForWorkshop(workshopId: string | null): Promise<ActualSpend | null> {
  if (!workshopId) return null
  let rows: AiCallLogEntry[]
  try {
    rows = await db.aiCallLog.where('workshop_id').equals(workshopId).toArray()
  } catch {
    // The trace must never be able to break the thing it observes — tl-13's rule,
    // and it applies to reading the trace as well as writing it.
    return null
  }
  const withTokens = rows.filter((r) => r.tokens_in != null || r.tokens_out != null)
  if (!withTokens.length) return null
  return {
    inputTokens: withTokens.reduce((sum, r) => sum + (r.tokens_in ?? 0), 0),
    outputTokens: withTokens.reduce((sum, r) => sum + (r.tokens_out ?? 0), 0),
    calls: withTokens.length,
  }
}
