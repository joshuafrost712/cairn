import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function SignIn() {
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
        <h1>Sign in</h1>
        <p className="muted small">
          Your identity is attached to every evaluation, so you never retype it. The session is
          stored on this device and survives connectivity gaps.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="name">Your name</label>
          <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <div style={{ height: 12 }} />
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <div style={{ height: 16 }} />
          <button className="primary block" type="submit" disabled={busy || !name.trim() || !email.trim()}>
            Continue
          </button>
        </form>
      </div>
    </main>
  )
}
