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
 * ## Two rules, and the second one is a contiguous run rather than a bag of words
 *
 * Rule one: the excerpt, normalized, is a substring of the source, normalized. Case, curly
 * quotes, dashes, ellipses and runs of whitespace all fold, because a router that tidies a
 * dictated transcript's punctuation has invented nothing.
 *
 * Rule two, for an excerpt of at least `MIN_FALLBACK_CHARS`: its longest contiguous run
 * found in the source is at least `LCS_RATIO` of its length. That covers an elided
 * quotation ("she read the passage aloud … then moved on"), a dropped filler word, and a
 * quotation reassembled around a normalized character this module does not know about.
 *
 * **The first draft's second rule was an ordered bag of words, and the review was right to
 * kill it.** Two failures, each fatal in a different direction. It was blind to every
 * script this app is actually used with: the tokenizer split on `[^a-z0-9']`, so a
 * Devanagari, Thai or CJK excerpt produced no words at all and could never pass anything
 * but an exact substring — the strictest possible treatment for the languages least likely
 * to survive it. And it could be fooled outright, because a subsequence search over a
 * transcript gets EASIER as the transcript gets longer: "Yosef said the team had answered"
 * scored 0.83 against a source in which Yosef said something else and a different group had
 * answered. A contiguous run has neither problem — it needs no tokenizer, so it treats
 * every script alike, and a fabricated sentence has no long run in the source however long
 * the source is.
 *
 * ## Still deliberately generous, and that is a decision about which error to prefer
 *
 * A strict check would reject real work on the GitHub path that has been running since
 * before this spec, and a rejected observation is silently lost work. A generous one lets
 * through a quotation that has been lightly reworded, which a human reviewing the
 * observation can still see and correct. Invention — a sentence with no counterpart in the
 * source — fails both rules, and that is the thing worth catching.
 */

/** How much of an excerpt must be found as ONE run, when it is not a whole substring. */
export const LCS_RATIO = 0.6

/**
 * How long an excerpt must be before the contiguous-run rule is trustworthy at all.
 *
 * Below this it is not a measurement, it is a coincidence: "the team moved" is fourteen
 * characters of which "the team " appears in almost any transcript, so a short excerpt has
 * to be a real substring or it is not grounded.
 */
export const MIN_FALLBACK_CHARS = 20

/**
 * Fold everything that is a rendering difference rather than a content difference.
 *
 * The quote and dash classes matter more than they look: dictation software and models both
 * normalize typography, so a straight apostrophe against a curly one is the single likeliest
 * way a genuine quotation fails a naive substring test. Case folding is `toLowerCase`, which
 * is a no-op for the scripts that have no case and correct for the ones that do.
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

/**
 * The longest run of `needle` that appears contiguously in `haystack`, in characters.
 *
 * Classic rolling comparison rather than a suffix structure: an excerpt is a sentence and a
 * capture is a paragraph or two, so this is thousands of comparisons and not millions, and a
 * suffix automaton here would be a page of code nobody could check by reading. Both inputs
 * are expected to be normalized already.
 */
export function longestRunLength(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0
  let best = 0
  for (let start = 0; start < needle.length; start++) {
    // Nothing starting here can beat what we already have.
    if (needle.length - start <= best) break
    let length = best
    // Grow only while the longer candidate is still present, so each start position costs
    // one search per improvement rather than one per character.
    while (start + length < needle.length && haystack.includes(needle.slice(start, start + length + 1))) {
      length++
    }
    if (length > best) best = length
  }
  return best
}

/** How much of the excerpt was found as one run, as a fraction of its length. */
export function groundedRatio(excerpt: string, source: string): number {
  const needle = normalizeForProvenance(excerpt)
  if (!needle) return 0
  return longestRunLength(needle, normalizeForProvenance(source)) / needle.length
}

/**
 * Whether a quotation is supported by the source text.
 *
 * `sourceText` empty or absent returns **true**, and that is the guard on the guard, the
 * same one tl-21's roster check carries: a device that never held the capture cannot judge
 * its quotations, and rejecting real work for want of a source it never had would be a far
 * worse failure than the one being prevented.
 */
export function excerptIsGrounded(excerpt: string, sourceText: string | null | undefined): boolean {
  if (!sourceText || !sourceText.trim()) return true
  const needle = normalizeForProvenance(excerpt)
  if (!needle) return false
  if (normalizeForProvenance(sourceText).includes(needle)) return true
  // Too short for a run to mean anything: it had to be a substring.
  if (needle.length < MIN_FALLBACK_CHARS) return false
  return groundedRatio(excerpt, sourceText) >= LCS_RATIO
}
