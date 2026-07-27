import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { AppUser } from '../lib/types'

/**
 * Route gate.
 *
 * NOT a security boundary. RLS is
 * (supabase/migrations/20260707000600_role_allowlist_and_rls.sql), and this
 * component runs entirely in the client where the user controls it. Its job is
 * to keep a wrong-role user from landing on a page whose queries return nothing
 * useful, and to stop an evaluator from wandering into roster editing by URL —
 * which today they can, because no route in the app is guarded at all.
 *
 * `status === 'checking'` renders nothing rather than redirecting. Identity
 * arrives from the session first and is elevated when the app_user row lands
 * (AuthContext's adoptSession), so redirecting on the first frame would bounce a
 * real admin off /admin on every cold load.
 *
 * Works both as a wrapper (`<RequireRole roles={...}><Page/></RequireRole>`) and
 * as a layout route (`<Route element={<RequireRole roles={...} />}>`): the route
 * tree uses the second form, page-level guards want the first.
 *
 * The role lists themselves live in ./roles so this file exports only a
 * component (the react-refresh lint rule, and it is right: mixing the two means
 * editing a constant blows away component state on every hot reload).
 */
export function RequireRole({
  roles,
  children,
}: {
  roles: AppUser['role'][]
  children?: ReactNode
}) {
  const { identity, status } = useAuth()
  const loc = useLocation()

  if (status === 'checking') return null
  if (!identity) return <Navigate to="/" replace />
  if (!roles.includes(identity.role)) {
    return <Navigate to="/" replace state={{ denied: loc.pathname }} />
  }
  return <>{children ?? <Outlet />}</>
}
