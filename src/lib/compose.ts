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
