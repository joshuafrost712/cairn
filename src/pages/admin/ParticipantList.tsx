import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { FilterBar } from '../../components/admin/FilterBar'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { DesignationChip, MeanWithN } from '../../components/data/DesignationChip'
import { EmptyState } from '../../components/data/EmptyState'
import { Legend } from '../../components/viz/Legend'
import { designationStats } from '../../reports/analytics'
import type { ParticipantReport } from '../../reports/build'
import type { AnnotatedObservation } from '../../reports/verification'

/** This person's own spread across the questions, using the shared stats rule. */
function rowStats(r: ParticipantReport<AnnotatedObservation>) {
  return designationStats(
    r.ksaRollups.map((k) => k.representative).filter((v): v is number => v !== null),
  )
}

/**
 * Every participant, one row each, with their whole KSA profile inline.
 *
 * The row IS the small multiple: seven chips read left to right are the same
 * data as that person's heatmap row, at a density where you can also carry the
 * gate status and the flag count alongside. This and /admin/workshop are
 * deliberately two views of one dataset, because scanning for a pattern and
 * working down a list are different jobs.
 */
export function ParticipantList() {
  const filters = useDashboardFilters()
  const navigate = useNavigate()
  const bundle = useAnalyticsBundle(filters)
  const { reports, gates, ksas, flagged, byEvaluator, loading } = bundle

  const flagsByParticipant = new Map(flagged.map((f) => [f.participant_id, f]))

  type Row = ParticipantReport<AnnotatedObservation>

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'participant',
      sticky: true,
      sortValue: (r) => r.participant_name,
      render: (r) => (
        <>
          <strong>{r.participant_name}</strong>
          {flagsByParticipant.has(r.participant_id) && (
            <span title="flagged" aria-label="flagged" style={{ marginLeft: 'var(--s-1)' }}>
              ⚑
            </span>
          )}
        </>
      ),
    },
    {
      key: 'team',
      header: 'team',
      sortValue: (r) => r.team_name ?? '',
      render: (r) => <span className="muted">{r.team_name ?? '—'}</span>,
    },
    ...ksas.map<Column<Row>>((k) => ({
      key: k.code,
      header: <span title={`${k.short_label} — ${k.area}`}>{k.code}</span>,
      sortValue: (r) => r.ksaRollups.find((x) => x.ksa_code === k.code)?.representative ?? null,
      render: (r) => {
        const roll = r.ksaRollups.find((x) => x.ksa_code === k.code)
        return (
          <DesignationChip
            value={roll?.representative ?? null}
            conflict={roll?.conflict ?? false}
            title={`${r.participant_name} · ${k.short_label}`}
          />
        )
      },
    })),
    {
      key: 'mean',
      header: <span title="Mean of this person's representative designations">mean</span>,
      numeric: true,
      sortValue: (r) => rowStats(r).reportableMean,
      render: (r) => <MeanWithN stats={rowStats(r)} label={r.participant_name} />,
    },
    {
      key: 'coverage',
      header: 'evidenced',
      numeric: true,
      sortValue: (r) => r.totals.evidencedKsas,
      render: (r) => (
        <span className="n-badge">
          {r.totals.evidencedKsas}/{r.totals.totalKsas}
        </span>
      ),
    },
    {
      key: 'gate',
      header: 'report',
      sortValue: (r) => (gates.get(r.participant_id)?.status === 'ready' ? 1 : 0),
      render: (r) => {
        const g = gates.get(r.participant_id)
        if (!g || g.total === 0) return <span className="muted">no evidence</span>
        return g.status === 'ready' ? (
          <span className="pill synced">ready</span>
        ) : (
          <span className="pill queued" title={`${g.pending} pending, ${g.disputed} disputed`}>
            locked
          </span>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader
        title="Participants"
        crumbs={[{ label: 'Dashboard', to: '/admin/overview' }, { label: 'Participants' }]}
        meta={`${reports.length} on the roster · ${flagged.length} flagged`}
      />

      <FilterBar
        days={bundle.days}
        teams={bundle.teams}
        evaluators={byEvaluator}
        filters={filters}
      />

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          <DataTable
            rows={reports}
            columns={columns}
            rowKey={(r) => r.participant_id}
            defaultSort="name"
            defaultDir="asc"
            onRowClick={(r) => navigate(`/admin/participants/${r.participant_id}`)}
            caption={
              <>
                Roster <span className="muted">· each row is that person's heatmap row</span>
              </>
            }
            empty={<EmptyState title="No participants on this device yet" />}
          />
          <Legend />
        </>
      )}
    </>
  )
}
