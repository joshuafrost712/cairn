import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { EvidenceList } from '../../components/admin/EvidenceList'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { DesignationChip, MeanWithN } from '../../components/data/DesignationChip'
import { StatTile } from '../../components/data/StatTile'
import { EmptyState } from '../../components/data/EmptyState'
import { Legend } from '../../components/viz/Legend'
import { designationStats } from '../../reports/analytics'
import type { KsaRollup } from '../../reports/build'
import type { AnnotatedObservation } from '../../reports/verification'

/**
 * Everything about one person, across every event.
 *
 * Read-only by design. Edits live in the records browser and in /observations,
 * so this page can never be the thing that silently changed a score: it is
 * where you come to decide, not to act.
 */
export function ParticipantDetail() {
  const { participantId } = useParams()
  const filters = useDashboardFilters()
  const bundle = useAnalyticsBundle(filters)
  const { reports, gates, ksas, flagged, situated, activities, loading } = bundle
  const [showEmpty, setShowEmpty] = useState(false)

  const report = reports.find((r) => r.participant_id === participantId)
  const gate = participantId ? gates.get(participantId) : undefined
  const flag = flagged.find((f) => f.participant_id === participantId)

  if (loading) return <p className="muted small">Loading…</p>
  if (!report) {
    return (
      <>
        <PageHeader title="Participant not found" crumbs={[{ label: 'Participants', to: '/admin/participants' }]} />
        <EmptyState title="No such participant on this device">
          <Link to="/admin/participants">Back to the roster</Link>
        </EmptyState>
      </>
    )
  }

  const mine = situated.filter((o) => o.participant_id === participantId)
  const overall = designationStats(
    report.ksaRollups.map((k) => k.representative).filter((v): v is number => v !== null),
  )
  const activityTitle = new Map(activities.map((a) => [a.id, a.title]))
  const conversations = mine.filter((o) => o.effective_designation <= 1 && o.vstatus !== 'pending')

  type Row = KsaRollup<AnnotatedObservation>
  const rows = showEmpty
    ? report.ksaRollups
    : report.ksaRollups.filter((k) => k.representative !== null || k.toVerify.length > 0)

  const columns: Column<Row>[] = [
    {
      key: 'code',
      header: 'question',
      sticky: true,
      sortValue: (k) => k.ksa_code,
      render: (k) => (
        <>
          <strong>{k.ksa_code}</strong>
          <br />
          <span className="muted small">{ksas.find((x) => x.code === k.ksa_code)?.short_label ?? k.area}</span>
        </>
      ),
    },
    {
      key: 'rep',
      header: <span title="Highest counting designation, not an average">representative</span>,
      sortValue: (k) => k.representative,
      render: (k) => <DesignationChip value={k.representative} conflict={k.conflict} />,
    },
    {
      key: 'evidence',
      header: 'designations behind it',
      render: (k) =>
        k.designations.length ? (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{k.designations.join(', ')}</span>
        ) : (
          <span className="muted">no counting evidence</span>
        ),
    },
    {
      key: 'obs',
      header: 'obs',
      numeric: true,
      sortValue: (k) => k.contributing.length,
      render: (k) => (
        <span className={k.contributing.length < 2 && k.contributing.length > 0 ? 'n-badge n-badge--low' : 'n-badge'}>
          {k.contributing.length}
          {k.toVerify.length > 0 ? ` (+${k.toVerify.length} set aside)` : ''}
        </span>
      ),
    },
    {
      key: 'notes',
      header: '',
      render: (k) => (
        <span className="row small muted">
          {k.conflict && <span className="pill queued">conflicting</span>}
          {k.contributing.some((o) => o.effective_designation <= 1) && (
            <span className="pill error">mentoring</span>
          )}
        </span>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={report.participant_name}
        crumbs={[
          { label: 'Dashboard', to: '/admin/overview' },
          { label: 'Participants', to: '/admin/participants' },
          { label: report.participant_name },
        ]}
        meta={
          <>
            {report.team_name ?? 'no team'}
            {flag ? ` · ${flag.reasons.length} flag${flag.reasons.length === 1 ? '' : 's'}` : ''}
          </>
        }
        actions={<Link to="/reports">Open report →</Link>}
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-5)' }}>
        <StatTile
          label="Areas evidenced"
          value={`${report.totals.evidencedKsas} / ${report.totals.totalKsas}`}
          sub={report.totals.needsReviewCount > 0 ? `${report.totals.needsReviewCount} set aside` : 'all counted'}
        />
        <StatTile
          label="Mean representative"
          value={<MeanWithN stats={overall} label={report.participant_name} />}
          sub="one value per question"
          attention={(overall.reportableMean ?? 9) < 1.5}
        />
        <StatTile
          label="Verified"
          value={gate ? `${gate.verified} / ${gate.total}` : '—'}
          sub={
            gate
              ? `${gate.pending} pending${gate.disputed ? `, ${gate.disputed} disputed` : ''}`
              : 'no observations'
          }
        />
        <StatTile
          label="Report"
          value={gate?.status === 'ready' ? 'Ready' : 'Locked'}
          sub={gate?.status === 'ready' ? 'cleared to finalize' : `needs ${gate?.required ?? 2} confirmations each`}
          attention={gate?.status !== 'ready'}
        />
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Question profile</h2>
          <span className="spacer" />
          <label className="small">
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
              style={{ width: 'auto' }}
            />{' '}
            show questions with no evidence
          </label>
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(k) => k.ksa_code}
          defaultSort="rep"
          defaultDir="asc"
          empty={<EmptyState title="No evidence captured for this person yet" />}
        />
        <Legend showConflict />
      </div>

      {conversations.length > 0 && (
        <div className="card">
          <h2>Confirmed low designations</h2>
          <p className="muted small">
            Each of these triggers a mentoring conversation. See{' '}
            <Link to="/conversations">Conversations</Link> for what was held and how it went.
          </p>
          <EvidenceList observations={conversations} />
        </div>
      )}

      <div className="card">
        <h2>Every observation</h2>
        <p className="muted small">
          {mine.length} in total, newest first. This page is read-only; corrections happen in{' '}
          <Link to="/observations">Observations</Link> and the records browser.
        </p>
        <EvidenceList
          observations={[...mine].sort((a, b) => (b.captured_at ?? '').localeCompare(a.captured_at ?? ''))}
        />
        {mine.some((o) => o.activity_id === null) && (
          <p className="small muted">
            Some of these could not be traced to an event: the capture that produced them is not on
            this device. They still count toward this person.
          </p>
        )}
        {mine.some((o) => o.activity_id !== null) && (
          <p className="small muted">
            Events represented:{' '}
            {[...new Set(mine.map((o) => o.activity_id).filter(Boolean))]
              .map((id) => activityTitle.get(id!) ?? id)
              .join(', ')}
          </p>
        )}
      </div>
    </>
  )
}
