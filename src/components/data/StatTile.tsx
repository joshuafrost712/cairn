import { useEffect, useRef, type ReactNode } from 'react'
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

  // tl-20: a number that ticks over while somebody is looking at the page says so
  // with a one-off wash. These tiles sit on live Dexie queries, so counts do move
  // under the reader mid-glance, and a silent swap is how a figure gets misread as
  // the one that was there a moment ago.
  //
  // SCALARS ONLY, and that is a real limit rather than an oversight: `value` is a
  // ReactNode, several callers pass a fragment, and there is no cheap way to ask
  // whether two element trees differ. A fragment-valued tile simply does not flash.
  //
  // Same retrigger idiom as AppShell's page-enter, for the same reason: restarting a
  // CSS animation means taking the class off, forcing a reflow, and putting it back.
  const scalar = typeof value === 'string' || typeof value === 'number' ? String(value) : null
  const valueRef = useRef<HTMLDivElement | null>(null)
  const prevScalar = useRef(scalar)
  useEffect(() => {
    const el = valueRef.current
    if (el && scalar !== null && prevScalar.current !== null && prevScalar.current !== scalar) {
      el.classList.remove('tile__value--changed')
      void el.offsetWidth
      el.classList.add('tile__value--changed')
    }
    prevScalar.current = scalar
  }, [scalar])

  const body = (
    <>
      <div className="tile__label">{label}</div>
      <div
        className="tile__value"
        ref={valueRef}
        onAnimationEnd={() => valueRef.current?.classList.remove('tile__value--changed')}
      >
        {value}
      </div>
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
