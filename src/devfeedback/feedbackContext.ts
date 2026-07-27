import { createContext, useContext } from 'react'

/** A comment-in-progress: what the user highlighted and where. */
export interface Draft {
  route: string
  selectionText: string
  locationLabel: string
}

/**
 * An edit-in-progress: which addressable string was selected. `source` decides
 * where saving goes — 'chrome' patches the JSON file on disk, 'ref' files a
 * proposal against the database row named by `table` + `nodeId`.
 */
export interface EditDraft {
  nodeId: string
  field: string
  source: 'chrome' | 'ref'
  table?: string
  locationLabel: string
  route: string
}

export interface FeedbackCtxValue {
  /** Non-null while the comment window is open. */
  draft: Draft | null
  openComment: (draft: Draft) => void
  closeComment: () => void
  /** Non-null while the edit window is open. */
  editDraft: EditDraft | null
  openEdit: (draft: EditDraft) => void
  closeEdit: () => void
  managerOpen: boolean
  setManagerOpen: (open: boolean) => void
}

/** Kept in its own (component-free) module so Fast Refresh stays happy. */
export const FeedbackContext = createContext<FeedbackCtxValue | null>(null)

export function useFeedback(): FeedbackCtxValue {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used within FeedbackProvider')
  return ctx
}
