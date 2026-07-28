// Reconciling this device's copy of a draft with another device's. Pure.
//
// The existing src/drafts/merge.ts answers a different question: how a
// REGENERATED document reconciles with the human edits already made against it.
// This one answers how two DEVICES' copies of the same draft reconcile. They
// sit side by side because they are both "merge a draft", and they must not be
// confused: one deals in segments and overrides, this one deals in whole rows.

import type { DraftDoc, DraftStatus } from './types'

/**
 * How far through the outgoing lifecycle a status is. Higher never loses to
 * lower, whatever the timestamps say.
 *
 * The ordering is not alphabetical and not the declaration order in types.ts;
 * it is what must never be undone:
 *
 *   draft (0)      nothing has happened yet
 *   approved (1)   a human read it and put their name to it
 *   superseded (2) it was replaced by a later revision, which is a decision
 *                  about it and so outranks both of the above
 *   sending (3)    the queue has started, so recipients may already have it
 *   sent (4)       it is in somebody's inbox and cannot be unsent
 *
 * `superseded` sits BELOW sending and sent on purpose. A draft that actually
 * went out must never be relabelled as replaced: the send is the stronger fact,
 * and db/drafts.ts already refuses to supersede a sent or sending row, so a
 * remote claiming otherwise is stale rather than newer.
 */
const STATUS_RANK: Record<DraftStatus, number> = {
  draft: 0,
  approved: 1,
  superseded: 2,
  sending: 3,
  sent: 4,
}

export function statusRank(s: DraftStatus): number {
  return STATUS_RANK[s] ?? 0
}

export type MergeWinner = 'remote' | 'local'

export interface MergeOutcome {
  winner: MergeWinner
  draft: DraftDoc
  /**
   * True when the local copy was BEHIND and the remote's more advanced status
   * is what settled it. Worth surfacing: it means this device is about to stop
   * showing an approve button for something already sent.
   */
  advanced: boolean
}

/**
 * Reconcile one draft.
 *
 * Two rules, in this order:
 *
 *   1. STATUS ONLY ADVANCES. The copy further through the lifecycle wins
 *      outright, timestamps ignored. This is the rule that matters: without it,
 *      a device that has been offline since this morning pushes its stale
 *      `draft` copy over a row that was approved and sent this evening, and the
 *      audit trail then says nobody ever sent it. Losing an edit is
 *      recoverable; un-sending an email in the record is not.
 *
 *   2. At equal status, the newer `updatedAt` wins the content.
 *
 * Ties go to LOCAL. A tie means the two copies claim the same instant, which in
 * practice means they are the same row; preferring local avoids a pointless
 * write and, more usefully, keeps the device stable rather than flickering
 * between two equal answers on every sync.
 */
export function mergeRemoteDraft(local: DraftDoc, remote: DraftDoc): MergeOutcome {
  const lr = statusRank(local.status)
  const rr = statusRank(remote.status)

  if (rr > lr) return { winner: 'remote', draft: remote, advanced: true }
  if (lr > rr) return { winner: 'local', draft: local, advanced: false }

  const remoteNewer = Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)
  return remoteNewer
    ? { winner: 'remote', draft: remote, advanced: false }
    : { winner: 'local', draft: local, advanced: false }
}
