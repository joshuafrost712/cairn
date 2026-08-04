/**
 * Is this quotation actually in the source? (tl-15) Pure, no IO.
 *
 * ## Why this is the check that matters most
 *
 * Every other part of the import boundary asks whether a returned observation is
 * well-formed: the right shape, a participant who exists, a question code the workshop
 * defines, a rating on its scale. None of them can tell an observation that reports what
 * the evaluator said from one the model made up, and a fabricated `source_excerpt` is the
 * failure with the worst consequences in this app: it reaches a report, a verification
 * gate, and eventually a conversation with a participant, wearing quotation marks the
 * whole way.
 *
 * The check is possible because the source is right there — the capture the observation
 * came from is a self-contained file with its own `source_text`. So this is the one
 * honesty rule the app can enforce rather than merely instruct.
 *
 * ## Deliberately generous, and the reason is a live pipeline
 *
 * The comparison is normalized hard: case, curly quotes, dashes, ellipses and runs of
 * whitespace all collapse, because a router that tidies a dictated transcript's
 * punctuation has not invented anything. Failing that, an excerpt whose words appear in
 * the source **in order** at 80% or better is accepted, which covers an elided quotation
 * ("she asked the team … then moved on") and a dropped filler word.
 *
 * That tolerance is a decision about which error to prefer. A strict check would reject
 * real work on the GitHub path that has been running since before this spec, and a
 * rejected observation is silently lost work; a generous one lets through a quotation
 * that has been lightly reworded, which a human reviewing the observation can still see.
 * Invention — a sentence with no counterpart in the source — fails both rules, and that
 * is the thing worth catching.
 */

/** Words shorter than this carry no evidence of grounding on their own. */
const CONTENT_WORD_MIN = 3

/** How much of an excerpt must be found, in order, when it is not a substring. */
export const GROUNDING_RATIO = 0.8

/**
 * How many content words an excerpt needs before the ordered-overlap fallback is
 * trustworthy at all.
 *
 * Below this it is not a measurement, it is a coincidence: "the team said" is three words
 * that appear in almost any transcript in almost any order, so a short excerpt has to be a
 * real substring or it is not grounded. Found by writing the stopword case and watching a
 * four-word phrase of pure filler score a perfect 1.
 */
export const MIN_FALLBACK_WORDS = 4

/**
 * Fold everything that is a rendering difference rather than a content difference.
 *
 * The quote and dash classes matter more than they look: dictation software and models
 * both normalize typography, so a straight apostrophe against a curly one is the single
 * likeliest way a genuine quotation fails a naive substring test.
 */
export function normalizeForProvenance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′`´']/g, "'")
    .replace(/[“”„‟″"]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Content words, for the ordered-subsequence fallback. */
export function contentWords(normalized: string): string[] {
  return normalized
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= CONTENT_WORD_MIN)
}

/**
 * How much of the excerpt appears in the source, in order, as a fraction of its
 * content words. 1 means every one of them was found in sequence.
 *
 * Greedy single pass, which is the right shape here rather than a shortcoming: the
 * source is the transcript and the excerpt is meant to be a span of it, so a greedy
 * left-to-right match is what "this quotation came from that text" means.
 */
export function orderedWordRatio(excerpt: string, source: string): number {
  const want = contentWords(normalizeForProvenance(excerpt))
  if (want.length === 0) return 0
  const have = contentWords(normalizeForProvenance(source))
  let matched = 0
  let at = 0
  for (const word of want) {
    const found = have.indexOf(word, at)
    if (found === -1) continue
    matched++
    at = found + 1
  }
  return matched / want.length
}

/**
 * Whether a quotation is supported by the source text.
 *
 * `sourceText` empty or absent returns **true**, and that is the guard on the guard, the
 * same one tl-21's roster check carries: a device that does not hold the capture cannot
 * judge its quotations, and rejecting real work for want of a source it never had would
 * be a far worse failure than the one being prevented.
 */
export function excerptIsGrounded(excerpt: string, sourceText: string | null | undefined): boolean {
  if (!sourceText || !sourceText.trim()) return true
  const needle = normalizeForProvenance(excerpt)
  if (!needle) return false
  if (normalizeForProvenance(sourceText).includes(needle)) return true
  // Too short for the fallback to mean anything: it had to be a substring.
  if (contentWords(needle).length < MIN_FALLBACK_WORDS) return false
  return orderedWordRatio(excerpt, sourceText) >= GROUNDING_RATIO
}
