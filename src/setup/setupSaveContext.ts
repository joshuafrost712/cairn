import { createContext } from 'react'
import type { SetupChange, SetupImpact, WorkshopState } from './impact'

/**
 * One setup save, described well enough to be classified before it commits.
 *
 * `commit` performs the actual write (through the app's own offline-first write
 * path — referenceWrite, db/admin, db/settings — never straight to Supabase). It
 * is called only after the administrator has accepted the impact, or immediately
 * when the impact is `safe`.
 */
export interface SetupSaveRequest {
  change: SetupChange
  commit: () => Promise<void>
}

export interface SetupSaveApi {
  /**
   * Classify, warn if needed, then commit. Resolves when the save has either
   * committed or been shown to the administrator for a decision; it does NOT wait
   * for that decision, because a form must not block on a modal.
   */
  request: (request: SetupSaveRequest) => Promise<void>
  /** The workshop state every classification in this subtree is judged against. */
  state: WorkshopState
  /** A save is in flight. */
  busy: boolean
  /** The impact currently on screen, or null. Exposed for tests and for the hub. */
  awaiting: { change: SetupChange; impact: SetupImpact } | null
}

/**
 * Null rather than a working default on purpose: a section rendered outside the
 * provider would otherwise save with no warning layer at all, silently. The hook
 * throws instead, naming the fix.
 */
export const SetupSaveContext = createContext<SetupSaveApi | null>(null)
