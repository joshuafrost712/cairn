import { db } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { isAuthorizationRefusal } from './referenceWrite'
import { mergeRemoteDraft } from '../drafts/remoteMerge'
import type { DraftDoc, DraftFlag, DraftRecipient, DraftStatus, OrphanedOverride, SegmentOverride, ApprovedSnapshot } from '../drafts/types'
import type { DocSegment } from '../reports/segments'

/**
 * Sharing outgoing documents between devices.
 *
 * Its own module, and NOT part of loadReferenceData, for one reason: that
 * function clears its tables and overwrites them from the backend, which is
 * right for server-authoritative reference data and catastrophic for a row
 * holding a human's unsent edits. Drafts need a merge, so they get one.
 *
 * The merge rules are pure and live in src/drafts/remoteMerge.ts. This module
 * moves rows, converts between the two column conventions, and handles the two
 * things a merge cannot:
 *
 *  - A draft with no `workshop_id` is INVISIBLE under doc_draft's RLS, so
 *    pushing it would appear to succeed and then read back as nothing. Those
 *    are refused locally and reported, rather than dropped quietly.
 *  - A refused write is distinguished from a failed one, reusing
 *    isAuthorizationRefusal. An evaluator who is not a chief cannot write here
 *    at all, and retrying that forever would be a permanent background error.
 */

/** Bound on each leg. A stalled sync must not hang the page that triggered it. */
const SYNC_TIMEOUT_MS = 12_000

const VALID_STATUS: DraftStatus[] = ['draft', 'approved', 'sending', 'sent', 'superseded']

interface DraftRow {
  id: string
  workshop_id: string | null
  kind: string
  subject_key: string
  title: string
  subject: string
  date_label: string
  revision: number
  supersedes: string | null
  fanout: string
  status: string
  recipients: unknown
  segments: unknown
  overrides: unknown
  orphans: unknown
  flags: unknown
  gate_override: boolean
  gate_override_reason: string | null
  generated_at: string | null
  updated_at: string
  approved_by: string | null
  approved_at: string | null
  approved_snapshot: unknown
}

function toRow(d: DraftDoc): DraftRow {
  return {
    id: d.id,
    workshop_id: d.workshopId,
    kind: d.kind,
    subject_key: d.subjectKey,
    title: d.title,
    subject: d.subject,
    date_label: d.dateLabel,
    revision: d.revision,
    supersedes: d.supersedes,
    fanout: d.fanout,
    status: d.status,
    recipients: d.recipients,
    segments: d.segments,
    overrides: d.overrides,
    orphans: d.orphans,
    flags: d.flags,
    gate_override: d.gateOverride,
    gate_override_reason: d.gateOverrideReason,
    generated_at: d.generatedAt,
    updated_at: d.updatedAt,
    approved_by: d.approvedBy,
    approved_at: d.approvedAt,
    approved_snapshot: d.approvedSnapshot,
  }
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export function fromRow(r: DraftRow): DraftDoc {
  return {
    id: r.id,
    kind: r.kind as DraftDoc['kind'],
    subjectKey: r.subject_key,
    workshopId: r.workshop_id,
    title: r.title,
    subject: r.subject,
    dateLabel: r.date_label,
    revision: r.revision,
    supersedes: r.supersedes,
    fanout: r.fanout === 'single' ? 'single' : 'per-recipient',
    recipients: arr<DraftRecipient>(r.recipients),
    segments: arr<DocSegment>(r.segments),
    overrides: arr<SegmentOverride>(r.overrides),
    orphans: arr<OrphanedOverride>(r.orphans),
    flags: arr<DraftFlag>(r.flags),
    // An unrecognized status is read as `draft`, the LEAST advanced value, so a
    // row this build cannot interpret can never win a merge against a local copy
    // that it does understand.
    status: VALID_STATUS.includes(r.status as DraftStatus) ? (r.status as DraftStatus) : 'draft',
    gateOverride: r.gate_override,
    gateOverrideReason: r.gate_override_reason,
    generatedAt: r.generated_at ?? r.updated_at,
    updatedAt: r.updated_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approvedSnapshot: (r.approved_snapshot as ApprovedSnapshot | null) ?? null,
  }
}

export interface DraftSyncResult {
  /** Rows sent to the backend. */
  pushed: number
  /** Remote copies that won their merge and replaced the local row. */
  pulled: number
  /** Local rows the backend refused. Not retryable; the caller must say so. */
  refused: number
  /** Local rows carrying no workshop, which RLS makes unshareable. */
  unscoped: number
  /** Set when the sync could not run at all. */
  error: string | null
}

const IDLE: DraftSyncResult = { pushed: 0, pulled: 0, refused: 0, unscoped: 0, error: null }

/**
 * Pull, merge, then push whatever this device still knows better.
 *
 * That order matters. Pulling first means the push carries the RESULT of the
 * merge rather than a copy that has not yet seen the other device's work, so
 * two devices converge in one round rather than trading writes.
 */
export async function syncDrafts(workshopId: string | null): Promise<DraftSyncResult> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine || !workshopId) return IDLE
  const client = supabase

  const local = await db.docDrafts.toArray()
  const mine = local.filter((d) => d.workshopId === workshopId)
  const unscoped = local.filter((d) => d.workshopId === null).length

  let remote: DraftDoc[]
  try {
    const { data, error } = await client
      .from('doc_draft')
      .select('*')
      .eq('workshop_id', workshopId)
      .abortSignal(AbortSignal.timeout(SYNC_TIMEOUT_MS))
    if (error) {
      // A refusal here means this account is not a chief in this workshop, which
      // is a permanent answer worth naming rather than a failure to retry.
      const refusal = isAuthorizationRefusal(error)
      return {
        ...IDLE,
        unscoped,
        error: refusal
          ? 'You do not have permission to share outgoing documents in this workshop.'
          : error.message,
      }
    }
    remote = ((data ?? []) as DraftRow[]).map(fromRow)
  } catch (err) {
    return { ...IDLE, unscoped, error: err instanceof Error ? err.message : 'Sync failed.' }
  }

  const localById = new Map(mine.map((d) => [d.id, d]))
  const remoteById = new Map(remote.map((d) => [d.id, d]))

  // --- merge in ------------------------------------------------------------
  const toWriteLocally: DraftDoc[] = []
  const toPush: DraftDoc[] = []

  for (const r of remote) {
    const l = localById.get(r.id)
    if (!l) {
      toWriteLocally.push(r)
      continue
    }
    const { winner, draft } = mergeRemoteDraft(l, r)
    if (winner === 'remote') toWriteLocally.push(draft)
    else toPush.push(draft)
  }

  // Anything this device has that the backend has never seen.
  for (const l of mine) if (!remoteById.has(l.id)) toPush.push(l)

  if (toWriteLocally.length > 0) await db.docDrafts.bulkPut(toWriteLocally)

  // --- push out ------------------------------------------------------------
  let pushed = 0
  let refused = 0
  for (const d of toPush) {
    const { error } = await client.from('doc_draft').upsert(toRow(d), { onConflict: 'id' })
    if (!error) {
      pushed++
    } else if (isAuthorizationRefusal(error)) {
      refused++
      console.warn(`[honest-eval] doc_draft write REFUSED for ${d.id}: ${error.message}`)
    } else {
      console.warn(`[honest-eval] doc_draft push failed for ${d.id}, will retry:`, error.message)
    }
  }

  return { pushed, pulled: toWriteLocally.length, refused, unscoped, error: null }
}

/** A one-line account of a sync, for the button that ran it. */
export function describeSync(r: DraftSyncResult): string {
  if (r.error) return r.error
  const parts: string[] = []
  if (r.pulled) parts.push(`${r.pulled} updated from other devices`)
  if (r.pushed) parts.push(`${r.pushed} shared`)
  if (r.refused) parts.push(`${r.refused} refused`)
  if (r.unscoped) {
    parts.push(
      `${r.unscoped} not shareable (generated before a workshop was selected, so they stay on this device)`,
    )
  }
  return parts.length === 0 ? 'Already up to date.' : `${parts.join(' · ')}.`
}
