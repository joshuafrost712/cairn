import type { ReactNode } from 'react'
import type { EvaluatorAnalytics } from '../../reports/analytics'
import type { Team } from '../../lib/types'
import type { useDashboardFilters } from './useDashboardFilters'

export function FilterBar({
  days,
  teams,
  evaluators,
  filters,
  emphasizeRisk,
  onEmphasizeRisk,
  extra,
}: {
  days: string[]
  teams: Team[]
  evaluators?: EvaluatorAnalytics[]
  filters: ReturnType<typeof useDashboardFilters>
  emphasizeRisk?: boolean
  onEmphasizeRisk?: (on: boolean) => void
  extra?: ReactNode
}) {
  return (
    <div className="filterbar">
      <label>
        Day
        <select
          value={filters.day ?? ''}
          onChange={(e) => filters.set({ day: e.target.value || null })}
        >
          <option value="">all</option>
          {days.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <label>
        Team
        <select
          value={filters.teamId ?? ''}
          onChange={(e) => filters.set({ teamId: e.target.value || null })}
        >
          <option value="">all</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {evaluators && (
        <label>
          Evaluator
          <select
            value={filters.evaluator ?? ''}
            onChange={(e) => filters.set({ evaluator: e.target.value || null })}
          >
            <option value="">all</option>
            {evaluators.map((e) => (
              <option key={e.evaluator} value={e.evaluator}>
                {e.evaluator}
              </option>
            ))}
          </select>
        </label>
      )}

      {extra}

      {onEmphasizeRisk && (
        <label title="Keep the fills on designations of 0 and 1; grey out everything else">
          <input
            type="checkbox"
            checked={emphasizeRisk ?? false}
            onChange={(e) => onEmphasizeRisk(e.target.checked)}
            style={{ width: 'auto' }}
          />
          highlight at risk
        </label>
      )}
    </div>
  )
}
