/* eslint-disable react-refresh/only-export-components -- provider + its hook are co-located by design */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
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

// ---------------------------------------------------------------------------
// Timeouts
//
// Signing in must never depend on a second network request completing. See the
// comment on `applySession` below for why. These bounds are the backstops that
// keep every auth state transition finite even when a request stalls rather
// than fails — the failure mode that froze a phone on "Signing in…", because
// Chromium on Android can suspend an in-flight fetch when the tab is
// backgrounded (autofill sheet, app switch) and never resume it.
// ---------------------------------------------------------------------------

/** Bound on the non-blocking app_user profile lookup (enrichment only). */
const PROFILE_TIMEOUT_MS = 8_000

/** Bound on the credential check itself, after which we probe for a session. */
const SIGNIN_TIMEOUT_MS = 15_000

/** Bound on the initial session bootstrap before we fall back to signed-out. */
const BOOTSTRAP_TIMEOUT_MS = 10_000

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

/**
 * Whether we know yet who (if anyone) is signed in.
 *
 * `identity: null` alone is ambiguous — it means both "we haven't checked" and
 * "definitely signed out". Callers that gate rendering need to tell those apart,
 * or a cold load flashes the sign-in form at an already-signed-in user.
 */
export type AuthStatus = 'checking' | 'signedIn' | 'signedOut'

interface AuthValue {
  identity: Identity | null
  status: AuthStatus
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

/**
 * Build an Identity from a session, optionally enriched by the user's `app_user`
 * row.
 *
 * Role is deliberately NOT taken from `user_metadata`. That field is written by
 * the user at signup (SignIn's role picker), so trusting it would let an account
 * self-assert `admin` and get the elevated UI. The `app_user` row is the only
 * authoritative source, so a session on its own yields the least-privileged role
 * and we elevate once the row arrives. Display name still falls back to metadata,
 * which is harmless.
 *
 * This only governs what the client renders; the real boundary is RLS
 * (supabase/migrations/20260707000600_role_allowlist_and_rls.sql).
 */
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
  const rawRole = appUser?.role ?? 'evaluator'
  const allowed: AppUser['role'][] = ['evaluator', 'consultant', 'chief_evaluator', 'admin', 'participant']
  const role: AppUser['role'] = (allowed.includes(rawRole as AppUser['role']) ? rawRole : 'evaluator') as AppUser['role']
  return {
    name,
    email: user.email ?? '',
    role,
    signedInAt: new Date().toISOString(),
  }
}

/**
 * Fetch the caller's `app_user` row. Bounded and never throws: a failure here
 * must degrade the identity, never block sign-in.
 */
async function fetchAppUser(email: string): Promise<{ name: string; role: string } | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('app_user')
      .select('name, role')
      .eq('email', email)
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS))
      .maybeSingle()
    if (error) {
      // Not fatal: the session still stands, the user just keeps the
      // least-privileged role and their email/metadata name.
      console.warn('app_user lookup failed; continuing with session-derived identity.', error)
      return null
    }
    return data as { name: string; role: string } | null
  } catch (err) {
    console.warn('app_user lookup threw; continuing with session-derived identity.', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const localIdentity = isSupabaseConfigured ? null : loadLocal()
  const [identity, setIdentity] = useState<Identity | null>(localIdentity)
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? 'checking' : localIdentity ? 'signedIn' : 'signedOut',
  )

  // Which account is currently applied, and whether its role came from the
  // authoritative `app_user` row rather than the session alone. Guards two things:
  // a late-returning profile lookup overwriting a subsequent sign-in, and the
  // recurring TOKEN_REFRESHED event needlessly re-downgrading an enriched role.
  const applied = useRef<{ email: string; authoritative: boolean; enriching: boolean } | null>(null)

  // Whether the initial session question has been answered either way. Read from
  // callbacks (visibility, online, watchdog) that must not depend on a rendered
  // `status` value, so it lives in a ref rather than state.
  const resolved = useRef(false)

  // ---- Supabase session bootstrap ----
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return
    const client = supabase
    let disposed = false

    /**
     * Adopt a session as the signed-in identity.
     *
     * Order matters, and is the whole point of this function: identity is set
     * SYNCHRONOUSLY from the session, and the `app_user` lookup runs afterwards
     * as a detached enrichment. Awaiting that lookup before setting identity is
     * what previously froze the sign-in screen — `signInWithPassword` awaits
     * `_notifyAllSubscribers`, which awaits every `onAuthStateChange` callback,
     * so an unbounded fetch inside the callback stalls the sign-in promise, the
     * button's busy flag, and the route gate all at once.
     */
    const applySession = (session: Session) => {
      if (disposed) return
      const user = session.user
      const email = user.email ?? ''
      const isNewAccount = applied.current?.email !== email
      resolved.current = true

      // 1. In immediately, on the session alone. Skipped when this is the same
      //    account we already have, so the hourly TOKEN_REFRESHED event doesn't
      //    briefly downgrade an enriched role back to least privilege.
      if (isNewAccount) {
        applied.current = { email, authoritative: false, enriching: false }
        setIdentity(identityFromSession(user, null))
      }
      setStatus('signedIn')

      // 2. Enrich with the display name and authoritative role when it arrives,
      //    if ever. Skipped when already done or already in flight — the mount
      //    path and the INITIAL_SESSION event both land here for the same account.
      const state = applied.current
      if (!email || !state || state.authoritative || state.enriching) return
      state.enriching = true
      void fetchAppUser(email).then((row) => {
        if (disposed) return
        if (applied.current?.email !== email) return // a different account signed in meanwhile
        applied.current = { email, authoritative: row !== null, enriching: false }
        if (row) setIdentity(identityFromSession(user, row))
      })
    }

    const applySignedOut = () => {
      if (disposed) return
      applied.current = null
      resolved.current = true
      setIdentity(null)
      setStatus('signedOut')
    }

    /** Resolve the current session into state. Never throws. */
    const checkSession = async () => {
      try {
        const { data, error } = await client.auth.getSession()
        if (disposed) return
        if (error) {
          console.warn('getSession failed; treating as signed out.', error)
          applySignedOut()
          return
        }
        if (data.session) applySession(data.session)
        else applySignedOut()
      } catch (err) {
        if (disposed) return
        console.warn('getSession threw; treating as signed out.', err)
        applySignedOut()
      }
    }

    // Restore from cached session (works offline after first login).
    void checkSession()

    // Keep identity in sync across tab focus, token refresh, sign-out, etc.
    //
    // This callback MUST stay synchronous. supabase-js awaits every subscriber
    // before `signInWithPassword` resolves, so any `await` here (especially
    // another Supabase call) delays or deadlocks the caller's sign-in.
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session) applySession(session)
      else applySignedOut()
    })

    // Self-heal a bootstrap that stalled while the page was backgrounded or
    // offline — the automated version of the manual refresh that used to be the
    // only way out. Re-checks only while we still don't know the answer.
    const recheckIfUnresolved = () => {
      if (disposed || resolved.current) return
      if (document.visibilityState !== 'visible') return
      void checkSession()
    }
    const onOnline = () => { if (!disposed && !resolved.current) void checkSession() }
    document.addEventListener('visibilitychange', recheckIfUnresolved)
    window.addEventListener('online', onOnline)

    // Last resort: never leave the gate indeterminate forever. Falling back to
    // signed-out shows the sign-in form, which is recoverable; sitting on
    // "checking" is not.
    const watchdog = setTimeout(() => {
      if (disposed || resolved.current) return
      console.warn('Session check did not settle in time; showing sign-in.')
      applySignedOut()
    }, BOOTSTRAP_TIMEOUT_MS)

    return () => {
      disposed = true
      clearTimeout(watchdog)
      document.removeEventListener('visibilitychange', recheckIfUnresolved)
      window.removeEventListener('online', onOnline)
      subscription.unsubscribe()
    }
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
      const client = supabase
      const email = emailOrName.trim().toLowerCase()
      const password = emailOrPassword
      try {
        // Bound the credential check. supabase-js rethrows non-auth errors and
        // has no timeout of its own, so without this a suspended request leaves
        // the caller awaiting forever with its busy flag stuck on.
        const timedOut = Symbol('timeout')
        const result = await Promise.race([
          client.auth.signInWithPassword({ email, password }),
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => resolve(timedOut), SIGNIN_TIMEOUT_MS),
          ),
        ])

        if (result === timedOut) {
          // The request may well have succeeded server-side and persisted a
          // session before stalling. Check, so a slow network costs the user a
          // wait rather than a manual page refresh.
          const { data } = await client.auth.getSession()
          if (data.session) return { error: null }
          return { error: 'The network is not responding. Check your connection and try again.' }
        }

        if (result.error) return { error: result.error.message }
        // Identity is set by the onAuthStateChange listener above; nothing to do.
        return { error: null }
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Sign-in failed. Please try again.' }
      }
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
    setStatus('signedIn')
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
    try {
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
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not create the account. Please try again.' }
    }
  }

  // --------------------------------------------------------------------------
  // signOut
  // --------------------------------------------------------------------------
  const signOut = async () => {
    if (isSupabaseConfigured && supabase) {
      // Clear local state regardless of whether the network round-trip works, so
      // signing out is never blocked by a stalled request.
      try {
        await supabase.auth.signOut()
      } catch (err) {
        console.warn('signOut request failed; clearing local session anyway.', err)
      }
    }
    localStorage.removeItem(STORAGE_KEY)
    setIdentity(null)
    setStatus('signedOut')
  }

  return (
    <AuthContext.Provider
      value={{ identity, status, signIn, signUp, signOut, isLocalMode: !isSupabaseConfigured }}
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
