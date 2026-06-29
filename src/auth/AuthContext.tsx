/* eslint-disable react-refresh/only-export-components -- provider + its hook are co-located by design */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AppUser } from '../lib/types'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

// Lightweight, offline-tolerant identity. The signed-in evaluator is persisted to
// localStorage so work continues through connectivity gaps without re-auth. When
// Supabase is configured we also upsert the evaluator into app_user so the backend
// has a durable record; full password / magic-link auth is the documented upgrade.

const STORAGE_KEY = 'cairn.identity'

// How long a sign-in is remembered on-device before we ask the evaluator to sign
// in again. Lightweight identity is not a security boundary, but a bounded window
// keeps a shared or borrowed phone from staying signed in indefinitely. Change this
// one constant to lengthen or shorten the remembered period.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface Identity {
  name: string
  email: string
  role: AppUser['role']
  signedInAt: string // ISO timestamp; drives the remembered-for-a-period expiry
}

interface AuthValue {
  identity: Identity | null
  signIn: (name: string, email: string, role?: AppUser['role']) => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

function load(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Identity>
    if (!parsed.email || !parsed.name) return null
    // Expire a remembered sign-in once it's older than MAX_AGE_MS. Identities
    // saved before this field existed have no signedInAt; treat them as expired
    // so the next sign-in stamps a fresh one.
    const signedInAt = parsed.signedInAt ? Date.parse(parsed.signedInAt) : NaN
    if (!Number.isFinite(signedInAt) || Date.now() - signedInAt > MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed as Identity
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(load)

  useEffect(() => {
    if (identity) localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  }, [identity])

  const signIn = async (name: string, email: string, role: AppUser['role'] = 'evaluator') => {
    const next: Identity = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      signedInAt: new Date().toISOString(),
    }
    setIdentity(next)
    // Best-effort durable record; never blocks sign-in.
    if (isSupabaseConfigured && supabase && navigator.onLine) {
      try {
        await supabase.from('app_user').upsert(
          { name: next.name, email: next.email, role: next.role },
          { onConflict: 'email' },
        )
      } catch (err) {
        console.warn('[cairn] app_user upsert failed (continuing local)', err)
      }
    }
  }

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY)
    setIdentity(null)
  }

  return <AuthContext.Provider value={{ identity, signIn, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
