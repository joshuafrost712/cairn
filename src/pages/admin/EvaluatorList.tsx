import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { FilterBar } from '../../components/admin/FilterBar'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { MeanWithN } from '../../components/data/DesignationChip'
import { EmptyState } from '../../components/data/EmptyState'
import { DistributionBar } from '../../components/viz/DistributionBar'
import { leniencyPhrase, leniencyValue } from '../../components/admin/leniencyCopy'
import { MIN_PAIRED_CELLS, UNKNOWN_EVALUATOR } from '../../reports/analytics'
import type { EvaluatorAnalytics } from '../../reports/analytics'

/**
 * Who is evaluating, how much, and how their readings compare.
 *
 * This is the view that most needs its statistics labelled honestly, so two
 * columns sit side by side and the note under the table explains why one of
 * them cannot be read alone.
 */
export function EvaluatorList() {
  const filters = useDashboardFilters()
  const navigate = useNavigate()
  const bundle = useAnalyticsBundle(filters)
  const { byEvaluator, loading } = bundle

  const columns: Column<EvaluatorAnalytics>[] = [
    {
      key: 'evaluator',
      header: 'evaluator',
      sticky: true,
      sortValue: (e) => e.evaluator,
      render: (e) =>
        e.evaluator === UNKNOWN_EVALUATOR ? (
          <span className="muted" title="Observations whose originating capture is not on this device">
            {e.evaluator}
          </span>
        ) : (
          <strong>{e.evaluator}</strong>
        ),
    },
    {
      key: 'captures',
      header: 'captures',
      numeric: true,
      sortValue: (e) => e.captureCount,
      render: (e) => e.captureCount,
    },
    {
      key: 'obs',
      header: 'obs',
      numeric: true,
      sortValue: (e) => e.observationCount,
      render: (e) => e.observationCount,
    },
    {
      key: 'people',
      header: 'people',
      numeric: true,
      sortValue: (e) => e.participantsCovered,
      render: (e) => (
        <span title={e.topParticipants.slice(0, 5).map((p) => `${p.participant_name} (${p.n})`).join(', ')}>
          {e.participantsCovered}
        </span>
      ),
    },
    {
      key: 'events',
      header: 'events',
      numeric: true,
      sortValue: (e) => e.activities.length,
      render: (e) => e.activities.length,
    },
    {
      key: 'dist',
      header: 'designations given',
      width: 150,
      render: (e) => (
        <DistributionBar dist={e.given.dist} ariaLabel={`${e.evaluator} designations given`} />
      ),
    },
    {
      key: 'given',
      header: (
        <span title="Confounded by which participants they happened to observe. Read it beside the paired column.">
          given (unadjusted)
        </span>
      ),
      numeric: true,
      sortValue: (e) => e.given.reportableMean,
      render: (e) => <MeanWithN stats={e.given} label={e.evaluator} />,
    },
    {
      key: 'paired',
      header: <span title="Paired against peers on the same participant and question">vs peers</span>,
      numeric: true,
      sortValue: (e) => e.leniency.delta,
      render: (e) => (
        <>
          {leniencyValue(e.leniency)}
          <br />
          <span className={`n-badge${e.leniency.delta === null ? ' n-badge--low' : ''}`}>
            {e.leniency.delta === null
              ? leniencyPhrase(e.leniency)
              : `${e.leniency.pairedCells} shared`}
          </span>
        </>
      ),
    },
    {
      key: 'verdicts',
      header: <span title="Confirm / adjust / reject decisions cast">verdicts</span>,
      numeric: true,
      sortValue: (e) => e.verdicts.total,
      render: (e) => (
        <span title={`${e.verdicts.confirm} confirm, ${e.verdicts.adjust} adjust, ${e.verdicts.reject} reject; ${e.verdictsOnOthers} on other people's observations`}>
          {e.verdicts.total}
        </span>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Evaluators"
        crumbs={[{ label: 'Dashboard', to: '/admin/overview' }, { label: 'Evaluators' }]}
        meta={`${byEvaluator.length} contributing`}
      />

      <FilterBar days={bundle.days} teams={bundle.teams} filters={filters} />

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          <DataTable
            rows={byEvaluator}
            columns={columns}
            rowKey={(e) => e.evaluator}
            defaultSort="obs"
            defaultDir="desc"
            onRowClick={(e) =>
              e.evaluator !== UNKNOWN_EVALUATOR &&
              navigate(`/admin/evaluators/${encodeURIComponent(e.evaluator)}`)
            }
            empty={<EmptyState title="No observations attributed to an evaluator yet" />}
          />
          <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
            <strong>vs peers</strong> is a paired comparison. For each participant and question that
            this evaluator and at least one colleague both scored, it takes their mean minus the
            others' mean and averages that across the shared cells. Below {MIN_PAIRED_CELLS} shared
            cells no number is shown, because the <strong>given (unadjusted)</strong> column on its
            own is confounded by which participants each person happened to observe: someone who
            only watched the strongest group looks generous, and someone assigned the strugglers
            looks harsh. Early in a workshop, withheld is the normal answer.
          </p>
        </>
      )}
    </>
  )
}
