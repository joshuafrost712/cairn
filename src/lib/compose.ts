import type { Ksa } from './types'

/**
 * Compose the readable free-form `source_text` from per-question answers.
 * This is what the (deferred) AI routing step will parse. Each answered question
 * is labeled with its KSA code + prompt so provenance is preserved.
 */
export function composeSourceText(answers: Record<string, string>, ksas: Ksa[]): string {
  return ksas
    .filter((k) => answers[k.id]?.trim())
    .map((k) => `[${k.code}] ${k.evaluator_facing_prompt}\n${answers[k.id].trim()}`)
    .join('\n\n')
}
