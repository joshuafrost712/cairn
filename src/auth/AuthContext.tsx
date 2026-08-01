/* eslint-disable react-refresh/only-export-components -- provider + its hook are co-located by design */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import type { PlatformRole, WorkshopMember, WorkshopRole } from '../lib/types'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { refreshMemberships, synthesizeLocalMembership, cachedMemberships } from '../db/membership'
import { activeWorkshopNeedsCorrection, resolveActiveWorkshopId } from './membership'
import { getActiveWorkshopId, setActiveWorkshopId } from '../lib/activeWorkshop'

// ---------------------------------------------------------------------------
// Identity shape (shared by both auth paths)
// ---------------------------------------------------------------------------

export interface Identity {
  name: string
  email: string
  /**
   * The platform tier only. Every evaluation-facing role is per-workshop and
   * lives in `memberships` — ask `useWorkshopRole()`, not this field.
   */
  platformRole: PlatformRole
  /** `app_user.id`, the key memberships hang off. Null until the row is read. */
  appUserId: string | null
  signedInAt: string // ISO timestamp
}

/**
 * Whether the caller's memberships have been resolved yet.
 *
 * Same problem `AuthStatus` solves, one level down: an empty membership list means
 * both "still loading" and "you belong to no workshop", and those two demand
 * opposite renders. Conflating them flashes the "nobody has added you yet" screen
 * at every legitimate member on every cold load.
 */
export type MembershipStatus = 'loading' | 'ready'

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

/**
 * The stable id a local-only profile hangs its cached memberships off. There is
 * no `app_user` row in this mode, so the email is the identity.
 */
const localAppUserId = (email: string) => `local::${email.trim().toLowerCase()}`

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
    // An identity stored before tl-01 carries the old `role` field and no
    // appUserId. Normalize rather than discard, so a local-mode profile is not
    // silently signed out by an upgrade; the workshop role comes back from the
    // cached memberships keyed on this same id.
    return {
      ...parsed,
      platformRole: parsed.platformRole === 'platform_owner' ? 'platform_owner' : 'member',
      appUserId: parsed.appUserId ?? localAppUserId(parsed.email),
    } as Identity
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
  /** The caller's own memberships. Empty and `membershipStatus === 'ready'` means no workshop. */
  memberships: WorkshopMember[]
  membershipStatus: MembershipStatus
  /** Re-read memberships from the backend (after being added to a workshop, say). */
  reloadMemberships: () => Promise<void>
  /** Supabase path: email + password. Local path: name + email (password ignored). */
  signIn: (emailOrName: string, emailOrPassword: string, passwordOrRole?: string, roleForLocal?: WorkshopRole) => Promise<{ error: string | null }>
  signUp: (name: string, email: string, password: string) => Promise<{ error: string | null; confirmationRequired?: boolean }>
  signOut: () => Promise<void>
  /** True when operating on local-only identity (no Supabase configured). */
  isLocalMode: boolean
}

const AuthContext = createContext<AuthValue | null>(null)

// ---------------------------------------------------------------------------
// Helper: convert a Supabase session + optional app_user row into Identity
// ---------------------------------------------------------------------------

interface AppUserRow {
  id: string
  name: string
  role: string
}

/**
 * Build an Identity from a session, optionally enriched by the user's `app_user`
 * row.
 *
 * Neither the platform tier nor any workshop role is taken from `user_metadata`.
 * That field is written by the client at signup, so trusting it would let an
 * account self-assert its way into the elevated UI. (The role picker it used to
 * carry is gone as of tl-11; the principle stands for anything else put there.) The `app_user`
 * row is the only source for the platform tier, and `workshop_member` the only
 * source for a workshop role, so a session on its own yields the least privilege
 * and we elevate once the rows arrive. Display name still falls back to metadata,
 * which is harmless.
 *
 * This only governs what the client renders; the real boundary is RLS
 * (supabase/migrations/20260728000700_workshop_membership.sql).
 */
function identityFromSession(user: User, appUser: AppUserRow | null): Identity {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const name =
    appUser?.name ??
    (meta.name as string | undefined) ??
    user.email ??
    'Unknown'
  return {
    name,
    email: user.email ?? '',
    platformRole: appUser?.role === 'platform_owner' ? 'platform_owner' : 'member',
    appUserId: appUser?.id ?? null,
    signedInAt: new Date().toISOString(),
  }
}

/**
 * On-device copy of the caller's own `app_user` row, keyed by email.
 *
 * Without this, offline is broken in a way that is easy to miss and was: the row
 * is fetched over the network on every start, so a cold offline start cannot learn
 * its own `app_user.id`, cannot key the cached memberships off it, and lands a
 * perfectly legitimate member on "you have not been added to a workshop yet". The
 * membership cache alone is not enough — the device also has to remember who it is.
 *
 * Keyed by email, which is what makes it safe on a shared device: another account
 * signing in reads its own entry, misses, and waits for the network rather than
 * inheriting the previous person's id. And like the membership cache it is a render
 * hint, never an authorization source — RLS re-derives everything from auth.uid(),
 * so a tampered entry changes what the UI offers and nothing about what comes back.
 */
const APP_USER_CACHE_PREFIX = 'cairn.app_user.'

function cacheAppUser(email: string, row: AppUserRow): void {
  try {
    localStorage.setItem(APP_USER_CACHE_PREFIX + email.trim().toLowerCase(), JSON.stringify(row))
  } catch {
    /* private mode / storage disabled — offline identity just won't persist */
  }
}

function cachedAppUser(email: string): AppUserRow | null {
  try {
    const raw = localStorage.getItem(APP_USER_CACHE_PREFIX + email.trim().toLowerCase())
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AppUserRow>
    if (!parsed.id || !parsed.name) return null
    return {
      id: parsed.id,
      name: parsed.name,
      role: parsed.role === 'platform_owner' ? 'platform_owner' : 'member',
    }
  } catch {
    return null
  }
}

/**
 * Fetch the caller's `app_user` row. Bounded and never throws: a failure here
 * must degrade the identity, never block sign-in.
 */
async function fetchAppUser(email: string): Promise<AppUserRow | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('app_user')
      .select('id, name, role')
      .eq('email', email)
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS))
      .maybeSingle()
    if (error) {
      // Not fatal: the session still stands, the user just keeps the
      // least-privileged tier and their email/metadata name.
      console.warn('app_user lookup failed; continuing with session-derived identity.', error)
      return null
    }
    return data as AppUserRow | null
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

  // ---- Memberships ----
  //
  // Held as "whose memberships these are, and what they were", rather than as a
  // list plus a separate status flag. Keeping the owner in the same state value is
  // what makes the loading question derivable: if the loaded id is not the current
  // account's, the answer on screen belongs to somebody else and the correct
  // status is 'loading'. A separate flag would need resetting from an effect on
  // every account change, which is both a cascading render and a window in which
  // the previous account's roles are reported as current.
  const [loaded, setLoaded] = useState<{ id: string | null; rows: WorkshopMember[] }>({
    id: null,
    rows: [],
  })

  // Whether the `app_user` lookup has finished, successfully or not. Needed
  // because `appUserId === null` on a signed-in account means two different
  // things: "the row has not arrived yet" (wait) and "the row could not be read"
  // (a terminal state the UI must name). Without this the second case would sit
  // forever on a spinner. Local-only mode has no row to look up.
  const [profileChecked, setProfileChecked] = useState(!isSupabaseConfigured)

  const appUserId = identity?.appUserId ?? null
  // Memoized because the empty-list branch would otherwise be a fresh array on
  // every render, and it is an effect dependency below.
  const memberships = useMemo(
    () => (loaded.id === appUserId ? loaded.rows : []),
    [loaded, appUserId],
  )
  const membershipStatus: MembershipStatus =
    status === 'checking' ? 'loading'
    : !identity ? 'ready'
    : appUserId == null ? (profileChecked ? 'ready' : 'loading')
    : loaded.id === appUserId ? 'ready'
    : 'loading'

  // Load whenever the answer on screen belongs to a different account than the
  // one signed in. The Supabase path fetches and re-caches; the local-only path
  // reads the cache written at sign-in. Either way the result is the same shape,
  // so nothing downstream needs to know which mode it is in.
  useEffect(() => {
    if (!appUserId || loaded.id === appUserId) return
    let cancelled = false
    const load = isSupabaseConfigured
      ? refreshMemberships(appUserId)
      : cachedMemberships(appUserId)
    void load.then((rows) => {
      if (cancelled) return
      setLoaded({ id: appUserId, rows })
    })
    return () => {
      cancelled = true
    }
  }, [appUserId, loaded.id])

  const reloadMemberships = async () => {
    if (!appUserId) return
    const rows = isSupabaseConfigured
      ? await refreshMemberships(appUserId)
      : await cachedMemberships(appUserId)
    setLoaded({ id: appUserId, rows })
  }

  // ---- Validate the device's active-workshop selection ----
  //
  // `localStorage` stays the transport, but it is now validated input rather than
  // an authorization claim: an id the user does not hold a membership in is
  // discarded, not honored. Runs only once memberships are settled, so a slow
  // fetch cannot clear a perfectly good selection on the way past.
  useEffect(() => {
    if (membershipStatus !== 'ready') return
    const stored = getActiveWorkshopId()
    if (!activeWorkshopNeedsCorrection(stored, memberships)) return
    setActiveWorkshopId(resolveActiveWorkshopId(stored, memberships))
  }, [memberships, membershipStatus])

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
        // A different account's profile question is unanswered again. Without this
        // reset, signing in as somebody else would inherit the previous account's
        // "settled" flag and flash the no-workshop screen while the row loads.
        setProfileChecked(false)
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
        if (row) cacheAppUser(email, row)
        // Offline, or the lookup failed: fall back to what this device already knows
        // about this email. `authoritative` stays false in that case, so the next
        // session event re-fetches rather than trusting the cache indefinitely.
        const resolved = row ?? cachedAppUser(email)
        applied.current = { email, authoritative: row !== null, enriching: false }
        // Settled either way. Still no row and nothing cached means the session has
        // no resolvable memberships, which the UI names rather than spins on.
        setProfileChecked(true)
        if (resolved) setIdentity(identityFromSession(user, resolved))
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
    roleForLocal: WorkshopRole = 'evaluator',
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
    const id = localAppUserId(email)
    const next: Identity = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      platformRole: 'member',
      appUserId: id,
      signedInAt: new Date().toISOString(),
    }
    // Write the synthesized membership BEFORE the identity lands, or the effect
    // that reads the cache races the write and settles on "no workshop".
    const rows = await synthesizeLocalMembership(id, roleForLocal)
    setLoaded({ id, rows })
    setIdentity(next)
    setStatus('signedIn')
    return { error: null }
  }

  // --------------------------------------------------------------------------
  // signUp (Supabase only)
  // --------------------------------------------------------------------------
  /**
   * Create an account.
   *
   * No role argument since tl-11. It used to carry the sign-up form's picker into
   * `raw_user_meta_data`, where `handle_new_user` honored it if the allowlist
   * happened to permit it — a request the server was free to ignore and usually
   * did. A workshop role now comes from the invitation that let the account exist
   * at all, so passing one here would be a field nobody reads pretending to be a
   * choice somebody made.
   */
  const signUp = async (
    name: string,
    email: string,
    password: string,
  ): Promise<{ error: string | null; confirmationRequired?: boolean }> => {
    if (!isSupabaseConfigured || !supabase) {
      return { error: 'Supabase is not configured; use local-only sign-in.' }
    }
    try {
      const { data, error: authErr } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: { data: { name: name.trim() } },
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
    setLoaded({ id: null, rows: [] })
  }

  return (
    <AuthContext.Provider
      value={{
        identity,
        status,
        memberships,
        membershipStatus,
        reloadMemberships,
        signIn,
        signUp,
        signOut,
        isLocalMode: !isSupabaseConfigured,
      }}
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

// The chief-evaluator convenience helper now lives in ../layout/roles.ts, because
// the question it answers ("is this person a chief here?") is per-workshop and
// needs the active-workshop selection that roles.ts already resolves.
