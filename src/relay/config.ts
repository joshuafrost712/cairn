/**
 * Where this device's relay is, and the token that lets it in (tl-21).
 *
 * DEVICE-LOCAL, FOLLOWING THE ROUTING PAT'S PRECEDENT (`src/routing/config.ts`),
 * including its hygiene rule. A relay address is a property of a machine on a network,
 * not of a workshop: putting it in `ai_config` would sync one laptop's `127.0.0.1` to
 * every other device in the workshop, and every one of them would then try to reach a
 * service that is not there.
 *
 * That is also why this spec spends no Dexie version and no reference-outbox order. The
 * relay itself is the durable record of an in-flight job; the app has nothing new to
 * persist.
 */

const URL_KEY = 'cairn.relay.url'
const TOKEN_KEY = 'cairn.relay.token'

/** Where `npm run relay` listens unless it was moved. */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:8791'

/**
 * The addresses this build will talk to.
 *
 * LOOPBACK ONLY, and it is a scope guard rather than a nicety: the relay binds to
 * loopback, so a LAN address cannot work today, and pointing the app at one would send a
 * workshop's evidence to whatever answers on that host. Reaching a relay on another
 * machine is tl-22's decision to argue with its own security section, and when it is
 * argued this is the function that changes.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export interface RelayUrlCheck {
  ok: boolean
  value?: string
  /** A chrome node id, because a refusal is a sentence somebody reads. */
  reasonId?: string
}

/** Pure: validate and normalize a typed address. */
export function normalizeRelayUrl(input: string): RelayUrlCheck {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reasonId: 'setup.ai.relay.url-empty' }
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return { ok: false, reasonId: 'setup.ai.relay.url-unreadable' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reasonId: 'setup.ai.relay.url-unreadable' }
  }
  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) return { ok: false, reasonId: 'setup.ai.relay.url-not-local' }
  const port = url.port ? `:${url.port}` : ''
  return { ok: true, value: `${url.protocol}//${url.hostname}${port}` }
}

export function getRelayUrl(): string {
  try {
    const stored = localStorage.getItem(URL_KEY)
    if (!stored) return DEFAULT_RELAY_URL
    const checked = normalizeRelayUrl(stored)
    return checked.ok && checked.value ? checked.value : DEFAULT_RELAY_URL
  } catch {
    return DEFAULT_RELAY_URL
  }
}

/** Returns the stored value or null, so the panel can show "using the default". */
export function getStoredRelayUrl(): string | null {
  try {
    return localStorage.getItem(URL_KEY)
  } catch {
    return null
  }
}

export function setRelayUrl(input: string): RelayUrlCheck {
  const checked = normalizeRelayUrl(input)
  if (!checked.ok || !checked.value) return checked
  localStorage.setItem(URL_KEY, checked.value)
  return checked
}

export function getRelayToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setRelayToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearRelayToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/**
 * The token is the part that must be entered, so it is the test for "configured".
 * The address defaults, because one address is right on almost every machine.
 */
export function relayConfigured(): boolean {
  return Boolean(getRelayToken())
}

// ---------------------------------------------------------------------------
// Token hygiene — the same rule as the routing PAT, for the same reason
// ---------------------------------------------------------------------------

/**
 * Whether this device should be holding a relay token at all.
 *
 * Asked of every workshop the user belongs to rather than only the active one, exactly
 * as `shouldClearRoutingToken` is: an administrator of Bali who switches to a workshop
 * where they are a plain evaluator has not stopped being an administrator. Pure so the
 * decision is testable, because the failure it prevents is a credential left behind on
 * a demoted device, which nothing on screen would ever mention.
 */
export function shouldClearRelayToken(adminSomewhere: boolean, hasToken: boolean): boolean {
  return hasToken && !adminSomewhere
}

/** Apply the rule. Returns true when a token was actually removed. */
export function enforceRelayHygiene(adminSomewhere: boolean): boolean {
  if (!shouldClearRelayToken(adminSomewhere, Boolean(getRelayToken()))) return false
  clearRelayToken()
  return true
}
