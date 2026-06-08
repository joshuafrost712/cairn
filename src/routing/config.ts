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
