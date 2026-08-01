import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'
import { c } from '../lib/content/chrome'
import { classifySignupError, SIGNUP_ERROR_ID } from '../lib/signupErrors'

/**
 * The role picker is gone (tl-11).
 *
 * It offered evaluator and consultant, wrote the choice into `raw_user_meta_data`,
 * and the server honored it only where the allowlist already permitted that role —
 * so for almost everybody it was a control whose selection changed nothing. After
 * tl-01 moved roles onto `workshop_member` it could not have worked at all: a role
 * is now a fact about a workshop, and at sign-up the account does not yet have one.
 * A workshop role comes from the invitation, which is where somebody with the
 * authority to decide it already decided it.
 */

// ---------------------------------------------------------------------------
// Supabase sign-in / create-account form
// ---------------------------------------------------------------------------

function SupabaseSignIn() {
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmationPending, setConfirmationPending] = useState(false)

  // Both handlers clear `busy` in a finally block. signIn/signUp are written not
  // to reject, but a stuck "Signing in…" button with no way out is bad enough
  // that the guarantee belongs on both sides of the call.
  const submitSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const { error: err } = await signIn(email, password)
      if (err) { setError(err); return }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const submitSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const { error: err, confirmationRequired } = await signUp(name, email, password)
      if (err) {
        const kind = classifySignupError(err)
        setError(kind === 'other' ? err : c(SIGNUP_ERROR_ID[kind]))
        return
      }
      if (confirmationRequired) { setConfirmationPending(true); return }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (confirmationPending) {
    return (
      <main className="signin">
        <div className="card">
          <h1>Check your email</h1>
          <p className="muted small">
            A confirmation link was sent to <strong>{email}</strong>. Click it to activate your
            account, then return here to sign in.
          </p>
          <button className="ghost" onClick={() => { setConfirmationPending(false); setMode('signin') }}>
            Back to sign in
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="signin">
      <div className="card">
        <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>

        {mode === 'signin' ? (
          <form onSubmit={submitSignIn}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.org"
            />
            <div style={{ height: 12 }} />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Your password"
            />
            {error && <p className="banner warn" style={{ marginTop: 12 }}>{error}</p>}
            <div style={{ height: 16 }} />
            <button
              className="primary block"
              type="submit"
              disabled={busy || !email.trim() || !password}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitSignUp}>
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="e.g. Joshua Frost"
            />
            <div style={{ height: 12 }} />
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.org"
            />
            <div style={{ height: 12 }} />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Choose a password"
            />
            <p className="muted small" style={{ marginTop: 12 }}>
              {c('signin.role-note')}
            </p>
            {error && <p className="banner warn" style={{ marginTop: 12 }}>{error}</p>}
            <div style={{ height: 16 }} />
            <button
              className="primary block"
              type="submit"
              disabled={busy || !name.trim() || !email.trim() || !password}
            >
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}

        <div style={{ height: 16 }} />
        <button
          className="ghost small block"
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
        >
          {mode === 'signin' ? 'No account? Create one' : 'Already have an account? Sign in'}
        </button>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Local-only form (no Supabase configured)
// ---------------------------------------------------------------------------

function LocalSignIn() {
  const { signIn } = useAuth()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setBusy(true)
    try {
      await signIn(name, email)
      navigate('/', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="signin">
      <div className="card">
        <h1>Create your profile</h1>
        <p className="muted small">
          Running in <strong>local-only mode</strong> (no backend configured). Your name and email
          are stored on this device; nothing syncs. You can sign out and switch profiles anytime.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="e.g. Joshua Frost"
          />
          <div style={{ height: 12 }} />
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.org"
          />
          <div style={{ height: 16 }} />
          <button className="primary block" type="submit" disabled={busy || !name.trim() || !email.trim()}>
            Continue
          </button>
        </form>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Exported component — dispatches to the right form
// ---------------------------------------------------------------------------

export function SignIn() {
  return isSupabaseConfigured ? <SupabaseSignIn /> : <LocalSignIn />
}
