import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { DesignationChip, MeanWithN } from '../../components/data/DesignationChip'
import { StatTile } from '../../components/data/StatTile'
import { EmptyState } from '../../components/data/EmptyState'
import { DistributionBar } from '../../components/viz/DistributionBar'
import { Legend } from '../../components/viz/Legend'
import { EvidenceList } from '../../components/admin/EvidenceList'
import type { ActivityKsaCell } from '../../reports/analytics'

/**
 * How one event went.
 *
 * The warning line under the tiles is not boilerplate. Observations reach this
 * page through capture_client_id -> EvaluationRecord.activity_id, and that join
 * misses whenever the capture was made on another evaluator's device. Those
 * observations are excluded from every number here, so the count of them belongs
 * on the same screen as the numbers they are missing from.
 */
export function EventDetail() {
  const { activityId } = useParams()
  const filters = useDashboardFilters()
  const bundle = useAnalyticsBundle(filters)
  const { byActivity, activities, situated, ksas, loading } = bundle
  const [why, setWhy] = useState(false)

  const analytics = byActivity.find((a) => a.activity_id === activityId)
  const index = activities.findIndex((a) => a.id === activityId)
  const prev = index > 0 ? activities[index - 1] : null
  const next = index >= 0 && index < activities.length - 1 ? activities[index + 1] : null

  if (loading) return <p className="muted small">Loading…</p>
  if (!analytics) {
    return (
      <>
        <PageHeader title="Event not found" crumbs={[{ label: 'Events', to: '/admin/events' }]} />
        <EmptyState title="No such event on this device">
          <Link to="/admin/events">Back to the schedule</Link>
        </EmptyState>
      </>
    )
  }

  const unplaceable = situated.filter((o) => o.activity_id === null).length
  const eventObs = situated.filter((o) => o.activity_id === activityId)

  const columns: Column<ActivityKsaCell>[] = [
    {
      key: 'code',
      header: 'question',
      sticky: true,
      sortValue: (k) => k.ksa_code,
      render: (k) => (
        <>
          <strong>{k.ksa_code}</strong>
          <br />
          <span className="muted small">{k.short_label}</span>
        </>
      ),
    },
    {
      key: 'dist',
      header: 'distribution',
      width: 160,
      render: (k) =>
        k.stats.n === 0 ? (
          <span className="muted small">no evidence</span>
        ) : (
          <DistributionBar dist={k.stats.dist} ariaLabel={`${k.short_label} in this event`} />
        ),
    },
    {
      key: 'mean',
      header: 'mean',
      numeric: true,
      sortValue: (k) => k.stats.reportableMean,
      render: (k) => <MeanWithN stats={k.stats} label={k.short_label} />,
    },
    {
      key: 'weak',
      header: 'scored below competent',
      render: (k) =>
        k.weak.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span className="row">
            {k.weak.map((w, i) => (
              <span key={`${w.participant_id}-${i}`} className="row" style={{ gap: 'var(--s-1)' }}>
                <DesignationChip value={w.value} />
                {w.participant_id ? (
                  <Link to={`/admin/participants/${w.participant_id}`}>{w.participant_name}</Link>
                ) : (
                  <span className="muted">{w.participant_name}</span>
                )}
              </span>
            ))}
          </span>
        ),
    },
  ]

  return (
    <>
      <PageHeader
        title={analytics.title}
        crumbs={[
          { label: 'Dashboard', to: '/admin/overview' },
          { label: 'Events', to: '/admin/events' },
          { label: analytics.title },
        ]}
        meta={
          <>
            {analytics.day ?? 'no date'}
            {analytics.genre_group ? ` · ${analytics.genre_group}` : ''}
          </>
        }
        actions={
          <>
            {prev && (
              <Link className="small" to={`/admin/events/${prev.id}`}>
                ← {prev.title}
              </Link>
            )}
            {next && (
              <Link className="small" to={`/admin/events/${next.id}`}>
                {next.title} →
              </Link>
            )}
          </>
        }
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-4)' }}>
        <StatTile
          label="Captures"
          value={analytics.captureCount}
          sub={`${analytics.routedCaptureCount} routed`}
          attention={analytics.unroutedCaptures > 0}
        />
        <StatTile
          label="Evaluators"
          value={analytics.evaluators.length}
          sub={analytics.evaluators.join(', ') || 'none yet'}
        />
        <StatTile label="People seen" value={analytics.participantsObserved} sub="in this event" />
        <StatTile
          label="Flagged here"
          value={analytics.flagged.length}
          sub="scored 0 or 1 in this event"
          attention={analytics.flagged.length > 0}
        />
      </div>

      {(unplaceable > 0 || analytics.unroutedCaptures > 0) && (
        <div className="banner warn">
          {analytics.unroutedCaptures > 0 && (
            <>
              {analytics.unroutedCaptures} capture
              {analytics.unroutedCaptures === 1 ? ' has' : 's have'} produced no observations yet.{' '}
            </>
          )}
          {unplaceable > 0 && (
            <>
              {unplaceable} observation{unplaceable === 1 ? '' : 's'} in this workshop cannot be
              placed on any event and {unplaceable === 1 ? 'is' : 'are'} excluded from the numbers
              here.{' '}
            </>
          )}
          <button className="ghost btn--sm" onClick={() => setWhy(!why)}>
            {why ? 'hide' : 'why?'}
          </button>
          {why && (
            <p className="small" style={{ marginTop: 'var(--s-2)' }}>
              An observation records which capture it came from, but not which event. The event is
              looked up through that capture, and this device only holds captures it made or has
              synced. When another evaluator's capture has not reached this device, its observations
              still count toward the participant but cannot be attributed to an event here. Syncing
              or importing that evaluator's captures resolves it.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Score by question in this event</h2>
        <p className="muted small">
          The mean here is over the observations recorded in this event, not over per-person
          representatives, so it answers "what designations were handed out today".
        </p>
        <DataTable
          rows={analytics.perKsa}
          columns={columns}
          rowKey={(k) => k.ksa_code}
          defaultSort="mean"
          defaultDir="asc"
          empty={<EmptyState title="No observations for this event yet" />}
        />
        <Legend ksa={ksas.find((k) => k.code === analytics.perKsa[0]?.ksa_code)} showConflict={false} />
      </div>

      {analytics.flagged.length > 0 && (
        <div className="card">
          <h2>Participants flagged in this event</h2>
          {analytics.flagged.map((f) => (
            <div key={f.participant_id ?? f.participant_name} style={{ marginBottom: 'var(--s-4)' }}>
              <div className="row">
                <DesignationChip value={f.lowest} />
                {f.participant_id ? (
                  <Link to={`/admin/participants/${f.participant_id}`}>
                    <strong>{f.participant_name}</strong>
                  </Link>
                ) : (
                  <strong>{f.participant_name}</strong>
                )}
                <span className="muted small">{f.ksaCodes.join(', ')}</span>
              </div>
              <EvidenceList
                observations={eventObs.filter((o) => f.observationIds.includes(o.id))}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
