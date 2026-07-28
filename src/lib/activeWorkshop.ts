import { useSyncExternalStore } from 'react'

// Which scenario (workshop) the app is currently pointed at. Persisted per-device
// in localStorage so the Scenario Builder can author or preview one scenario while
// the evaluator flow (Home/Capture) reads the same selection.
//
// Since tl-01 this value is VALIDATED INPUT, never an authorization claim. Roles
// are per-workshop, so a stored id the user holds no membership in would
// otherwise be the client naming its own privileges. The rule lives in
// src/auth/membership.ts (resolveActiveWorkshopId) and is applied in AuthContext
// on load and on every switch; layout/roles.ts re-resolves it when reading a role
// so no render can use an id the memberships do not support. The database does
// not consult this value at all: RLS derives the workshop scope from auth.uid().

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
