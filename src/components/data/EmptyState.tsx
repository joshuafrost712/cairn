import type { ReactNode } from 'react'

/**
 * The empty state, which on this dashboard is a primary state rather than an
 * edge case: for the first days of a workshop most views legitimately have
 * nothing in them, and "no evidence yet" has to read as normal progress rather
 * than as a broken page.
 */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children}
    </div>
  )
}
