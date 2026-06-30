import type { Ksa, QuickRatings } from './types'

/**
 * Compose the readable free-form `source_text` from per-question answers.
 * This is what the (deferred) AI routing step will parse. Each answered question
 * is labeled with its KSA code + prompt so provenance is preserved. When the
 * evaluator left an optional quick 0–3 read, it is included as a labeled PRIOR
 * (the evaluator's own read, not ground truth — the routing contract tells the
 * AI to weigh it against the text and flag disagreement).
 */
export function composeSourceText(
  answers: Record<string, string>,
  ksas: Ksa[],
  quickRatings: QuickRatings = {},
): string {
  return ksas
    .filter((k) => answers[k.id]?.trim())
    .map((k) => {
      const rating = quickRatings[k.id]
      const priorLine =
        rating !== undefined ? `\n(Evaluator quick read, prior only: ${rating}/3)` : ''
      return `[${k.code}] ${k.evaluator_facing_prompt}\n${answers[k.id].trim()}${priorLine}`
    })
    .join('\n\n')
}
