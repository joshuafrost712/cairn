import type { WorkshopRole } from './types'

/**
 * The promotion matrix, as pure functions.
 *
 * This is the TypeScript twin of the `can_grant` SQL function in
 * supabase/migrations/20260731000300_chief_admin_and_matrix.sql. The database is
 * the enforcement; this copy exists so the UI can disable an action the server
 * would refuse, rather than offering a button whose only effect is an error.
 *
 * **Not a security boundary.** Every rule here is re-derived server-side from
 * `auth.uid()` inside a security-definer RPC, so a client that skips these checks
 * gets a refusal rather than a privilege. Keep them in step anyway: a mirror that
 * drifts produces a UI that either hides a legitimate action or promises an
 * illegitimate one, and both read as bugs. test/permissions.test.ts and
 * scripts/tl02-rls-tests.sql walk the same cells.
 *
 * The asymmetry being encoded is Joshua's, and it is deliberate: a chief admin
 * manages admins, while an admin can only add and remove evaluators. Delegating
 * administration must never delegate control of the workshop itself.
 */

/** The roles a chief admin may hand out. `chief_admin` is absent on purpose. */
export const CHIEF_ADMIN_GRANTABLE: readonly WorkshopRole[] = [
  'admin',
  'chief_evaluator',
  'consultant',
  'evaluator',
  'participant',
]

/** The one role an admin may hand out. */
export const ADMIN_GRANTABLE: readonly WorkshopRole[] = ['evaluator']

/**
 * Whether `actorRole` may set `targetCurrentRole` to `requestedRole` in the same
 * workshop.
 *
 * `null` for `targetCurrentRole` means the person is not yet a member; `null` for
 * `requestedRole` means removal. One function answers both the grant and the
 * revoke question so there is only ever one copy of the matrix.
 *
 * Self-action is deliberately not decided here, because it needs identity rather
 * than role: see `canRemoveSelf`. The server checks both.
 */
export function canGrant(
  actorRole: WorkshopRole | null,
  targetCurrentRole: WorkshopRole | null,
  requestedRole: WorkshopRole | null,
): boolean {
  // Nobody reaches chief_admin through a grant. Transfer is its own operation.
  if (requestedRole === 'chief_admin') return false
  // The chief admin's row is untouchable by any grant or revoke, including their
  // own. That single rule is what keeps the slot from being emptied.
  if (targetCurrentRole === 'chief_admin') return false

  if (actorRole === 'chief_admin') {
    return requestedRole === null || CHIEF_ADMIN_GRANTABLE.includes(requestedRole)
  }
  if (actorRole === 'admin') {
    // An admin may act only on somebody who holds no membership or holds
    // evaluator. Reading "may grant evaluator only" any wider would let an admin
    // convert a participant into an evaluator, which is a privilege change on a
    // person they were never given authority over.
    const targetInReach = targetCurrentRole === null || targetCurrentRole === 'evaluator'
    const requestInReach = requestedRole === null || ADMIN_GRANTABLE.includes(requestedRole)
    return targetInReach && requestInReach
  }
  return false
}

/** Removal is a grant of nothing; kept as its own name because call sites read better. */
export function canRemove(
  actorRole: WorkshopRole | null,
  targetCurrentRole: WorkshopRole | null,
): boolean {
  return canGrant(actorRole, targetCurrentRole, null)
}

/**
 * Whether the caller may remove their own membership.
 *
 * Open to everyone except the chief admin: leaving a workshop you were added to
 * should not require anybody's permission, but the chief admin leaving would
 * strand the workshop, so their exit is a transfer.
 */
export function canRemoveSelf(actorRole: WorkshopRole | null): boolean {
  return actorRole !== null && actorRole !== 'chief_admin'
}

/**
 * Whether the caller may hand the chief admin role to someone else.
 *
 * The platform owner's clause is the recovery path and the only cross-workshop
 * power in the system: without it, a workshop whose chief admin's account is gone
 * could never get another one, since "the slot can never be emptied" would have
 * locked it permanently.
 */
export function canTransferChiefAdmin(
  actorRole: WorkshopRole | null,
  isPlatformOwner: boolean,
): boolean {
  return actorRole === 'chief_admin' || isPlatformOwner
}

/** Which roles this actor may offer for a given target, for rendering a menu. */
export function grantableRoles(
  actorRole: WorkshopRole | null,
  targetCurrentRole: WorkshopRole | null,
): WorkshopRole[] {
  const candidates: readonly WorkshopRole[] =
    actorRole === 'chief_admin' ? CHIEF_ADMIN_GRANTABLE : ADMIN_GRANTABLE
  return candidates.filter((r) => canGrant(actorRole, targetCurrentRole, r))
}
