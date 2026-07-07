import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'
import type { AppUser } from '../lib/types'

// Roles offered at self-signup. Elevated roles (chief_evaluator, admin) are never
// self-serve — they are assigned from the server-side allowlist, so they are not
// listed here. The requested role is honored only if the account's allowlist entry
// permits it; otherwise the server assigns the account's default role.
const SIGNUP_ROLES: { value: AppUser['role']; label: string }[] = [
  { value: 'evaluator', label: 'Evaluator' },
  { value: 'consultant', label: 'Consultant' },
]

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
  const [role, setRole] = useState<AppUser['role']>('evaluator')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmationPending, setConfirmationPending] = useState(false)

  const submitSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    const { error: err } = await signIn(email, password)
    setBusy(false)
    if (err) { setError(err); return }
    navigate('/', { replace: true })
  }

  const submitSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim() || !password) return
    setBusy(true)
    setError(null)
    const { error: err, confirmationRequired } = await signUp(name, email, password, role)
    setBusy(false)
    if (err) { setError(err); return }
    if (confirmationRequired) { setConfirmationPending(true); return }
    navigate('/', { replace: true })
  }

  if (confirmationPending) {
    return (
      <main>
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
    <main>
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
            <div style={{ height: 12 }} />
            <label htmlFor="role">Role</label>
            <select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value as AppUser['role'])}
            >
              {SIGNUP_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <p className="muted small" style={{ marginTop: 4 }}>
              Accounts are by invitation: your email must be pre-authorized. Chief-evaluator and
              admin roles are assigned by an administrator, not chosen here.
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
    await signIn(name, email)
    navigate('/', { replace: true })
  }

  return (
    <main>
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
