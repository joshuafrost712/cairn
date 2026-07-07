import { useMemo, useState, type ReactNode } from 'react'
import { FeedbackContext, type Draft, type FeedbackCtxValue } from './feedbackContext'

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)

  const value = useMemo<FeedbackCtxValue>(
    () => ({
      draft,
      openComment: (d) => {
        setDraft(d)
        setManagerOpen(false)
      },
      closeComment: () => setDraft(null),
      managerOpen,
      setManagerOpen,
    }),
    [draft, managerOpen],
  )

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>
}
