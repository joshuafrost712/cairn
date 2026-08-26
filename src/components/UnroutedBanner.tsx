import { Link } from 'react-router-dom'

import { useUnroutedCaptures } from '../hooks/useUnroutedCaptures'

/**
 * Says why this page is empty, when the reason is that nobody has routed anything.
 *
 * The one thing every evidence surface was missing. Each of them renders the same
 * "nothing here" state for two situations that are not the same: no evidence has
 * been gathered, and a pile of evidence is sitting one step upstream. Only the
 * Pipeline card ever named the difference, and it lives on a page an administrator
 * has to already suspect something to visit.
 *
 * Renders nothing when there is nothing waiting, so it is safe to put on every
 * page, and nothing while the count is still loading, so it never flashes a wrong
 * number and teaches people to scroll past it.
 */
export function UnroutedBanner({ surface }: { surface: string }) {
  const { count, loading } = useUnroutedCaptures()
  if (loading || count === 0) return null
  return (
    <div className="banner warn" role="status">
      <strong>
        {count} submitted {count === 1 ? 'capture has' : 'captures have'} not been routed yet.
      </strong>{' '}
      {surface} is built from routed observations, so it cannot fill until{' '}
      {count === 1 ? 'it is' : 'they are'} processed.{' '}
      <Link to="/admin/routing">Go to routing</Link>
    </div>
  )
}
