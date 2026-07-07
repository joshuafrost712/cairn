import { createContext, useContext } from 'react'

/** A comment-in-progress: what the user highlighted and where. */
export interface Draft {
  route: string
  selectionText: string
  locationLabel: string
}

export interface FeedbackCtxValue {
  /** Non-null while the comment window is open. */
  draft: Draft | null
  openComment: (draft: Draft) => void
  closeComment: () => void
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
