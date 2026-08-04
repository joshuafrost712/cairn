// What has to be true before a draft can be approved, and what approval does.
//
// Pure, no IO. Two rules carry this file.
//
// APPROVAL MUST NOT ROUTE AROUND THE VERIFICATION GATE. /reports locks a
// participant's report until participantGate() says ready. If the workbench can
// approve and send a locked report in one click then the gate is decorative and
// the whole multi-evaluator design is theatre. The only way past it is an
// explicit override that records a reason and stamps the caveat into the
// document itself.
//
// APPROVAL FREEZES. Once approved, regenerating produces a new revision that
// supersedes the old one. Mutating an approved draft would make its audit record
// assert that somebody approved text they never read.

import type { Gate } from '../reports/verification'
import { segmentsToMarkdown } from '../reports/segments'
import { applyOverrides } from './merge'
import type { ApprovedSnapshot, DraftDoc, DraftStatus } from './types'

export interface ApprovalContext {
  /** The verification gate for this draft's subject, when it has one. */
  gate?: Gate
}

/**
 * Human-readable reasons this draft cannot be approved yet.
 *
 * Returned as sentences because the approval bar renders them directly. A
 * blocker the user cannot read is a disabled button with no explanation, which
 * is the failure mode this list exists to prevent.
 */
export function approvalBlockers(draft: DraftDoc, ctx: ApprovalContext = {}): string[] {
  const out: string[] = []

  if (draft.status !== 'draft') {
    out.push(
      draft.status === 'superseded'
        ? 'This revision has been superseded by a newer one.'
        : `This draft is already ${draft.status}.`,
    )
    // Everything below is about readiness, which is moot once it has left draft.
    return out
  }

  const gate = ctx.gate
  if (gate && gate.total > 0 && gate.status !== 'ready' && !draft.gateOverride) {
    const bits = [`${gate.verified} of ${gate.total} observations confirmed`]
    if (gate.pending) bits.push(`${gate.pending} pending`)
    if (gate.disputed) bits.push(`${gate.disputed} disputed`)
    out.push(`Not verified: ${bits.join(', ')} (needs ${gate.required} evaluators each).`)
  }

  if (draft.flags.length > 0) {
    const evidence = draft.flags.filter((f) => f.kind === 'stale-evidence').length
    const text = draft.flags.length - evidence
    if (evidence) {
      out.push(
        `${evidence} edited line${evidence === 1 ? '' : 's'} ${evidence === 1 ? 'has' : 'have'} evidence that changed after you edited ${evidence === 1 ? 'it' : 'them'}.`,
      )
    }
    if (text) {
      out.push(
        `${text} edited line${text === 1 ? '' : 's'} ${text === 1 ? 'was' : 'were'} reworded by the generator after you edited ${text === 1 ? 'it' : 'them'}.`,
      )
    }
  }

  if (draft.orphans.length > 0) {
    out.push(
      `${draft.orphans.length} edited line${draft.orphans.length === 1 ? '' : 's'} no longer ${draft.orphans.length === 1 ? 'exists' : 'exist'} in the document.`,
    )
  }

  const addressable = draft.recipients.filter((r) => r.email.trim().length > 0)
  if (addressable.length === 0) {
    out.push('No email address on file for this recipient.')
  }

  return out
}

export function canApprove(draft: DraftDoc, ctx: ApprovalContext = {}): boolean {
  return approvalBlockers(draft, ctx).length === 0
}

/**
 * The blockers a human is allowed to wave through, and the ones they are not.
 *
 * Stale flags and orphans are review state: acknowledging them IS the review, so
 * the fix is to look at the line, not to add a second override switch. The gate
 * is the only one with an override, because "send it unverified, I know" is a
 * real decision a chief evaluator sometimes has to make at 11pm.
 */
export function overrideGate(draft: DraftDoc, reason: string, at: string): DraftDoc {
  return { ...draft, gateOverride: true, gateOverrideReason: reason, updatedAt: at }
}

export interface ApproveInput {
  by: string | null
  at: string
  /** Evidence resolved against live data by the caller, which owns the DB. */
  snapshotEvidence: ApprovedSnapshot['evidence']
}

/**
 * Freeze a draft.
 *
 * Throws rather than returning a bad state: an approval that silently did
 * nothing would leave the UI showing an approved-looking document that the send
 * queue will refuse, and the user with no idea why.
 */
export function approveDraft(draft: DraftDoc, input: ApproveInput, ctx: ApprovalContext = {}): DraftDoc {
  const blockers = approvalBlockers(draft, ctx)
  if (blockers.length > 0) {
    throw new Error(`Cannot approve: ${blockers.join(' ')}`)
  }

  const markdown = segmentsToMarkdown(applyOverrides(draft.segments, draft.overrides))

  return {
    ...draft,
    status: 'approved',
    approvedBy: input.by,
    approvedAt: input.at,
    updatedAt: input.at,
    approvedSnapshot: {
      at: input.at,
      by: input.by,
      markdown,
      evidence: input.snapshotEvidence,
      gateOverrideReason: draft.gateOverride ? draft.gateOverrideReason : null,
    },
  }
}

/** Undo an approval that has not been sent to anyone yet. */
export function unapproveDraft(draft: DraftDoc, at: string): DraftDoc {
  if (draft.status !== 'approved') throw new Error('Only an approved draft can be reopened.')
  if (draft.recipients.some((r) => r.status === 'sent' || r.status === 'awaiting_confirmation')) {
    throw new Error('This draft has already gone to at least one recipient; make a new revision instead.')
  }
  return {
    ...draft,
    status: 'draft',
    approvedBy: null,
    approvedAt: null,
    approvedSnapshot: null,
    updatedAt: at,
  }
}

/** The id scheme. Deterministic, so regenerating the same evening is idempotent. */
export function draftId(kind: string, subjectKey: string, dateLabel: string, revision: number): string {
  return `${kind}::${subjectKey}::${dateLabel}::r${revision}`
}

/**
 * A successor to an approved (or sent) draft.
 *
 * The old row keeps its approval record untouched and is marked superseded by
 * the caller; the new one starts clean at draft, carrying the human's edits
 * forward through mergeDraft but not their approval.
 */
export function superseding(
  approved: DraftDoc,
  merged: Pick<DraftDoc, 'segments' | 'overrides' | 'orphans' | 'flags'>,
  at: string,
): DraftDoc {
  const revision = approved.revision + 1
  return {
    ...approved,
    ...merged,
    id: draftId(approved.kind, approved.subjectKey, approved.dateLabel, revision),
    revision,
    supersedes: approved.id,
    status: 'draft',
    // A fresh send: whoever already received the previous revision received a
    // different document, and marking them sent here would skip them silently.
    recipients: approved.recipients.map((r) => ({ ...r, status: 'pending' as const, at: null, error: null })),
    approvedBy: null,
    approvedAt: null,
    approvedSnapshot: null,
    // The gate override does NOT carry over. It was a judgment about one
    // document at one moment; the successor gets that judgment made again.
    gateOverride: false,
    gateOverrideReason: null,
    generatedAt: at,
    updatedAt: at,
  }
}

/** Whether a status still allows editing the text. */
/**
 * Whether the authored wording has moved since this draft was generated (tl-16).
 *
 * Two refusals, both deliberate. It says no for anything that is not still a draft,
 * because an approved or sent document is a RECORD of what somebody approved and
 * telling a reader it is out of date invites them to "fix" the audit trail. And it
 * says no when the draft carries no fingerprint at all, which means it predates this
 * spec: unknown is not stale, and warning on it would be the classifier crying wolf
 * on every row in the queue the day this ships.
 */
export function templatesMoved(draft: DraftDoc, currentFingerprint: string): boolean {
  if (draft.status !== 'draft') return false
  if (!draft.templateFingerprint) return false
  return draft.templateFingerprint !== currentFingerprint
}

export function isEditable(status: DraftStatus): boolean {
  return status === 'draft'
}
