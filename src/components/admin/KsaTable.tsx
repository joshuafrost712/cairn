import { Link } from 'react-router-dom'
import type { KsaAnalytics } from '../../reports/analytics'
import { DataTable } from '../data/DataTable'
import type { Column } from '../data/DataTable'
import { MeanWithN } from '../data/DesignationChip'
import { DistributionBar } from '../viz/DistributionBar'
import { Sparkline } from '../viz/Sparkline'
import { EmptyState } from '../data/EmptyState'

/**
 * One row per KSA, sorted by trouble rather than by average.
 *
 * The default sort is the count of at-risk representatives, not the mean: on a
 * dataset where most cells hold one or two observations, sorting by mean lets a
 * single stray zero top the list and buries a KSA where six people are quietly
 * struggling.
 *
 * Both means are available and both are labelled. `representative` is one value
 * per participant (the max rule) and answers "how is the cohort doing";
 * `observed` is every counting observation and answers "what designations are
 * being handed out". They differ, and the header says which is which.
 */
export function KsaTable({
  byKsa,
  emphasizeRisk = false,
}: {
  byKsa: KsaAnalytics[]
  emphasizeRisk?: boolean
}) {
  const columns: Column<KsaAnalytics>[] = [
    {
      key: 'code',
      header: 'KSA',
      sticky: true,
      sortValue: (k) => k.ksa_code,
      render: (k) => <strong>{k.ksa_code}</strong>,
    },
    {
      key: 'area',
      header: 'area',
      sortValue: (k) => k.goal_title,
      render: (k) => <span title={k.goal_title}>{k.short_label}</span>,
    },
    {
      key: 'dist',
      header: 'distribution',
      width: 170,
      render: (k) => (
        <DistributionBar
          dist={k.representative.dist}
          emphasizeRisk={emphasizeRisk}
          ariaLabel={`${k.short_label} representative designations`}
        />
      ),
    },
    {
      key: 'mean',
      header: <span title="Mean of one representative value per participant">mean (per person)</span>,
      numeric: true,
      sortValue: (k) => k.representative.reportableMean,
      render: (k) => <MeanWithN stats={k.representative} label={k.short_label} />,
    },
    {
      key: 'observed',
      header: <span title="Mean over every counting observation, not per person">mean (per obs)</span>,
      numeric: true,
      sortValue: (k) => k.observed.reportableMean,
      render: (k) => <MeanWithN stats={k.observed} label={k.short_label} />,
    },
    {
      key: 'atRisk',
      header: <span title="Participants whose representative designation is 0 or 1">at risk</span>,
      numeric: true,
      sortValue: (k) => k.representative.atRisk,
      render: (k) =>
        k.weakParticipants.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span title={k.weakParticipants.map((w) => `${w.participant_name} ${w.value}/3`).join(', ')}>
            {k.weakParticipants.length}
          </span>
        ),
    },
    {
      key: 'conflicts',
      header: 'conflicts',
      numeric: true,
      sortValue: (k) => k.conflictCount,
      render: (k) =>
        k.conflictCount === 0 ? <span className="muted">—</span> : k.conflictCount,
    },
    {
      key: 'trend',
      header: 'by day',
      render: (k) => (
        <Sparkline
          points={k.byDay.map((d) => ({
            label: d.day,
            value: d.stats.mean,
            n: d.stats.n,
          }))}
          ariaLabel={`${k.short_label} by day`}
          width={96}
          height={26}
        />
      ),
    },
    {
      key: 'coverage',
      header: 'covered',
      numeric: true,
      sortValue: (k) => k.participantsWithEvidence,
      render: (k) => (
        <span className="n-badge">
          {k.participantsWithEvidence}/{k.participantsTotal}
        </span>
      ),
    },
  ]

  if (byKsa.length === 0) {
    return (
      <EmptyState title="No questions configured yet">
        Add them in the <Link to="/builder">Scenario Builder</Link>.
      </EmptyState>
    )
  }

  return (
    <DataTable
      rows={byKsa}
      columns={columns}
      rowKey={(k) => k.ksa_code}
      defaultSort="atRisk"
      defaultDir="desc"
      caption={
        <>
          Per-question summary{' '}
          <span className="muted">
            · sorted by participants at risk, not by average
          </span>
        </>
      }
    />
  )
}
