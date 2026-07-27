import { useSearchParams } from 'react-router-dom'
import type { DashboardFilters } from '../../hooks/useAnalyticsBundle'
import type { HeatSort } from '../../reports/analytics'

/**
 * Filters live in the URL, not in component state.
 *
 * Two reasons that matter here. A view you can paste into an email ("look at
 * day 3 for team B") is worth more than one you have to describe, and keeping
 * them in searchParams means back and forward work the way a reader expects
 * when they drill in and out of a dashboard.
 *
 * One row, above everything it scopes: filters are never per-chart, because a
 * page where two cards are showing different slices is a page that lies.
 */
export function useDashboardFilters(): DashboardFilters & {
  set: (next: Partial<DashboardFilters>) => void
} {
  const [params, setParams] = useSearchParams()
  return {
    day: params.get('day'),
    teamId: params.get('team'),
    evaluator: params.get('evaluator'),
    sort: (params.get('sort') as HeatSort | null) ?? 'roster',
    set(next) {
      const p = new URLSearchParams(params)
      const apply = (key: string, value: string | null | undefined) => {
        if (value == null || value === '') p.delete(key)
        else p.set(key, value)
      }
      if ('day' in next) apply('day', next.day)
      if ('teamId' in next) apply('team', next.teamId)
      if ('evaluator' in next) apply('evaluator', next.evaluator)
      if ('sort' in next) apply('sort', next.sort)
      setParams(p, { replace: true })
    },
  }
}
