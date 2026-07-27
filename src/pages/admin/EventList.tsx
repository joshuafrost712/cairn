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
import type { ActivityAnalytics } from '../../reports/analytics'

/** Every event in the schedule, with how it went. */
export function EventList() {
  const filters = useDashboardFilters()
  const navigate = useNavigate()
  const bundle = useAnalyticsBundle(filters)
  const { byActivity, byEvaluator, loading } = bundle

  const columns: Column<ActivityAnalytics>[] = [
    {
      key: 'title',
      header: 'event',
      sticky: true,
      sortValue: (a) => a.title,
      render: (a) => (
        <>
          <strong>{a.title}</strong>
          <br />
          <span className="muted small">
            {a.day ?? 'no date'}
            {a.genre_group ? ` · ${a.genre_group}` : ''}
          </span>
        </>
      ),
    },
    {
      key: 'day',
      header: 'day',
      sortValue: (a) => a.day ?? '',
      render: (a) => <span className="muted">{a.day ?? '—'}</span>,
    },
    {
      key: 'captures',
      header: 'captures',
      numeric: true,
      sortValue: (a) => a.captureCount,
      render: (a) => (
        <span title={`${a.routedCaptureCount} routed`}>
          {a.captureCount}
          {a.unroutedCaptures > 0 && (
            <span style={{ color: 'var(--warn)' }} title={`${a.unroutedCaptures} produced no observations yet`}>
              {' '}
              ⚠
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'evaluators',
      header: 'evaluators',
      numeric: true,
      sortValue: (a) => a.evaluators.length,
      render: (a) => <span title={a.evaluators.join(', ')}>{a.evaluators.length}</span>,
    },
    {
      key: 'people',
      header: 'people seen',
      numeric: true,
      sortValue: (a) => a.participantsObserved,
      render: (a) => a.participantsObserved,
    },
    {
      key: 'dist',
      header: 'distribution',
      width: 150,
      render: (a) => (
        <DistributionBar dist={a.overall.dist} ariaLabel={`${a.title} designations`} />
      ),
    },
    {
      key: 'mean',
      header: <span title="Mean over the observations recorded in this event">mean (per obs)</span>,
      numeric: true,
      sortValue: (a) => a.overall.reportableMean,
      render: (a) => <MeanWithN stats={a.overall} label={a.title} />,
    },
    {
      key: 'flagged',
      header: 'flagged',
      numeric: true,
      sortValue: (a) => a.flagged.length,
      render: (a) =>
        a.flagged.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span title={a.flagged.map((f) => f.participant_name).join(', ')}>{a.flagged.length}</span>
        ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Events"
        crumbs={[{ label: 'Dashboard', to: '/admin/overview' }, { label: 'Events' }]}
        meta={`${byActivity.length} in the schedule`}
      />

      <FilterBar days={bundle.days} teams={bundle.teams} evaluators={byEvaluator} filters={filters} />

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : (
        <DataTable
          rows={byActivity}
          columns={columns}
          rowKey={(a) => a.activity_id}
          defaultSort="day"
          defaultDir="desc"
          onRowClick={(a) => navigate(`/admin/events/${a.activity_id}`)}
          caption={
            <>
              Schedule{' '}
              <span className="muted">
                · the mean here is over observations, not over per-person representatives
              </span>
            </>
          }
          empty={<EmptyState title="No events in this workshop yet" />}
        />
      )}
    </>
  )
}
