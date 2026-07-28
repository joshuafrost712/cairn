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
