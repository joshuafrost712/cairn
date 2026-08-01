import { useAuth } from '../auth/AuthContext'
import { hasRoleInWorkshop, resolveActiveWorkshopId, roleInWorkshop } from '../auth/membership'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import type { WorkshopRole } from '../lib/types'

/** Roles that may see the chief-evaluator surfaces: the workbench and dashboards. */
export const CHIEF_ROLES: WorkshopRole[] = ['chief_evaluator', 'admin', 'chief_admin']

/** Roles that may see configuration and destructive operations. */
export const ADMIN_ROLES: WorkshopRole[] = ['admin', 'chief_admin']

/**
 * Which workshop the role question is being asked about.
 *
 * The stored selection is re-resolved against the caller's real memberships here
 * as well as in AuthContext, because the two can disagree for one render: the
 * effect that corrects `localStorage` runs after the render that reads it. Asking
 * the pure resolver both times means a stale stored id never produces a frame
 * where the UI shows a role the user does not hold.
 */
export function useScopedWorkshopId(): string | null {
  const { memberships } = useAuth()
  const stored = useActiveWorkshopId()
  return resolveActiveWorkshopId(stored, memberships)
}

/**
 * The signed-in user's role in the active workshop, or null when they hold no
 * membership in it.
 *
 * Not a security boundary: it decides what to render. Every read and write is
 * re-checked by RLS against auth.uid()
 * (supabase/migrations/20260728000700_workshop_membership.sql), so a user who
 * forges a workshop id gets a differently-shaped UI over an empty database.
 */
export function useWorkshopRole(): WorkshopRole | null {
  const { memberships } = useAuth()
  const workshopId = useScopedWorkshopId()
  return roleInWorkshop(memberships, workshopId)
}

/**
 * Whether the signed-in user holds one of `roles` in the active workshop.
 *
 * The sidebar hides what RequireRole would block, and both must read the same
 * list or a link will appear that only ever bounces the user home.
 */
export function useHasWorkshopRole(roles: readonly WorkshopRole[]): boolean {
  const { memberships } = useAuth()
  const workshopId = useScopedWorkshopId()
  return hasRoleInWorkshop(memberships, workshopId, roles)
}

/** Chief-evaluator-and-above in the active workshop. */
export function useIsChief(): boolean {
  return useHasWorkshopRole(CHIEF_ROLES)
}

/**
 * Whether the signed-in user holds one of `roles` in ANY workshop they belong to.
 *
 * The active-workshop hooks above answer "what may I do here", which is the right
 * question for every surface except one. `/workshops` is the page you go to
 * BECAUSE you are in the wrong workshop, so gating it on the active workshop
 * would lock an admin out of the only control that would fix that: an
 * administrator of the Crash Course who is currently pointed at Bali, where they
 * are only an evaluator, would be bounced home by the very page that exists to
 * move them.
 *
 * Still not a security boundary, for the same reason as its siblings: it decides
 * what to render, and every row behind it is re-scoped by RLS from auth.uid().
 */
export function useHasWorkshopRoleAnywhere(roles: readonly WorkshopRole[]): boolean {
  const { memberships } = useAuth()
  return memberships.some((m) => roles.includes(m.role))
}

/**
 * The platform tier, which is a different question from any workshop role.
 *
 * Only `platform_owner` may INSERT a workshop (the `workshop_insert` policy in
 * 20260728000700_workshop_membership.sql), so this is what the Create button
 * mirrors. Read from the `app_user` row via AuthContext, never from session
 * metadata — see identityFromSession for why that distinction is load-bearing.
 */
export function useIsPlatformOwner(): boolean {
  const { identity } = useAuth()
  return identity?.platformRole === 'platform_owner'
}
