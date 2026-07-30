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
// Routing mode (tl-03)
//
// One mode exists and it is the default: captures go to the private GitHub repo
// and are routed by Joshua's Claude Max subscription. This is deliberately not a
// setting an evaluator can see or change — there is no code path below
// administrator that reads or writes it, and there is no picker in the UI.
//
// PROVISIONAL STORAGE. tl-13 folds the mode into a workshop-scoped `ai_config`
// row alongside the provider abstraction and the function toggles. Until then a
// single localStorage key on the administrator's own device is sufficient, and it
// must not be treated as load-bearing: nothing persists a non-default value today,
// so tl-13 is free to move this without a migration.
// ---------------------------------------------------------------------------

export type RoutingMode = 'github-claude'

export const DEFAULT_ROUTING_MODE: RoutingMode = 'github-claude'

const MODE_KEY = 'cairn.routing.mode'

/**
 * The active routing mode. Always `github-claude` today; the accessor exists so
 * tl-13 has one call site to extend rather than a hard-coded assumption spread
 * across the page. An unrecognized stored value falls back to the default rather
 * than propagating: a mode nothing can service is worse than the one that works.
 */
export function getRoutingMode(): RoutingMode {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    return stored === 'github-claude' ? stored : DEFAULT_ROUTING_MODE
  } catch {
    return DEFAULT_ROUTING_MODE
  }
}

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
