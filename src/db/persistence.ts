/**
 * Ask the browser to stop evicting this origin's storage.
 *
 * Every capture starts its life in IndexedDB and lives there alone until a push
 * succeeds. Without a persistence grant that is a cache, not a store: Safari
 * discards script-writable storage after seven days without user interaction on
 * macOS as well as iOS, and Chromium evicts the least-recently-used origin under
 * disk pressure. An evaluator who dictated for three days on a flaky venue
 * connection is exactly the person that policy is written to delete, and this app
 * never re-pulls an unsynced row (`capturesToAdopt` only adopts what the device
 * does not already hold), so an eviction is silent and final.
 *
 * `persist()` is a request, not a command. Chromium grants it silently when the
 * site looks engaged (installed, bookmarked, high engagement score) and refuses
 * otherwise; Firefox may prompt; Safari has no grant at all and resolves false.
 * So a false is normal and must not read as an error. It is still worth asking on
 * every start: the answer changes as engagement grows, and a refusal today can
 * become a grant next week without the user doing anything deliberate.
 *
 * Deliberately not awaited by the render path. This is a durability request, not
 * a prerequisite, and blocking first paint on it would trade a real cost for a
 * probabilistic benefit.
 */

export interface StorageDurability {
  /** The browser has promised not to evict this origin without the user asking. */
  persisted: boolean
  /** The API is missing entirely (older Safari, some in-app browsers). */
  unsupported: boolean
}

/**
 * Request persistent storage, returning what the browser actually decided.
 *
 * Checks `persisted()` first because `persist()` re-prompts in browsers that
 * prompt, and re-asking somebody who already said yes is how a permission gets
 * revoked.
 */
export async function requestPersistentStorage(): Promise<StorageDurability> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return { persisted: false, unsupported: true }
  }
  try {
    if (await navigator.storage.persisted()) return { persisted: true, unsupported: false }
    const granted = await navigator.storage.persist()
    return { persisted: granted, unsupported: false }
  } catch {
    // A SecurityError here means a storage-partitioned or sandboxed context (an
    // in-app browser, a third-party frame). Same practical answer as a refusal.
    return { persisted: false, unsupported: false }
  }
}

/**
 * Fire-and-forget wrapper for the app entry point. Logs the verdict, because
 * "why did my drafts vanish" is a question somebody will ask later and the
 * console is where the answer has to already be.
 */
export function ensurePersistentStorage(): void {
  void requestPersistentStorage().then(({ persisted, unsupported }) => {
    if (persisted) return
    console.warn(
      unsupported
        ? '[cairn] persistent storage unsupported in this browser; unsynced captures can be evicted'
        : '[cairn] persistent storage not granted; unsynced captures can be evicted. Sync often.',
    )
  })
}
