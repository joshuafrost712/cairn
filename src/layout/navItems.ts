import type { WorkshopRole } from '../lib/types'
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
  roles?: WorkshopRole[]
}

export interface NavGroup {
  labelId: string
  /** Undefined means every signed-in user sees it. */
  roles?: WorkshopRole[]
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
      {
        labelId: 'nav.outgoing',
        to: '/outgoing',
        end: true,
        count: (c) => c.draftsNeedingAttention,
      },
      { labelId: 'nav.day-email', to: '/day-email' },
      { labelId: 'nav.export', to: '/export' },
    ],
  },
  {
    labelId: 'nav.group.dashboard',
    roles: CHIEF_ROLES,
    items: [
      { labelId: 'nav.overview', to: '/admin/overview' },
      { labelId: 'nav.progress', to: '/admin/progress' },
      { labelId: 'nav.workshop-health', to: '/admin/workshop' },
      { labelId: 'nav.events', to: '/admin/events', end: true },
      { labelId: 'nav.participants', to: '/admin/participants', end: true },
      { labelId: 'nav.evaluators', to: '/admin/evaluators', end: true },
    ],
  },
  {
    labelId: 'nav.group.configure',
    roles: CHIEF_ROLES,
    items: [
      { labelId: 'nav.builder', to: '/builder' },
      // No `roles`, so it inherits the group's CHIEF_ROLES. That is deliberate
      // and matches report_assignment's write policy, which names the same set:
      // a chief evaluator who may rebalance the rota in the database should see
      // the link to the page that does it.
      { labelId: 'nav.assignments', to: '/admin/assignments', count: (c) => c.underAssigned },
      { labelId: 'nav.roster', to: '/admin/roster', roles: ADMIN_ROLES },
      { labelId: 'nav.records', to: '/admin/records', roles: ADMIN_ROLES },
      { labelId: 'nav.settings', to: '/admin/settings', roles: ADMIN_ROLES },
      { labelId: 'nav.data', to: '/admin/data', roles: ADMIN_ROLES },
    ],
  },
]
