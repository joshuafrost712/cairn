import { useAuth } from '../auth/AuthContext'
import type { AppUser } from '../lib/types'

/** Roles that may see the chief-evaluator surfaces: the workbench and dashboards. */
export const CHIEF_ROLES: AppUser['role'][] = ['chief_evaluator', 'admin']

/** Roles that may see configuration and destructive operations. */
export const ADMIN_ROLES: AppUser['role'][] = ['admin']

/**
 * Whether the signed-in user holds one of `roles`.
 *
 * The sidebar hides what RequireRole would block, and both must read the same
 * list or a link will appear that only ever bounces the user home.
 */
export function useHasRole(roles: AppUser['role'][]): boolean {
  const { identity } = useAuth()
  return identity != null && roles.includes(identity.role)
}
