import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * One headline number with its label and a line of context.
 *
 * `sub` is not decoration: a bare "14" invites the reader to supply their own
 * denominator, and on this dataset they will guess wrong. Give it one.
 */
export function StatTile({
  label,
  value,
  sub,
  to,
  attention = false,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  to?: string
  attention?: boolean
}) {
  const className = `tile${attention ? ' tile--attention' : ''}`
  const body = (
    <>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {sub && <div className="tile__sub">{sub}</div>}
    </>
  )
  return to ? (
    <Link className={className} to={to}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}
