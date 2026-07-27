// Folding a fresh render into edits somebody already made.
//
// Pure, no IO. The situation this exists for: at 9pm you edit three lines of
// Amos's email, at 9:20 an evaluator's verdict lands and adjusts a designation,
// and the document regenerates. Your three edits must survive, and the one whose
// underlying evidence moved must be visibly flagged rather than either silently
// kept (you approve text that no longer matches the data) or silently replaced
// (your work vanishes with no notice).
//
// The rule throughout: THE REGENERATED DOCUMENT OWNS STRUCTURE, OVERRIDES OWN
// TEXT. Order, presence, and evidence always come from the fresh render. An
// override only ever supplies a string.

import type { DocSegment } from '../reports/segments'
import { SEGMENT_ID_VERSION } from '../reports/segments'
import type { DraftFlag, OrphanedOverride, SegmentOverride } from './types'

/**
 * A stable fingerprint of the evidence behind a segment.
 *
 * Sorted, because two renders that gathered the same observations in a different
 * order have not changed. Joined on a character that cannot appear in an id.
 */
export function evidenceKey(evidence: string[]): string {
  return [...evidence].sort().join('|')
}

/** The version prefix of a segment id, or null if it has none. */
export function idVersion(id: string): string | null {
  const i = id.indexOf('/')
  return i > 0 ? id.slice(0, i) : null
}

export interface MergeResult {
  segments: DocSegment[]
  overrides: SegmentOverride[]
  orphans: OrphanedOverride[]
  flags: DraftFlag[]
}

export interface MergeInput {
  /** The edits made against the previous render. */
  overrides: SegmentOverride[]
  /** Orphans already collected. Carried forward: they do not resolve themselves. */
  orphans?: OrphanedOverride[]
}

/**
 * Merge a fresh render into existing edits.
 *
 * Returns the segment list to display (always the regenerated one), the
 * overrides that still apply, the ones that no longer do, and the flags the UI
 * must surface before approval.
 */
export function mergeDraft(previous: MergeInput, regenerated: DocSegment[]): MergeResult {
  const carriedOrphans = previous.orphans ?? []

  // An id-version bump means every id in the stored overrides was minted under
  // different rules. Matching them by string would be matching on a coincidence,
  // so the whole set orphans at once with a banner rather than a subset of them
  // landing on segments that merely happen to share a name.
  const mismatched = previous.overrides.filter((o) => idVersion(o.segmentId) !== SEGMENT_ID_VERSION)
  if (mismatched.length > 0 && mismatched.length === previous.overrides.length) {
    return {
      segments: regenerated,
      overrides: [],
      orphans: [...carriedOrphans, ...mismatched.map((o) => ({ ...o, reason: 'id-version' as const }))],
      flags: [],
    }
  }

  const byId = new Map(regenerated.map((s) => [s.id, s]))
  const overrides: SegmentOverride[] = []
  const orphans: OrphanedOverride[] = [...carriedOrphans]
  const flags: DraftFlag[] = []

  for (const ov of previous.overrides) {
    if (idVersion(ov.segmentId) !== SEGMENT_ID_VERSION) {
      orphans.push({ ...ov, reason: 'id-version' })
      continue
    }

    const seg = byId.get(ov.segmentId)
    if (!seg) {
      // The line this edit belonged to is not in the document any more: the KSA
      // dropped out of the highlights, the observation was deleted, the section
      // no longer applies. Surfaced with discard and re-insert actions rather
      // than thrown away, because the wording may be worth keeping.
      orphans.push({ ...ov, reason: 'segment-gone' })
      continue
    }

    overrides.push(ov)

    const nowKey = evidenceKey(seg.evidence)
    if (ov.baseEvidenceKey !== nowKey) {
      const before = new Set(ov.baseEvidenceKey ? ov.baseEvidenceKey.split('|') : [])
      const after = new Set(seg.evidence)
      flags.push({
        segmentId: ov.segmentId,
        kind: 'stale-evidence',
        addedEvidence: [...after].filter((id) => !before.has(id)).sort(),
        removedEvidence: [...before].filter((id) => !after.has(id)).sort(),
      })
      continue
    }

    if (ov.baseText !== seg.text) {
      // Same evidence, different wording: a verdict adjusted a designation, or a
      // name changed. The edit still applies to the same facts, but what the
      // generator would say about them has moved.
      flags.push({ segmentId: ov.segmentId, kind: 'stale-text', addedEvidence: [], removedEvidence: [] })
    }
  }

  return { segments: regenerated, overrides, orphans, flags }
}

/**
 * The document as it will actually be sent: regenerated structure with the
 * human's text laid over it, and deleted lines removed.
 *
 * Deleting the last segment of a block would otherwise strip its trailing blank
 * line and run two blocks together, so the gap moves to whatever now ends the
 * block.
 */
export function applyOverrides(segments: DocSegment[], overrides: SegmentOverride[]): DocSegment[] {
  const byId = new Map(overrides.map((o) => [o.segmentId, o]))
  const out: DocSegment[] = []

  for (const seg of segments) {
    const ov = byId.get(seg.id)
    if (ov && ov.text === null) {
      if (seg.gapAfter && out.length > 0) out[out.length - 1] = { ...out[out.length - 1], gapAfter: true }
      continue
    }
    out.push(ov ? { ...seg, text: ov.text as string } : seg)
  }

  return out
}

/** Record an edit against the segment it was made on, capturing the baseline. */
export function makeOverride(
  seg: DocSegment,
  text: string | null,
  at: string,
  by: string | null,
): SegmentOverride {
  return {
    segmentId: seg.id,
    text,
    baseText: seg.text,
    baseEvidenceKey: evidenceKey(seg.evidence),
    at,
    by,
  }
}

/**
 * Re-baseline an override to the current render: the "I have looked at this and
 * my wording still stands" action behind a stale flag.
 */
export function acknowledgeFlag(
  overrides: SegmentOverride[],
  segments: DocSegment[],
  segmentId: string,
  at: string,
): SegmentOverride[] {
  const seg = segments.find((s) => s.id === segmentId)
  if (!seg) return overrides
  return overrides.map((o) =>
    o.segmentId === segmentId
      ? { ...o, baseText: seg.text, baseEvidenceKey: evidenceKey(seg.evidence), at }
      : o,
  )
}

/** Drop an override entirely, letting the generated line stand. */
export function revertOverride(overrides: SegmentOverride[], segmentId: string): SegmentOverride[] {
  return overrides.filter((o) => o.segmentId !== segmentId)
}
