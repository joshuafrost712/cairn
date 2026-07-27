import { useSyncExternalStore } from 'react'

// Which scenario (workshop) the app is currently pointed at. Persisted per-device
// in localStorage so the Scenario Builder can author or preview one scenario while
// the evaluator flow (Home/Capture) reads the same selection. Falls back to the
// first workshop when unset or when the selected id no longer exists.

const KEY = 'cairn.active_workshop_id'
const listeners = new Set<() => void>()

export function getActiveWorkshopId(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setActiveWorkshopId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode / storage disabled — selection just won't persist */
  }
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

/** Reactive read of the active workshop id (updates on set + cross-tab storage events). */
export function useActiveWorkshopId(): string | null {
  return useSyncExternalStore(subscribe, getActiveWorkshopId, () => null)
}
