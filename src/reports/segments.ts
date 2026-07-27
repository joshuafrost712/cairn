// The provenance layer for generated documents.
//
// Every renderer in this folder used to build a `string[]` of lines and join it.
// That is fine for producing text and useless for anything else: the moment a
// line is pushed, the observations that produced it are gone. The workbench has
// to be able to click a line and show the evidence behind it, so the renderers
// now emit segments and `segmentsToMarkdown` produces exactly the same string.
//
// One deliberate correction to the obvious framing: the atom is a SEGMENT, not a
// sentence. Several generated units are multi-sentence and every sentence inside
// one has identical provenance, so splitting them would add an abbreviation-aware
// sentence splitter and buy nothing. The UI says "click a line".

import type { KsaRollup } from './build'
import type { ObservationRecord } from '../lib/types'

/**
 * What an evidence bullet needs.
 *
 * Deliberately looser than AnnotatedObservation: the participant report is also
 * rendered from the plain pre-verification pipeline, where the effective
 * designation has not been attached yet. Requiring the annotated type here would
 * force every caller through the verification layer for no gain, so the field is
 * optional and falls back to the recorded designation, exactly as the renderers
 * did before this file existed.
 */
export type EvidenceObservation = ObservationRecord & { effective_designation?: number }

export const LEVEL_WORD: Record<number, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}

/**
 * A confirmed designation at or below this level is a growth signal worth a
 * mentoring conversation. Named so the threshold is visible and changeable, and
 * shared so the day email, the participant email, and the event digest cannot
 * drift apart on what counts as low.
 */
export const MENTORING_THRESHOLD = 1

export type SegmentKind = 'heading' | 'paragraph' | 'bullet' | 'evidence' | 'meta'

export interface DocSegment {
  /**
   * Stable, deterministic, and built from domain identifiers only. Never an
   * array index and never a rank. See `segId` for why that matters.
   */
  id: string
  kind: SegmentKind
  /** Informational. `text` already carries its own markdown, including any `#`. */
  level?: number
  /** Literal markdown. May be multi-line: an evidence bullet is two lines. */
  text: string
  /** Reproduces the blank line that followed this block, byte for byte. */
  gapAfter: boolean
  participantId?: string
  ksaCode?: string
  /** Observation ids. The whole reason this file exists. */
  evidence: string[]
  /** The derivation rule, computed. Not a model's justification. */
  note?: string
  editable: boolean
}

/**
 * Build a segment id from stable domain parts.
 *
 * Slash-delimited, versioned, and free of indices and ranks, which avoids four
 * bugs that an index-keyed id would introduce once edits are stored against
 * these ids:
 *
 *   - A new observation for participant B would shift participant A's ids.
 *   - A KSA dropping out of the top-3 highlights would re-point an existing
 *     edit at whatever is now number one: the wrong sentence, attributed to the
 *     wrong evidence, with nothing visibly broken.
 *   - A KSA with designations [1,3] has representative 3 AND conflict true, so
 *     it appears in both the highlights and the reconciliation sections with
 *     the same strongest observation. Without the section prefix those two
 *     segments would collide on one id.
 *   - Keying an evidence bullet on the observation id rather than its position
 *     means that when the strongest evidence changes, the old bullet orphans
 *     visibly instead of an edited quote silently re-attaching to a different
 *     evaluator's words.
 *
 * Parts are joined verbatim, so an id built from a previously built id keeps its
 * structure. Any value that comes from data rather than from this codebase goes
 * through `slug` first: a CBC subpoint label or a participant name could contain
 * a slash, and one stray slash inside a part would make the path unparseable.
 */
export function segId(...parts: (string | number)[]): string {
  return parts.join('/')
}

/** Make a data-derived value safe to sit inside one path part. */
export function slug(v: string | number): string {
  return String(v).replace(/\//g, '_')
}

/** The id version. A stored draft whose ids carry a different one is orphaned wholesale rather than mis-matched. */
export const SEGMENT_ID_VERSION = 'v1'

/**
 * Close the current block: the mechanical translation of `lines.push('')`.
 *
 * Attaching the gap to the preceding segment rather than emitting a blank
 * segment is what keeps the segment list free of rows that render as nothing
 * and cannot be clicked, edited, or attributed.
 */
export function endBlock(out: DocSegment[]): void {
  const last = out[out.length - 1]
  if (last) last.gapAfter = true
}

/** Render segments back to the markdown they came from. */
export function segmentsToMarkdown(segments: DocSegment[]): string {
  const lines: string[] = []
  for (const s of segments) {
    lines.push(...s.text.split('\n'))
    if (s.gapAfter) lines.push('')
  }
  return lines.join('\n')
}

/** Short identifier for an evaluator from their email (local-part), for attribution. */
export function evaluatorLabel(email: string | null | undefined): string {
  if (!email) return 'an evaluator'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/**
 * The derivation rule for a representative designation, stated deterministically.
 *
 * Without this, a reader sees four observations under a "3/3" and has to guess
 * how one became the other. The rule is known exactly (build.ts takes the max of
 * the counting designations), so it is computed and printed, never inferred and
 * never explained by a model.
 */
export function derivationNote(r: KsaRollup<EvidenceObservation>): string {
  if (r.representative === null) {
    return r.toVerify.length
      ? `No counting evidence yet: ${r.toVerify.length} observation${r.toVerify.length === 1 ? ' is' : 's are'} still set aside.`
      : 'No evidence captured for this area yet.'
  }
  const parts = [
    `${r.representative}/3 is the highest of ${r.designations.length} counting designation${r.designations.length === 1 ? '' : 's'} (${r.designations.join(', ')}).`,
  ]
  if (r.toVerify.length) parts.push(`${r.toVerify.length} set aside pending review.`)
  if (r.conflict) parts.push('Evaluators differ by 2 or more, so this is flagged for reconciliation.')
  return parts.join(' ')
}

/** The observation ids behind a rollup's claim: all of the counting evidence, because the claim asserts the max over that whole set. */
export function claimEvidence(r: KsaRollup<EvidenceObservation>): string[] {
  return r.contributing.map((o) => o.id)
}

export interface EvidenceSegmentOptions {
  id: string
  /** Leading whitespace for the bullet. The quote line gets two more spaces. */
  indent?: string
  /** Name the evaluator. True for internal documents, false for anything a participant reads. */
  showEvaluator?: boolean
  participantId?: string
  ksaCode?: string
}

/**
 * One evidence bullet, optionally with the verbatim excerpt beneath it.
 *
 * Two lines in one segment on purpose: the quote has exactly the provenance of
 * the bullet above it, so splitting them would create a second row carrying the
 * same single observation id and give the reader two things to click for one
 * fact.
 */
export function evidenceSegment(
  o: EvidenceObservation,
  opts: EvidenceSegmentOptions,
): DocSegment {
  const indent = opts.indent ?? ''
  const eff = o.effective_designation ?? o.evidence_designation
  const adjusted = eff !== o.evidence_designation ? ` (adjusted from ${o.evidence_designation})` : ''
  const group = o.origin === 'group' ? ' [group observation]' : ''
  const head = opts.showEvaluator
    ? `${indent}- ${evaluatorLabel(o.evaluator_email)} rated ${eff}/3${adjusted}${group}: ${o.text}`
    : `${indent}- ${eff}/3${adjusted}${group}: ${o.text}`
  const text = o.source_excerpt ? `${head}\n${indent}  > "${o.source_excerpt}"` : head

  return {
    id: opts.id,
    kind: 'evidence',
    text,
    gapAfter: false,
    participantId: opts.participantId,
    ksaCode: opts.ksaCode,
    evidence: [o.id],
    editable: true,
  }
}

/**
 * Push a segment with the defaults most callers want.
 *
 * `editable` defaults by kind rather than being passed everywhere. Headings are
 * structure. Meta segments assert a machine-checked fact (the verification gate
 * line), and letting someone type "verified" over a locked gate would make the
 * gate decorative, which is the one thing the approval flow must not allow.
 */
export function push(
  out: DocSegment[],
  seg: Omit<DocSegment, 'gapAfter' | 'evidence' | 'editable'> &
    Partial<Pick<DocSegment, 'gapAfter' | 'evidence' | 'editable'>>,
): DocSegment {
  const full: DocSegment = {
    gapAfter: false,
    evidence: [],
    editable: seg.kind !== 'heading' && seg.kind !== 'meta',
    ...seg,
  }
  out.push(full)
  return full
}
