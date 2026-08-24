import type { ResolvedKsa } from './goals'
import { FREE_WRITE_RULESET_VERSION, RULESET_VERSION } from './ruleset'
import { getActiveScale, maxValue, type Scale } from './scale'
import type { QuickRatings } from './types'

/**
 * Where a free-write capture's prose lives inside `answers` (tl-36).
 *
 * A reserved key rather than a new column, which is what lets this spec claim no
 * migration and no Dexie version: `answers` is jsonb in Postgres and an untyped
 * record locally, it already round-trips through `saveAnswers`, `db/sync.ts` and
 * `edit_history`, and every existing reader of it is keyed by a question id and so
 * ignores this one. Double-underscored because a Dexie-stored KSA id is a uuid and
 * cannot collide with it.
 *
 * The one reader that sees it and should not is `setup/counts.ts`, which counts
 * captures per question by looking for `answers[ksa.id]`. A free-write capture
 * therefore counts as zero against every question until it has been routed, which
 * is honest: until a router has read it, nobody knows which questions it touched.
 */
export const FREE_WRITE_KEY = '__free_write__'

/** The prose an evaluator wrote in a free-write capture, or ''. */
export function freeWriteText(answers: Record<string, string> | null | undefined): string {
  return answers?.[FREE_WRITE_KEY] ?? ''
}

/** The fields the free-write decision reads off a capture record. */
export interface CaptureLike {
  activity_id: string | null
  workshop_id: string | null
  answers?: Record<string, string> | null
  ruleset_version?: string | null
}

/**
 * Is this capture a free-write one? (tl-36)
 *
 * Pure, and separated from the Dexie reads in `ksasInScopeFor` for two reasons.
 * It is the decision, so it is the thing worth testing directly rather than
 * through a regex over a page. And the review of this spec found that the first
 * version, which derived the answer purely from the reference tables, could
 * change its mind about a record that had already been submitted.
 *
 * **A RECORD THAT CARRIES THE ANSWER IS BELIEVED.** Free-write text under the
 * reserved key, or the free-write ruleset stamped at submit, are facts about what
 * the evaluator was actually shown, and no later edit to the reference data can
 * make them untrue. Without this, wiring a question to a previously bare event
 * flipped an existing capture back to the per-question form: the prose became
 * invisible, `hasContent` still read true because the reserved key holds it, and
 * "Save changes" would have written `composeSourceText`'s empty string over the
 * real `source_text`. `listPendingCaptures` filters on `source_text.trim()`, so
 * the capture would then never route and nothing would say why. That is the
 * sibling of this wave's rule about the state a machine leaves behind: the state
 * a spec leaves behind in a row outlives the tables it was derived from.
 *
 * It also makes two devices agree. `loadReferenceData` deliberately keeps a stale
 * cache while the reference outbox is unsynced, so the phone that filed a capture
 * and the administrator's laptop that routes it can hold different wiring. The
 * marker travels with the row; the wiring does not.
 *
 * An instructor review is never free-write, whatever else is true. Its three
 * questions are the entire point of the event, and a trainee brain dump must not
 * be able to reach them by arriving on it.
 */
export function isFreeWriteCapture(
  capture: CaptureLike,
  reference: { isInstructorEvent: boolean; activityQuestions: number },
): boolean {
  if (reference.isInstructorEvent) return false
  if (freeWriteText(capture.answers).trim()) return true
  if (capture.ruleset_version === FREE_WRITE_RULESET_VERSION) return true
  if (!capture.activity_id) return true
  // The stickiness has to run BOTH ways, and the re-review is why. A per-question
  // capture carries its own markers, and believing only the free-write ones left
  // this returning true for one whose session had momentarily lost its wiring —
  // an administrator unwiring questions in Setup to re-wire them is enough. Its
  // answers would then be invisible behind an empty box, and prose typed into that
  // box would take the marker permanently and drop them from what routes.
  if (capture.ruleset_version === RULESET_VERSION) return false
  if (hasPerQuestionAnswer(capture.answers)) return false
  return reference.activityQuestions === 0
}

/** Any answered question, ignoring the free-write key. */
export function hasPerQuestionAnswer(answers: Record<string, string> | null | undefined): boolean {
  if (!answers) return false
  return Object.entries(answers).some(([k, v]) => k !== FREE_WRITE_KEY && Boolean(v?.trim()))
}

/**
 * A free-write capture's `source_text`: the prose, and nothing added (tl-36).
 *
 * No `[CODE] prompt` headers, because there is no per-question answer to label —
 * that labelling is exactly the work this capture hands to the router. The names
 * the evaluator tagged are not appended either: they travel as
 * `participant_scope` in the capture file, where the routing contract already
 * tells the router to attribute against them and to set `needs_review` rather
 * than guess. Appending them here would put the same list in the file twice, in
 * two wordings, and give the router a second thing to disagree with.
 */
export function composeFreeWriteSourceText(answers: Record<string, string>): string {
  return freeWriteText(answers).trim()
}

/**
 * Compose the readable free-form `source_text` from per-question answers.
 * This is what the (deferred) AI routing step will parse. Each answered question
 * is labeled with its KSA code + prompt so provenance is preserved. When the
 * evaluator left an optional quick read, it is included as a labeled PRIOR
 * (the evaluator's own read, not ground truth — the routing contract tells the
 * AI to weigh it against the text and flag disagreement).
 */
export function composeSourceText(
  answers: Record<string, string>,
  ksas: ResolvedKsa[],
  quickRatings: QuickRatings = {},
  // The prior is printed as "n/max" and the max is the workshop's (tl-09).
  // Printing "/3" against a 1-5 workshop's rating would tell the router a 4 was
  // off the scale, which is a way to make it distrust the evaluator's own read.
  scale: Scale = getActiveScale(),
): string {
  return ksas
    .filter((k) => answers[k.id]?.trim())
    .map((k) => {
      const rating = quickRatings[k.id]
      const priorLine =
        rating !== undefined ? `\n(Evaluator quick read, prior only: ${rating}/${maxValue(scale)})` : ''
      return `[${k.code}] ${k.evaluator_facing_prompt}\n${answers[k.id].trim()}${priorLine}`
    })
    .join('\n\n')
}

/**
 * What the capture screen should render, given a keyed resolution and the key it
 * is currently asking about (tl-36, second review).
 *
 * Pure, because the alternative was asserting a React state machine with regexes
 * over its own source file, and the fix this encodes was the blocking regression
 * of the second review: a failed read that resolved to "no questions, not
 * free-write" left submit enabled and let `composeSourceText` write an empty
 * string over real prose. That is worth executing in a test rather than
 * pattern-matching.
 *
 * A resolution carries the key of the inputs that produced it. A key that no
 * longer matches reads as unresolved rather than as an answer about a different
 * capture, which is the `uselivequery-stale-across-dep-change` rule: nothing here
 * has to be cleared, so nothing can be cleared late.
 */
export function captureScopeView<T>(
  resolved: { key: string; scope: { ksas: T[]; freeWrite: boolean } | 'error' } | null,
  key: string,
): { resolved: boolean; scopeError: boolean; ksas: T[]; freeWrite: boolean } {
  const settled = resolved?.key === key ? resolved.scope : null
  if (settled === 'error') return { resolved: false, scopeError: true, ksas: [], freeWrite: false }
  if (settled === null) return { resolved: false, scopeError: false, ksas: [], freeWrite: false }
  return { resolved: true, scopeError: false, ksas: settled.ksas, freeWrite: settled.freeWrite }
}

/**
 * May this capture be submitted? (tl-36, second review)
 *
 * Two guards on one failure, deliberately. `scopeError` refuses the state that
 * caused it; `hasQuestions` refuses the SHAPE of it, so a future rescue path
 * cannot re-open the same hole by inventing a fourth state. `composeSourceText`
 * over an empty question list returns an empty string, so "there are no questions
 * and this is not free-write" must never be submittable however it is arrived at.
 */
export function canSubmitCapture(input: {
  resolved: boolean
  scopeError: boolean
  hasContent: boolean
  freeWrite: boolean
  namedSomebody: boolean
  hasQuestions: boolean
}): boolean {
  if (!input.resolved || input.scopeError || !input.hasContent) return false
  return input.freeWrite ? input.namedSomebody : input.hasQuestions
}
