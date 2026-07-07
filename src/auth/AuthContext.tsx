/* eslint-disable react-refresh/only-export-components -- provider + its hook are co-located by design */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import type { AppUser } from '../lib/types'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

// ---------------------------------------------------------------------------
// Identity shape (shared by both auth paths)
// ---------------------------------------------------------------------------

export interface Identity {
  name: string
  email: string
  role: AppUser['role']
  signedInAt: string // ISO timestamp
}

// ---------------------------------------------------------------------------
// Local-only fallback (no Supabase configured)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cairn.identity'

// How long a local sign-in is remembered before asking the user to sign in
// again. Only applies to the local-identity fallback path; Supabase sessions
// have their own expiry managed by supabase-js.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function loadLocal(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Identity>
    if (!parsed.email || !parsed.name) return null
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

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

interface AuthValue {
  identity: Identity | null
  /** Supabase path: email + password. Local path: name + email (password ignored). */
  signIn: (emailOrName: string, emailOrPassword: string, passwordOrRole?: string, roleForLocal?: AppUser['role']) => Promise<{ error: string | null }>
  signUp: (name: string, email: string, password: string, role: AppUser['role']) => Promise<{ error: string | null; confirmationRequired?: boolean }>
  signOut: () => Promise<void>
  /** True when operating on local-only identity (no Supabase configured). */
  isLocalMode: boolean
}

const AuthContext = createContext<AuthValue | null>(null)

// ---------------------------------------------------------------------------
// Helper: convert a Supabase session + optional app_user row into Identity
// ---------------------------------------------------------------------------

function identityFromSession(
  user: User,
  appUser: { name: string; role: string } | null,
): Identity {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const name =
    (appUser?.name as string | undefined) ??
    (meta.name as string | undefined) ??
    user.email ??
    'Unknown'
  const rawRole = (appUser?.role as string | undefined) ?? (meta.role as string | undefined) ?? 'evaluator'
  const allowed: AppUser['role'][] = ['evaluator', 'consultant', 'chief_evaluator', 'admin', 'participant']
  const role: AppUser['role'] = (allowed.includes(rawRole as AppUser['role']) ? rawRole : 'evaluator') as AppUser['role']
  return {
    name,
    email: user.email ?? '',
    role,
    signedInAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(() =>
    isSupabaseConfigured ? null : loadLocal(),
  )

  // ---- Supabase session bootstrap ----
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return

    // Restore from cached session (works offline after first login).
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) { setIdentity(null); return }
      const user = data.session.user
      const { data: row } = await supabase!
        .from('app_user')
        .select('name, role')
        .eq('email', user.email ?? '')
        .maybeSingle()
      setIdentity(identityFromSession(user, row))
    })

    // Keep identity in sync across tab focus, token refresh, sign-out, etc.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session) { setIdentity(null); return }
      const user = session.user
      const { data: row } = await supabase!
        .from('app_user')
        .select('name, role')
        .eq('email', user.email ?? '')
        .maybeSingle()
      setIdentity(identityFromSession(user, row))
    })

    return () => subscription.unsubscribe()
  }, [])

  // ---- Local-only: persist identity to localStorage ----
  useEffect(() => {
    if (isSupabaseConfigured) return
    if (identity) localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  }, [identity])

  // --------------------------------------------------------------------------
  // signIn
  //
  // Supabase path: signIn(email, password)
  // Local path:   signIn(name, email)   — password param accepted but ignored
  // --------------------------------------------------------------------------
  const signIn = async (
    emailOrName: string,
    emailOrPassword: string,
    _passwordOrRole?: string,
    roleForLocal: AppUser['role'] = 'evaluator',
  ): Promise<{ error: string | null }> => {
    if (isSupabaseConfigured && supabase) {
      const email = emailOrName.trim().toLowerCase()
      const password = emailOrPassword
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password })
      if (authErr) return { error: authErr.message }
      // Identity is set by the onAuthStateChange listener above; nothing to do.
      return { error: null }
    }

    // Local-only fallback: name + email (password ignored).
    const name = emailOrName
    const email = emailOrPassword
    if (!name.trim() || !email.trim()) return { error: 'Name and email are required.' }
    const next: Identity = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role: roleForLocal,
      signedInAt: new Date().toISOString(),
    }
    setIdentity(next)
    return { error: null }
  }

  // --------------------------------------------------------------------------
  // signUp (Supabase only)
  // --------------------------------------------------------------------------
  const signUp = async (
    name: string,
    email: string,
    password: string,
    role: AppUser['role'],
  ): Promise<{ error: string | null; confirmationRequired?: boolean }> => {
    if (!isSupabaseConfigured || !supabase) {
      return { error: 'Supabase is not configured; use local-only sign-in.' }
    }
    const { data, error: authErr } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { name: name.trim(), role } },
    })
    if (authErr) return { error: authErr.message }
    if (!data.session) {
      // Email confirmation is required (Supabase dashboard setting).
      return { error: null, confirmationRequired: true }
    }
    // Session was created immediately (email confirmation disabled).
    // onAuthStateChange fires and sets identity; nothing extra needed.
    return { error: null }
  }

  // --------------------------------------------------------------------------
  // signOut
  // --------------------------------------------------------------------------
  const signOut = async () => {
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut()
    }
    localStorage.removeItem(STORAGE_KEY)
    setIdentity(null)
  }

  return (
    <AuthContext.Provider
      value={{ identity, signIn, signUp, signOut, isLocalMode: !isSupabaseConfigured }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

// ---------------------------------------------------------------------------
// Convenience helper for chief-evaluator gating (does not hide routes yet)
// ---------------------------------------------------------------------------
export function useIsChief(): boolean {
  const { identity } = useAuth()
  return identity?.role === 'chief_evaluator' || identity?.role === 'admin'
}
