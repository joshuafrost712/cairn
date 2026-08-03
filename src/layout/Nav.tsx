import { NavLink } from 'react-router-dom'
import { c } from '../lib/content/chrome'
import { useAuth } from '../auth/AuthContext'
import { useNavCounts } from '../hooks/useNavCounts'
import { NAV_GROUPS } from './navItems'
import { useWorkshopRole } from './roles'
import type { NavGroup, NavScope } from './navItems'
import type { WorkshopMember, WorkshopRole } from '../lib/types'

/**
 * Whether a nav entry is offered.
 *
 * `scope` (tl-17) decides which role question is asked: the role held in the
 * active workshop, or whether the role is held in any membership at all. Only
 * `/workshops` uses the second, and the reason is in navItems.ts. Getting this
 * backwards on an ordinary entry would offer a link that RequireRole then bounces
 * — a link that only ever sends you home reads as a broken app, which is why the
 * sidebar and the gate are kept reading the same lists.
 */
function visible(
  roles: WorkshopRole[] | undefined,
  role: WorkshopRole | null,
  scope: NavScope,
  memberships: WorkshopMember[],
): boolean {
  if (!roles) return true
  if (scope === 'anywhere') return memberships.some((m) => roles.includes(m.role))
  return role != null && roles.includes(role)
}

/**
 * The navigation list itself, rendered identically in the desktop sidebar and in
 * the mobile drawer. One tree, one set of role rules, one set of badge counts.
 *
 * Active state comes from NavLink's own `aria-current="page"`, styled by
 * attribute selector in layout.css rather than by a className callback, so the
 * accessible state and the visible state are the same fact.
 */
export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useNavCounts()
  const role = useWorkshopRole()
  const { memberships } = useAuth()

  const groups: NavGroup[] = NAV_GROUPS.filter((g) =>
    visible(g.roles, role, g.scope ?? 'active', memberships),
  )

  return (
    <nav aria-label={c('nav.aria.main')}>
      {groups.map((group) => {
        const items = group.items.filter((i) =>
          visible(i.roles, role, i.scope ?? group.scope ?? 'active', memberships),
        )
        if (items.length === 0) return null
        return (
          <div className="nav__group" key={group.labelId}>
            <div className="nav__label">{c(group.labelId)}</div>
            {items.map((item) => {
              const n = item.count?.(counts) ?? 0
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="nav__link"
                  onClick={onNavigate}
                >
                  <span>{c(item.labelId)}</span>
                  {n > 0 && (
                    <span className="nav__count" aria-label={c('nav.aria.count', 'label', { n })}>
                      {n}
                    </span>
                  )}
                </NavLink>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
