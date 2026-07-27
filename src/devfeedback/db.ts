import Dexie, { type EntityTable } from 'dexie'

/**
 * Storage for in-app dev feedback. Deliberately a SEPARATE IndexedDB database
 * from the app's production store (`cairn` in src/db/local.ts): feedback is a
 * development concern and must never bump the production schema version, share
 * the sync outbox, or otherwise entangle with evaluation data. Wiping this DB
 * has zero effect on real captures.
 */
export type Importance = 'high' | 'medium' | 'low'

export interface FeedbackComment {
  id: string
  /** Route the comment was made on, e.g. "/capture/abc". */
  route: string
  /** The highlighted text the comment is anchored to (empty for a page-level note). */
  selectionText: string
  /** Human-readable hint at where on the page this is (nearest heading / label). */
  locationLabel: string
  /** The actual feedback. */
  comment: string
  importance: Importance
  /** 'open' = still in the working set; 'sent' = already shipped in a batch. */
  status: 'open' | 'sent'
  createdAt: string
  updatedAt: string
}

/** Reference tables whose authored copy can be proposed against. */
export type ProposalTable = 'ksa' | 'activity' | 'workshop'

/**
 * A pending wording change to REFERENCE copy (a KSA question, an activity title).
 *
 * Chrome copy is patched straight to disk, because a file edit is already staged
 * by git and only reaches anyone on the next deploy. Reference copy is not: it
 * lives in Supabase and is read live by every evaluator's device, so applying an
 * edit on save would reword a question underneath someone mid-capture. Proposals
 * are the staging step. Nothing here is visible to evaluators; approving on the
 * Admin page is what applies it.
 */
export interface ContentProposal {
  id: string
  table: ProposalTable
  /** Primary key of the row being edited. */
  rowId: string
  /** Field path, e.g. "evaluator_facing_prompt", "guiding_questions.2". */
  field: string
  /** Value at the moment the proposal was made; used to detect a stale apply. */
  oldText: string
  newText: string
  status: 'pending' | 'applied' | 'rejected'
  /** Where it was proposed from, for context when reviewing. */
  route: string
  locationLabel: string
  createdAt: string
  resolvedAt: string | null
}

class FeedbackDB extends Dexie {
  comments!: EntityTable<FeedbackComment, 'id'>
  proposals!: EntityTable<ContentProposal, 'id'>

  constructor() {
    super('cairn-dev-feedback')
    this.version(1).stores({
      comments: 'id, status, importance, route, createdAt',
    })
    this.version(2).stores({
      comments: 'id, status, importance, route, createdAt',
      proposals: 'id, status, table, rowId, createdAt',
    })
  }
}

export const fdb = new FeedbackDB()

/** Sort order so "high" floats to the top of the manager. */
export const IMPORTANCE_ORDER: Record<Importance, number> = { high: 0, medium: 1, low: 2 }

function uid(): string {
  // crypto.randomUUID is available in all browsers this PWA targets.
  return crypto.randomUUID()
}

export async function addComment(
  draft: Pick<FeedbackComment, 'route' | 'selectionText' | 'locationLabel' | 'comment' | 'importance'>,
): Promise<void> {
  const now = new Date().toISOString()
  await fdb.comments.add({
    id: uid(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...draft,
  })
}

export async function updateComment(
  id: string,
  patch: Partial<Pick<FeedbackComment, 'comment' | 'importance'>>,
): Promise<void> {
  await fdb.comments.update(id, { ...patch, updatedAt: new Date().toISOString() })
}

export async function deleteComment(id: string): Promise<void> {
  await fdb.comments.delete(id)
}

/** Mark a set of comments as shipped after a batch is sent. */
export async function markSent(ids: string[]): Promise<void> {
  const now = new Date().toISOString()
  await fdb.comments.bulkUpdate(ids.map((id) => ({ key: id, changes: { status: 'sent', updatedAt: now } })))
}

export async function addProposal(
  draft: Pick<
    ContentProposal,
    'table' | 'rowId' | 'field' | 'oldText' | 'newText' | 'route' | 'locationLabel'
  >,
): Promise<void> {
  await fdb.proposals.add({
    id: uid(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...draft,
  })
}

export async function resolveProposal(
  id: string,
  status: 'applied' | 'rejected',
): Promise<void> {
  await fdb.proposals.update(id, { status, resolvedAt: new Date().toISOString() })
}

export async function deleteProposal(id: string): Promise<void> {
  await fdb.proposals.delete(id)
}
