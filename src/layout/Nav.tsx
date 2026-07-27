import { NavLink } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { c } from '../lib/content/chrome'
import { useNavCounts } from '../hooks/useNavCounts'
import { NAV_GROUPS } from './navItems'
import type { NavGroup } from './navItems'
import type { AppUser } from '../lib/types'

function visible(roles: AppUser['role'][] | undefined, role: AppUser['role'] | null): boolean {
  if (!roles) return true
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
  const { identity } = useAuth()
  const counts = useNavCounts()
  const role = identity?.role ?? null

  const groups: NavGroup[] = NAV_GROUPS.filter((g) => visible(g.roles, role))

  return (
    <nav aria-label={c('nav.aria.main')}>
      {groups.map((group) => {
        const items = group.items.filter((i) => visible(i.roles, role))
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
