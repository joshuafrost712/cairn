import type { AppUser } from '../lib/types'
import type { NavCounts } from '../hooks/useNavCounts'
import { ADMIN_ROLES, CHIEF_ROLES } from './roles'

export interface NavItem {
  /** Chrome content id for the label, so nav wording is editable like the rest. */
  labelId: string
  to: string
  /** Match only the exact path. Needed on '/' and on section index routes. */
  end?: boolean
  /** Which count, if any, renders as the badge. */
  count?: (c: NavCounts) => number
  /** Narrower than the group's roles, for the odd item that needs it. */
  roles?: AppUser['role'][]
}

export interface NavGroup {
  labelId: string
  /** Undefined means every signed-in user sees it. */
  roles?: AppUser['role'][]
  items: NavItem[]
}

/**
 * The navigation tree, shared by the desktop sidebar and the mobile drawer so
 * the two cannot drift.
 *
 * Only routes that actually exist appear here. The DASHBOARD group lands with
 * the dashboard pages (slice 4) and CONFIGURE splits into its four pages when
 * Admin.tsx is broken up (slice 6); until then CONFIGURE points at the single
 * combined /admin page. A nav link to a route that does not exist would just
 * bounce the user to the catch-all redirect, which reads as a broken app.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelId: 'nav.group.capture',
    items: [
      { labelId: 'nav.home', to: '/', end: true },
      { labelId: 'nav.my-evaluations', to: '/evaluations' },
      { labelId: 'nav.routing', to: '/routing' },
      {
        labelId: 'nav.conversations',
        to: '/conversations',
        count: (c) => c.conversationsNeeded,
      },
    ],
  },
  {
    labelId: 'nav.group.review',
    items: [
      { labelId: 'nav.observations', to: '/observations' },
      { labelId: 'nav.reports', to: '/reports' },
    ],
  },
  {
    labelId: 'nav.group.workbench',
    roles: CHIEF_ROLES,
    items: [
      {
        labelId: 'nav.discrepancy-inbox',
        to: '/inbox',
        count: (c) => c.openDiscrepancies,
      },
      { labelId: 'nav.day-email', to: '/day-email' },
      { labelId: 'nav.export', to: '/export' },
    ],
  },
  {
    labelId: 'nav.group.configure',
    roles: CHIEF_ROLES,
    items: [
      { labelId: 'nav.builder', to: '/builder' },
      { labelId: 'nav.admin', to: '/admin', roles: ADMIN_ROLES },
    ],
  },
]
