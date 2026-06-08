/* eslint-disable react-refresh/only-export-components -- provider + its hook are co-located by design */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AppUser } from '../lib/types'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

// Lightweight, offline-tolerant identity. The signed-in evaluator is persisted to
// localStorage so work continues through connectivity gaps without re-auth. When
// Supabase is configured we also upsert the evaluator into app_user so the backend
// has a durable record; full password / magic-link auth is the documented upgrade.

const STORAGE_KEY = 'cairn.identity'

interface Identity {
  name: string
  email: string
  role: AppUser['role']
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
    return raw ? (JSON.parse(raw) as Identity) : null
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
    const next: Identity = { name: name.trim(), email: email.trim().toLowerCase(), role }
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
