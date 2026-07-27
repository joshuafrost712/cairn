import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { FilterBar } from '../../components/admin/FilterBar'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { CellDrawer } from '../../components/admin/CellDrawer'
import type { CellSelection } from '../../components/admin/CellDrawer'
import { KsaTable } from '../../components/admin/KsaTable'
import { Heatmap } from '../../components/viz/Heatmap'
import { Legend } from '../../components/viz/Legend'
import { StatTile } from '../../components/data/StatTile'
import type { HeatSort } from '../../reports/analytics'

const SORTS: { value: HeatSort; label: string }[] = [
  { value: 'roster', label: 'roster order' },
  { value: 'weakest', label: 'weakest first' },
  { value: 'team', label: 'by team' },
  { value: 'least-evidence', label: 'least evidence first' },
]

/**
 * "How is the workshop going", with the participant x KSA matrix as the answer.
 *
 * At workshop scale this fits on one screen, and the eye finds an empty column
 * (a question nobody has evidence for) and a pale row (someone in trouble)
 * faster than any table or bar chart could show it. It is here rather than on
 * the overview because it answers "where", not "what do I do next" — the
 * overview leads with the queue for that.
 */
export function WorkshopHealth() {
  const filters = useDashboardFilters()
  const [emphasizeRisk, setEmphasizeRisk] = useState(false)
  const [plain, setPlain] = useState(false)
  const [selection, setSelection] = useState<CellSelection | null>(null)
  const navigate = useNavigate()

  const bundle = useAnalyticsBundle(filters)
  const { workshop, heatmap, byKsa, reports, ksas, flagged, loading } = bundle

  const evidencedCells = heatmap.cells.flat().filter((c) => c.value !== null).length
  const totalCells = heatmap.rows.length * heatmap.cols.length
  const coverage = totalCells ? Math.round((evidencedCells / totalCells) * 100) : 0
  const conflicts = heatmap.cells.flat().filter((c) => c.conflict).length
  const areasAtRisk = byKsa.filter(
    (k) => k.representative.reportableMean !== null && k.representative.reportableMean < 1.5,
  ).length

  const openCell = (participantId: string, ksaCode: string) => {
    const report = reports.find((r) => r.participant_id === participantId)
    const rollup = report?.ksaRollups.find((k) => k.ksa_code === ksaCode) ?? null
    setSelection({
      participantId,
      participantName: report?.participant_name ?? participantId,
      ksaCode,
      ksaLabel: ksas.find((k) => k.code === ksaCode)?.short_label || ksaCode,
      rollup,
    })
  }

  return (
    <>
      <PageHeader
        title="Workshop health"
        crumbs={[{ label: 'Dashboard', to: '/admin/overview' }, { label: 'Workshop health' }]}
        meta={workshop ? `${workshop.name}${workshop.location ? ` · ${workshop.location}` : ''}` : undefined}
      />

      <FilterBar
        days={bundle.days}
        teams={bundle.teams}
        filters={filters}
        emphasizeRisk={emphasizeRisk}
        onEmphasizeRisk={setEmphasizeRisk}
        extra={
          <>
            <label>
              Sort
              <select
                value={filters.sort ?? 'roster'}
                onChange={(e) => filters.set({ sort: e.target.value as HeatSort })}
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label title="Same numbers with the colour encoding removed">
              <input
                type="checkbox"
                checked={plain}
                onChange={(e) => setPlain(e.target.checked)}
                style={{ width: 'auto' }}
              />
              plain table
            </label>
          </>
        }
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-5)' }}>
        <StatTile
          label="Evidence coverage"
          value={`${coverage}%`}
          sub={`${evidencedCells} of ${totalCells} person-question cells`}
        />
        <StatTile
          label="Areas at risk"
          value={areasAtRisk}
          sub="questions averaging below 1.5"
          attention={areasAtRisk > 0}
        />
        <StatTile label="Conflicts" value={conflicts} sub="cells where evaluators differ by 2+" />
        <StatTile
          label="Participants flagged"
          value={flagged.length}
          sub={`of ${bundle.participants.length}`}
          to="/admin/participants"
        />
      </div>

      <div className="card">
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : (
          <>
            <Heatmap
              matrix={heatmap}
              plain={plain}
              emphasizeRisk={emphasizeRisk}
              onCell={openCell}
              onRow={(id) => navigate(`/admin/participants/${id}`)}
              caption="Participant × question, showing the representative designation: the highest counting evidence for that person on that question. Not an average."
            />
            <Legend />
          </>
        )}
      </div>

      <div style={{ marginTop: 'var(--s-5)' }}>
        <KsaTable byKsa={byKsa} emphasizeRisk={emphasizeRisk} />
      </div>

      <CellDrawer selection={selection} onClose={() => setSelection(null)} />
    </>
  )
}
