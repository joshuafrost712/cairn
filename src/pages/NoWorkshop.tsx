import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Copy } from '../components/Copy'
import { c } from '../lib/content/chrome'

/**
 * What a signed-in account with no workshop membership sees.
 *
 * This screen exists because the alternative is worse. Before per-workshop
 * membership, everybody who could sign in could see everything; now an account
 * can be legitimately authenticated and legitimately have nothing to do, and an
 * empty dashboard in that state reads as a broken app. So the state is named,
 * and it names who fixes it.
 *
 * "Check again" is here because being added to a workshop happens on somebody
 * else's screen, moments after this one is already open. Without it the only
 * recovery is a full reload, which on an installed PWA is not an obvious move.
 */
export function NoWorkshop() {
  const { identity, reloadMemberships, signOut } = useAuth()
  const [busy, setBusy] = useState(false)

  const recheck = async () => {
    setBusy(true)
    try {
      await reloadMemberships()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="shell__content" style={{ maxWidth: 640 }}>
      <div className="card">
        <h1>{c('membership.none.title')}</h1>
        <p>{c('membership.none.body')}</p>
        <p className="muted small">{c('membership.none.body', 'guidance')}</p>
        {identity && (
          <p className="muted small">
            {c('membership.none.signed-in-as', 'label', { email: identity.email })}
          </p>
        )}
        <button className="primary" onClick={recheck} disabled={busy}>
          {busy ? c('membership.none.rechecking') : c('membership.none.recheck')}
        </button>{' '}
        {/* The guidance above tells them to try the account that set the workshop
            up, so the way out has to be on this screen. */}
        <button className="ghost" onClick={signOut}>
          {c('nav.sign-out')}
        </button>
        {/* Somebody waiting to be added has nothing to do but read. tl-19 gave
            them somewhere to go that explains what they are waiting for. */}
        <p className="signin__tour">
          <Link to="/welcome" className="signin__tour-link">
            <Copy id="welcome.link" />
          </Link>
        </p>
      </div>
    </main>
  )
}
