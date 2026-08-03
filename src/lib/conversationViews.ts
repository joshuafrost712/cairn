/**
 * When this device last opened each conversation.
 *
 * Deliberately local and deliberately not synced. Its only job is to answer "has
 * the guidance changed since I read it", which is a question about this person on
 * this device; syncing it would make an evaluator's phone mark a conversation as
 * read because they glanced at it on a laptop, and the point of the signal is that
 * revised guidance is not missed.
 *
 * Storage failures are swallowed on purpose. A private-mode browser with no
 * localStorage should cost the reader a freshness marker, never the page.
 */
const KEY = 'cairn.conversation_views'

export type ConversationViews = Record<string, string>

export function readConversationViews(): ConversationViews {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Filter rather than trust: a hand-edited or half-written value should degrade
    // to "never viewed" for the bad entries, not throw on every render.
    const out: ConversationViews = {}
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'string') out[id] = at
    }
    return out
  } catch {
    return {}
  }
}

export function markConversationViewed(
  views: ConversationViews,
  id: string,
  nowIso: string,
): ConversationViews {
  const next = { ...views, [id]: nowIso }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* no storage: the marker is a convenience, not the page */
  }
  return next
}
