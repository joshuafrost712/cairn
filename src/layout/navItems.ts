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
  /** See NavGroup.scope. An item may widen its group's question. */
  scope?: NavScope
}

/**
 * Which workshop the role question is asked about (tl-17).
 *
 * `active` is the default and the right answer everywhere but one: a link is
 * offered when you may use it HERE. `/workshops` is the exception, because it is
 * the page you open when here is the wrong place — asking the active-workshop
 * question about it would hide the link from the administrator who most needs it,
 * the one sitting in a workshop where they are only an evaluator.
 */
export type NavScope = 'active' | 'anywhere'

export interface NavGroup {
  labelId: string
  /** Undefined means every signed-in user sees it. */
  roles?: WorkshopRole[]
  /** Defaults to 'active'. */
  scope?: NavScope
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
    // tl-17. Its own group, above everything, and asked as an ANYWHERE question:
    // every other group is gated on the active workshop, which would hide this
    // one from exactly the person it is for. One item, because the wave's other
    // cross-workshop surfaces are deliberately out of scope.
    labelId: 'nav.group.workshops',
    roles: ADMIN_ROLES,
    scope: 'anywhere',
    items: [{ labelId: 'nav.workshops', to: '/workshops', end: true }],
  },
  {
    labelId: 'nav.group.capture',
    items: [
      { labelId: 'nav.home', to: '/', end: true },
      { labelId: 'nav.my-evaluations', to: '/evaluations' },
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
      // tl-18. ADMIN_ROLES rather than the group's CHIEF_ROLES: the page names
      // other evaluators' stuck work and links to the routing surface, both of
      // which tl-03 settled as an administrator's business.
      { labelId: 'nav.sync-health', to: '/admin/sync-health', roles: ADMIN_ROLES },
      { labelId: 'nav.events', to: '/admin/events', end: true },
      { labelId: 'nav.participants', to: '/admin/participants', end: true },
      { labelId: 'nav.evaluators', to: '/admin/evaluators', end: true },
    ],
  },
  {
    labelId: 'nav.group.configure',
    roles: CHIEF_ROLES,
    items: [
      // tl-07: one entry for the whole workshop definition. It replaces the three
      // that used to be here (Builder, Roster, Settings), which presented one act
      // as three unrelated pages and left a first-time administrator to guess the
      // order. ADMIN_ROLES because the hub is admin-gated; the sections inside it
      // are reachable from the hub rather than each holding a nav line.
      { labelId: 'nav.setup', to: '/admin/setup', roles: ADMIN_ROLES },
      // No `roles`, so it inherits the group's CHIEF_ROLES. That is deliberate
      // and matches report_assignment's write policy, which names the same set:
      // a chief evaluator who may rebalance the rota in the database should see
      // the link to the page that does it.
      { labelId: 'nav.assignments', to: '/admin/assignments', count: (c) => c.underAssigned },
      { labelId: 'nav.records', to: '/admin/records', roles: ADMIN_ROLES },
      // tl-03: moved out of the capture group, where it was visible to every
      // signed-in user. ADMIN_ROLES, not the group's CHIEF_ROLES, because the page
      // carries a credential field and a chief evaluator has no business holding
      // the routing repo's token.
      { labelId: 'nav.routing', to: '/admin/routing', roles: ADMIN_ROLES },
      { labelId: 'nav.data', to: '/admin/data', roles: ADMIN_ROLES },
    ],
  },
]
