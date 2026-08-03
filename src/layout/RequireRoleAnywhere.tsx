import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useHasWorkshopRoleAnywhere, useIsPlatformOwner } from './roles'
import type { WorkshopRole } from '../lib/types'

/**
 * Route gate for the one page that is deliberately not about the active workshop.
 *
 * `RequireRole` asks "what may you do HERE", which is right for every workshop
 * surface and wrong for `/workshops`: that page exists because you are pointed at
 * the wrong workshop, so gating it on the workshop you are pointed at would lock
 * the administrator out of the control that fixes it. Somebody who runs the Crash
 * Course but is currently in Bali as an evaluator would be bounced home by the
 * only page that could move them.
 *
 * Same non-boundary caveat as its sibling: this decides what renders. Every row
 * behind it is re-scoped by RLS from auth.uid(), so a user who forges their way
 * onto this page gets cards for the workshops they actually belong to, which is
 * the same thing they would have got anyway.
 *
 * Deliberately its own file rather than a prop on RequireRole. The two answer
 * different questions, and a boolean parameter switching between "here" and
 * "anywhere" is exactly the kind of flag a later reader gets backwards.
 */
export function RequireRoleAnywhere({
  roles,
  /**
   * Let a platform owner through on the tier alone.
   *
   * Only `platform_owner` may create a workshop, so the person who has one to
   * create is exactly the person who might hold no admin membership yet. Kept an
   * explicit opt-in rather than folded into the role check, because "platform
   * owner sees everything" is precisely the ambient authority tl-01 took apart.
   */
  orPlatformOwner = false,
}: {
  roles: readonly WorkshopRole[]
  orPlatformOwner?: boolean
}) {
  const { identity, status, membershipStatus } = useAuth()
  const hasRole = useHasWorkshopRoleAnywhere(roles)
  const isOwner = useIsPlatformOwner()
  const loc = useLocation()

  if (status === 'checking' || membershipStatus === 'loading') return null
  if (!identity) return <Navigate to="/" replace />
  if (!hasRole && !(orPlatformOwner && isOwner)) {
    return <Navigate to="/" replace state={{ denied: loc.pathname }} />
  }
  return <Outlet />
}
