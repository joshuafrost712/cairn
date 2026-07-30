/**
 * One realtime channel per topic, refcounted (tl-18).
 *
 * supabase-js returns the EXISTING channel when you ask for a topic it already
 * holds, and calling `.on()` on a channel that has already subscribed throws.
 * React StrictMode makes that happen on every sign-in in dev: mount subscribes,
 * the cleanup's `removeChannel` completes asynchronously, and the remount asks
 * for the same topic while the old channel is still registered. The throw is
 * swallowed by the effect, and the visible cost is that the participant selector
 * stops repainting from other devices — which reads on screen as "nobody else
 * has evaluated her yet".
 *
 * Guarding by re-checking a `cancelled` flag narrows the window but does not
 * close it, because two independent callers may legitimately want the same
 * topic at once. Refcounting closes it: the second caller joins the existing
 * channel, and the channel is torn down only when the last holder releases it.
 *
 * Deliberately generic and IO-free so it can be unit-tested with a fake opener.
 */

interface Entry {
  holders: number
  close: () => void
}

const entries = new Map<string, Entry>()

/**
 * Join the channel for `topic`, opening it if nobody holds it yet. Returns a
 * release function that is safe to call more than once — an effect cleanup that
 * ran twice must not tear down a channel a later mount is using.
 */
export function acquireChannel(topic: string, open: () => () => void): () => void {
  const existing = entries.get(topic)
  if (existing) {
    existing.holders += 1
  } else {
    entries.set(topic, { holders: 1, close: open() })
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const entry = entries.get(topic)
    if (!entry) return
    entry.holders -= 1
    if (entry.holders > 0) return
    entries.delete(topic)
    entry.close()
  }
}

/** Topics currently held. Exported for tests and for the sync-health page. */
export function activeChannelTopics(): string[] {
  return [...entries.keys()].sort()
}

/** Test-only reset; production code releases through the returned function. */
export function resetChannelRegistry(): void {
  for (const entry of entries.values()) entry.close()
  entries.clear()
}
