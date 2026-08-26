/**
 * "Which questions is this capture about", as pure functions over loaded data.
 *
 * `db/reference.ts` already declared itself THE ONE RESOLUTION SITE for this, and
 * it was right to: the capture screen, the Setup preview and the routed capture
 * file must not each decide it. The problem is that the site was Dexie-shaped, so
 * anything outside a browser — `scripts/routing-prepare.ts`, a batch that has to
 * rebuild capture files for a workshop already in Postgres — could only reach it
 * by re-implementing the branching. That is the same drift with a longer fuse: a
 * script that scoped a free-write capture to the wrong question set would produce
 * files that route cleanly, validate cleanly, and file evidence against questions
 * the evaluator was never shown.
 *
 * So the decision moves here, where it takes data rather than reads it, and
 * `ksasInScopeFor` becomes the Dexie loader in front of it. There is still one
 * decision. There are now two loaders, which is the point.
 *
 * Nothing in this file touches Dexie, Supabase, or a browser global.
 */

import { resolveForActivity, withGoalTitles, type ActivityKsaResolved, type ResolvedKsa } from './goals'
import { isFreeWriteCapture, type CaptureLike } from './compose'
import { isInstructorActivity, participantFacingQuestions } from './instructors'
import type { Activity, ActivityKsa, Goal, Ksa } from './types'

/** What the scope resolution decided, and which of the two rules produced it. */
export interface CaptureScope {
  ksas: ResolvedKsa[]
  /**
   * True when the questions came from the workshop rather than from one event, so
   * the capture is one box of prose rather than a form.
   */
  freeWrite: boolean
}

/**
 * The questions wired to one event, in display order, with per-event overrides
 * applied. The pure half of `ksasForActivity`.
 *
 * `links` must already be sorted by `sort_order`, and `ksas` index-aligned with
 * it (an absent entry means the link points at a question this caller does not
 * hold, which is dropped). Goals may be a superset; `withGoalTitles` indexes by
 * id and ignores the rest.
 */
export function resolveActivityKsas(
  links: readonly ActivityKsa[],
  ksas: readonly (Ksa | undefined)[],
  goals: readonly Goal[],
): ActivityKsaResolved[] {
  const present = links
    .map((link, i) => ({ link, ksa: ksas[i] }))
    .filter((pair): pair is { link: ActivityKsa; ksa: Ksa } => Boolean(pair.ksa))
  const resolved = withGoalTitles(
    present.map((p) => p.ksa),
    [...goals],
  )
  return present.map((p, i) => resolveForActivity(resolved[i], p.link))
}

/**
 * The workshop's questions in display order, goal titles applied. The pure half of
 * `ksasForWorkshop`.
 *
 * Sorted by code with a numeric-aware collator, so CC-EX2 follows CC-EX1 rather
 * than CC-EX10.
 */
export function resolveWorkshopKsas(ksas: readonly Ksa[], goals: readonly Goal[]): ResolvedKsa[] {
  return withGoalTitles(
    [...ksas].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [...goals],
  )
}

/**
 * Every question a trainee capture in this workshop may reach. The pure half of
 * `participantFacingKsasForWorkshop`.
 *
 * `allLinks` is deliberately the WHOLE wiring table, not a pre-filtered slice:
 * `participantFacingQuestions` does its own scoping, and the defect it was written
 * to close came from a caller filtering by activity first.
 */
export function resolveParticipantFacingKsas(
  workshopKsas: readonly ResolvedKsa[],
  allLinks: readonly Pick<ActivityKsa, 'ksa_id' | 'activity_id'>[],
  activities: readonly Pick<Activity, 'id' | 'audience'>[],
): ResolvedKsa[] {
  return participantFacingQuestions(workshopKsas, allLinks, activities)
}

/**
 * Where a capture's questions come from. The whole of the branching in
 * `ksasInScopeFor`, with none of the loading.
 *
 *   'activity'  the event's questions, as wired
 *   'workshop'  the workshop's participant-facing set; the capture is free-write
 *   'none'      free-write with no workshop to fall back to, so nothing is in scope
 */
export type CaptureScopeSource = 'activity' | 'workshop' | 'none'

/**
 * Pick the source, in the order `ksasInScopeFor` has always used:
 *
 *   an instructor review    -> the event's questions, always, even if none are wired
 *   the event has questions -> the event's questions
 *   otherwise               -> the workshop's participant-facing set, free-write
 *
 * Returns the source rather than the questions so each loader can stay lazy: the
 * workshop fallback reads the entire wiring table, and the capture screen resolves
 * this on a live query. A version taking both candidate sets would have made every
 * per-question capture pay for a set it never uses.
 */
export function captureScopeSource(
  capture: CaptureLike,
  reference: { activity: Pick<Activity, 'audience'> | null; activityQuestions: number },
): CaptureScopeSource {
  const freeWrite = isFreeWriteCapture(capture, {
    isInstructorEvent: isInstructorActivity(reference.activity),
    activityQuestions: reference.activityQuestions,
  })
  if (!freeWrite) return 'activity'
  return capture.workshop_id ? 'workshop' : 'none'
}
