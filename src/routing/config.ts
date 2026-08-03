// Routing config. The routing repo (where captures are exchanged with Claude) is
// set at build time; the GitHub token is entered in-app and stored on-device only
// (never committed, never in env). Captures are low-sensitivity workshop notes, but
// the token is a real credential — use a fine-grained PAT scoped to the one private
// routing repo (Contents: read & write) and treat it like the Supabase anon key:
// fine for the pilot, revisit before any wider rollout.

const TOKEN_KEY = 'cairn.routing.github_token'

/** "owner/repo" of the private routing repo, e.g. "joshuafrost712/cairn-routing". */
export function getRoutingRepo(): string | null {
  const v = import.meta.env.VITE_ROUTING_REPO as string | undefined
  return v && v.includes('/') ? v : null
}

export function getRoutingBranch(): string {
  return (import.meta.env.VITE_ROUTING_BRANCH as string | undefined) || 'main'
}

export function getRoutingToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setRoutingToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearRoutingToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Repo is set: the manual (download/upload) flow is available. */
export function isRoutingRepoConfigured(): boolean {
  return getRoutingRepo() !== null
}

/** Repo + token: the automated push/pull flow is available. */
export function canPushPull(): boolean {
  return isRoutingRepoConfigured() && Boolean(getRoutingToken())
}

// ---------------------------------------------------------------------------
// Routing mode: MOVED (tl-03 → tl-13)
//
// tl-03 kept the mode in a localStorage key here and labelled the storage
// PROVISIONAL, on the grounds that tl-13 would fold it into a workshop-scoped
// `ai_config` row. It has: see src/lib/aiConfig.ts for the resolved value and
// src/ai/providers/ for what services each mode.
//
// The accessor is GONE rather than left delegating, because two answers to "which
// mode is this workshop in" is precisely the failure the move was meant to prevent
// — and a device-local key would keep answering for a workshop it knows nothing
// about. Nothing had ever persisted a non-default value through it, so there was
// nothing to migrate; `DEFAULT_ROUTING_MODE` now lives as `DEFAULT_AI_MODE`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Token hygiene (tl-03)
// ---------------------------------------------------------------------------

/**
 * Whether this device should be holding a routing token at all.
 *
 * Asked of every workshop the user belongs to rather than only the active one. An
 * administrator of Bali who switches to a workshop where they are a plain
 * evaluator has not stopped being an administrator, and wiping their PAT on a
 * workshop switch would be a self-inflicted outage. Holding an admin role
 * *anywhere* is the honest test for "this person routes captures".
 *
 * Pure so the decision is testable: the failure it prevents is a credential left
 * behind on a demoted device, which nothing on screen would ever mention.
 */
export function shouldClearRoutingToken(adminSomewhere: boolean, hasToken: boolean): boolean {
  return hasToken && !adminSomewhere
}

/** Apply the rule above. Returns true when a token was actually removed. */
export function enforceTokenHygiene(adminSomewhere: boolean): boolean {
  if (!shouldClearRoutingToken(adminSomewhere, Boolean(getRoutingToken()))) return false
  clearRoutingToken()
  return true
}
