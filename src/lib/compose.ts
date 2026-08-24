import type { ResolvedKsa } from './goals'
import { getActiveScale, maxValue, type Scale } from './scale'
import type { QuickRatings } from './types'

/**
 * Compose the readable free-form `source_text` from per-question answers.
 * This is what the (deferred) AI routing step will parse. Each answered question
 * is labeled with its KSA code + prompt so provenance is preserved. When the
 * evaluator left an optional quick read, it is included as a labeled PRIOR
 * (the evaluator's own read, not ground truth — the routing contract tells the
 * AI to weigh it against the text and flag disagreement).
 */
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
