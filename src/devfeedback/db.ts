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

class FeedbackDB extends Dexie {
  comments!: EntityTable<FeedbackComment, 'id'>

  constructor() {
    super('cairn-dev-feedback')
    this.version(1).stores({
      comments: 'id, status, importance, route, createdAt',
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
