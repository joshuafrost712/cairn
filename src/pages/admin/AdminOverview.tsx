import { Link } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { FilterBar } from '../../components/admin/FilterBar'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { AttentionQueue } from '../../components/admin/AttentionQueue'
import { PipelineCard } from '../../components/admin/PipelineCard'
import { StatTile } from '../../components/data/StatTile'
import { MeanWithN } from '../../components/data/DesignationChip'
import { DistributionBar } from '../../components/viz/DistributionBar'
import { Sparkline } from '../../components/viz/Sparkline'

/**
 * The page you open.
 *
 * It leads with the QUEUE, not the heatmap. The 9pm job is the approve-and-send
 * loop and the handful of people who need a conversation tomorrow; "how is the
 * cohort tracking" is a real question but it is one click away at
 * /admin/workshop, and putting it first would make the landing page a poster
 * rather than a worklist.
 */
export function AdminOverview() {
  const filters = useDashboardFilters()
  const bundle = useAnalyticsBundle(filters)
  const { workshop, summary, flagged, byKsa, attribution, loading } = bundle

  const totalReports = summary.reportsReady + summary.reportsLocked

  return (
    <>
      <PageHeader
        title="Overview"
        meta={
          workshop
            ? `${workshop.name}${workshop.location ? ` · ${workshop.location}` : ''}`
            : 'No workshop loaded on this device'
        }
        actions={<Link to="/admin/workshop">Workshop health →</Link>}
      />

      <FilterBar days={bundle.days} teams={bundle.teams} filters={filters} />

      {loading && <p className="muted small">Loading…</p>}

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-5)' }}>
        <StatTile
          label="Reports ready"
          value={summary.reportsReady}
          sub={`of ${totalReports} with evidence`}
          to="/reports"
        />
        <StatTile
          label="Awaiting verification"
          value={summary.observationsPending}
          sub={
            summary.observationsDisputed > 0
              ? `${summary.observationsDisputed} disputed`
              : 'observations needing a second confirmation'
          }
          to="/observations"
          attention={summary.observationsDisputed > 0}
        />
        <StatTile
          label="Open discrepancies"
          value={summary.openDiscrepancies}
          sub="evaluators differ by 2 or more"
          to="/inbox"
          attention={summary.openDiscrepancies > 0}
        />
        <StatTile
          label="Conversations needed"
          value={summary.conversationsNeeded}
          sub="confirmed low designations"
          to="/conversations"
          attention={summary.conversationsNeeded > 0}
        />
      </div>

      <div className="card">
        <h2>Needs your attention</h2>
        <p className="muted small">
          Ordered by how serious the signal is, not by how much evidence there is.
        </p>
        <AttentionQueue flagged={flagged} />
      </div>

      <div className="grid grid--split" style={{ marginTop: 'var(--s-5)' }}>
        <PipelineCard summary={summary} attribution={attribution} />

        <div className="card">
          <h2>Workshop pulse</h2>
          <p className="muted small">
            One row per question. The mean is over one representative value per participant.
          </p>
          {byKsa.length === 0 ? (
            <p className="muted small">No questions configured yet.</p>
          ) : (
            byKsa.map((k) => (
              <div
                className="row"
                key={k.ksa_code}
                style={{ padding: 'var(--s-2) 0', borderBottom: '1px solid var(--line)' }}
              >
                <strong style={{ minWidth: '4.5rem' }} title={k.area}>
                  {k.ksa_code}
                </strong>
                <Sparkline
                  points={k.byDay.map((d) => ({ label: d.day, value: d.stats.mean, n: d.stats.n }))}
                  ariaLabel={`${k.short_label} by day`}
                  width={72}
                  height={24}
                />
                <div style={{ flex: 1, minWidth: 90 }}>
                  <DistributionBar
                    dist={k.representative.dist}
                    height={14}
                    ariaLabel={`${k.short_label} distribution`}
                  />
                </div>
                <MeanWithN stats={k.representative} label={k.short_label} />
              </div>
            ))
          )}
          <p className="small" style={{ marginTop: 'var(--s-3)' }}>
            <Link to="/admin/workshop">full breakdown →</Link>
          </p>
        </div>
      </div>
    </>
  )
}
