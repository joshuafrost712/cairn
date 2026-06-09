import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { AppUser } from '../lib/types'

const ROLES: { value: AppUser['role']; label: string; hint: string }[] = [
  { value: 'evaluator', label: 'Evaluator', hint: 'Records observations and verifies others’.' },
  { value: 'consultant', label: 'Consultant', hint: 'Reviews and verifies, joins late in the workshop.' },
  { value: 'admin', label: 'Admin', hint: 'Sets up the workshop, roster, and settings.' },
]

export function SignIn() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AppUser['role']>('evaluator')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setBusy(true)
    await signIn(name, email, role)
    navigate('/', { replace: true })
  }

  return (
    <main>
      <div className="card">
        <h1>Create your profile</h1>
        <p className="muted small">
          This is your evaluator profile on this device. Your name and email are attached to every
          observation and verdict you make, so you never retype them, and your session survives
          connectivity gaps. You can sign out and switch profiles anytime.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="name">Your name</label>
          <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="e.g. Joshua Frost" />
          <div style={{ height: 12 }} />
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.org" />
          <div style={{ height: 12 }} />
          <label htmlFor="role">Your role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value as AppUser['role'])}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <p className="muted small" style={{ marginTop: 4 }}>{ROLES.find((r) => r.value === role)?.hint}</p>
          <div style={{ height: 16 }} />
          <button className="primary block" type="submit" disabled={busy || !name.trim() || !email.trim()}>
            Continue
          </button>
        </form>
      </div>
    </main>
  )
}
