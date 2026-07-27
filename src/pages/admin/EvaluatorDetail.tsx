import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { useDashboardFilters } from '../../components/admin/useDashboardFilters'
import { LeniencyTable } from '../../components/admin/LeniencyTable'
import { leniencyPhrase, leniencyValue } from '../../components/admin/leniencyCopy'
import { StatTile } from '../../components/data/StatTile'
import { MeanWithN } from '../../components/data/DesignationChip'
import { EmptyState } from '../../components/data/EmptyState'
import { DistributionBar } from '../../components/viz/DistributionBar'

/** One evaluator: how much they have done, and how their readings sit against peers. */
export function EvaluatorDetail() {
  const { email } = useParams()
  const decoded = email ? decodeURIComponent(email) : ''
  const filters = useDashboardFilters()
  const bundle = useAnalyticsBundle(filters)
  const { byEvaluator, loading } = bundle

  const e = byEvaluator.find((x) => x.evaluator === decoded)

  if (loading) return <p className="muted small">Loading…</p>
  if (!e) {
    return (
      <>
        <PageHeader title="Evaluator not found" crumbs={[{ label: 'Evaluators', to: '/admin/evaluators' }]} />
        <EmptyState title="No observations from this evaluator on this device">
          <Link to="/admin/evaluators">Back to the list</Link>
        </EmptyState>
      </>
    )
  }

  const { leniency } = e

  return (
    <>
      <PageHeader
        title={e.evaluator}
        crumbs={[
          { label: 'Dashboard', to: '/admin/overview' },
          { label: 'Evaluators', to: '/admin/evaluators' },
          { label: e.evaluator },
        ]}
        meta={`${e.captureCount} captures · ${e.observationCount} observations · ${e.participantsCovered} people`}
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-4)' }}>
        <StatTile
          label="Given (unadjusted)"
          value={<MeanWithN stats={e.given} label={e.evaluator} />}
          sub="every designation they recorded"
        />
        <StatTile
          label="vs peers (paired)"
          value={leniencyValue(leniency)}
          sub={
            leniency.delta === null
              ? leniencyPhrase(leniency)
              : `${leniency.pairedCells} shared cells${leniency.sd !== null ? ` · spread ${leniency.sd.toFixed(2)}` : ''}`
          }
        />
        <StatTile
          label="Verdicts cast"
          value={e.verdicts.total}
          sub={`${e.verdicts.confirm} confirm · ${e.verdicts.adjust} adjust · ${e.verdicts.reject} reject`}
        />
        <StatTile
          label="Reviewing others"
          value={e.verdictsOnOthers}
          sub="verdicts on other evaluators' observations"
        />
      </div>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          {leniency.delta === null ? (
            <>
              There is <strong>{leniencyPhrase(leniency)}</strong> to compare this evaluator against
              peers. That is expected early in a workshop, and it is not a gap in their work: a
              comparison needs colleagues who scored the same people on the same questions.
            </>
          ) : (
            <>
              This evaluator <strong>{leniencyPhrase(leniency)}</strong> on the evidence they both
              saw. This is a difference in reading, not an error, and the shared judgements behind
              it are listed below so you can read the evidence yourself.
              {leniency.sd !== null && leniency.sd > 1 && Math.abs(leniency.delta) < 0.3 && (
                <>
                  {' '}
                  Note the spread is wide while the average difference is near zero, which points to
                  inconsistency between cases rather than a consistent lean in one direction.
                </>
              )}
            </>
          )}
        </p>
        <DistributionBar
          dist={e.given.dist}
          height={24}
          ariaLabel={`${e.evaluator} designations given`}
        />
        <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
          Distribution of every designation this evaluator recorded, including any later rejected:
          what they said is still what they said.
        </p>
      </div>

      <div className="card">
        <h2>Shared judgements</h2>
        <LeniencyTable leniency={leniency} />
      </div>

      <div className="grid grid--split">
        <div className="card">
          <h2>By event</h2>
          {e.activities.length === 0 ? (
            <p className="muted small">No observations traced to an event.</p>
          ) : (
            e.activities.map((a) => (
              <div className="row" key={a.activity_id} style={{ padding: 'var(--s-1) 0' }}>
                <Link to={`/admin/events/${a.activity_id}`}>{a.title}</Link>
                <span className="spacer" />
                <span className="n-badge">{a.n}</span>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h2>Who they have reviewed most</h2>
          {e.topParticipants.slice(0, 10).map((p) => (
            <div className="row" key={p.participant_id ?? p.participant_name} style={{ padding: 'var(--s-1) 0' }}>
              {p.participant_id ? (
                <Link to={`/admin/participants/${p.participant_id}`}>{p.participant_name}</Link>
              ) : (
                <span className="muted">{p.participant_name}</span>
              )}
              <span className="spacer" />
              <span className="n-badge">{p.n}</span>
            </div>
          ))}
          {e.topParticipants.length > 10 && (
            <p className="small muted">… and {e.topParticipants.length - 10} more</p>
          )}
        </div>
      </div>
    </>
  )
}
