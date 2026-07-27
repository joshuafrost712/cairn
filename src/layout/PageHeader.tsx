import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface Crumb {
  label: string
  to?: string
}

/**
 * Standard page furniture for the wide surfaces: breadcrumb, title, a line of
 * meta, and right-aligned actions.
 *
 * Narrow (capture-flow) pages keep their own `<h1>` inside a card; they are a
 * single task with no hierarchy to express, and a breadcrumb there would be
 * chrome for its own sake.
 */
export function PageHeader({
  title,
  crumbs,
  meta,
  actions,
}: {
  title: string
  crumbs?: Crumb[]
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="pagehead">
      {crumbs && crumbs.length > 0 && (
        <div className="pagehead__crumbs">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.label}-${i}`}>
              {i > 0 && <span aria-hidden="true"> › </span>}
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
            </span>
          ))}
        </div>
      )}
      <div>
        <h1 className="pagehead__title">{title}</h1>
        {meta && <div className="pagehead__meta">{meta}</div>}
      </div>
      {actions && <div className="pagehead__actions">{actions}</div>}
    </div>
  )
}
