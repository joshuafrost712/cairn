// What a generated document looks like once a human has touched it.
//
// Kept out of lib/types.ts on purpose: a draft holds DocSegments, so this layer
// depends on src/reports, and pushing it into lib/types would make the shared
// type module depend on the report renderers.

import type { DocSegment } from '../reports/segments'

export type DocKind = 'participant_email' | 'event_digest' | 'participant_report' | 'discrepancy'

/**
 * Where a draft is in the review loop.
 *
 * `approved` is a one-way door for the document it names. Regenerating an
 * approved draft does not mutate it; it produces a new revision that supersedes
 * it. Otherwise the approval audit trail would assert that somebody approved
 * text they never saw.
 */
export type DraftStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'superseded'

/**
 * Per-recipient send state.
 *
 * `awaiting_confirmation` exists because the mailto transport cannot know
 * whether an email was actually sent. Parking there until a human says "I sent
 * it" is the honest state; calling it `sent` would put a lie in the audit trail.
 */
export type RecipientStatus = 'pending' | 'awaiting_confirmation' | 'sent' | 'failed' | 'skipped'

export interface DraftRecipient {
  email: string
  name: string | null
  status: RecipientStatus
  at: string | null
  error: string | null
}

/**
 * One human edit, with the baseline it was made against.
 *
 * `baseText` and `baseEvidenceKey` are the whole staleness mechanism: on the
 * next regeneration they answer "has the thing this edit was responding to
 * changed?" without needing to diff the rendered document.
 */
export interface SegmentOverride {
  segmentId: string
  /** The edited text, or null when the line was deleted. */
  text: string | null
  baseText: string
  baseEvidenceKey: string
  at: string
  by: string | null
}

export type DraftFlagKind = 'stale-evidence' | 'stale-text'

export interface DraftFlag {
  segmentId: string
  kind: DraftFlagKind
  addedEvidence: string[]
  removedEvidence: string[]
}

export type OrphanReason = 'segment-gone' | 'id-version'

export interface OrphanedOverride extends SegmentOverride {
  reason: OrphanReason
}

/** One observation as it stood at the moment of approval. */
export interface ApprovedEvidence {
  observation_id: string
  present: boolean
  text: string | null
  source_excerpt: string | null
  evaluator_email: string | null
  evidence_designation: number | null
  effective_designation: number | null
  vstatus: string | null
  verdicts: {
    evaluator_email: string
    decision: string
    adjusted_designation: number | null
    at: string
  }[]
}

/**
 * The artifact docs/ai-transparency.md promises: what was sent, and what every
 * claim in it rested on, resolved at the moment of approval rather than looked
 * up later against data that has moved on.
 */
export interface ApprovedSnapshot {
  at: string
  by: string | null
  markdown: string
  evidence: ApprovedEvidence[]
  /** Recorded when the verification gate was overridden, so the reason survives. */
  gateOverrideReason: string | null
}

export interface DraftDoc {
  /** Deterministic: `${kind}::${subjectKey}::${dateLabel}::r${revision}`. */
  id: string
  kind: DocKind
  /** Participant id for an email or report; activity id for a digest. */
  subjectKey: string
  workshopId: string | null
  /** For the queue list. */
  title: string
  subject: string
  dateLabel: string
  revision: number
  supersedes: string | null
  /**
   * `per-recipient` sends one message each; `single` sends one message to all.
   * Participant emails are per-recipient and the facilitator digest is single,
   * which is the difference between 26 personal notes and one team email.
   */
  fanout: 'per-recipient' | 'single'
  recipients: DraftRecipient[]
  /** The last regeneration. Text shown is this, with overrides applied on top. */
  segments: DocSegment[]
  overrides: SegmentOverride[]
  orphans: OrphanedOverride[]
  flags: DraftFlag[]
  status: DraftStatus
  gateOverride: boolean
  gateOverrideReason: string | null
  generatedAt: string
  updatedAt: string
  approvedBy: string | null
  approvedAt: string | null
  approvedSnapshot: ApprovedSnapshot | null
}
