import { Link } from 'react-router-dom'
import { ADMIN_ROLES, useHasWorkshopRole } from '../../layout/roles'
import type { AttributionHealth, WorkbenchSummary } from '../../reports/analytics'

function Row({
  label,
  value,
  warn = false,
  hint,
}: {
  label: string
  value: number
  warn?: boolean
  hint?: string
}) {
  return (
    <div className="row" style={{ padding: 'var(--s-1) 0' }}>
      <span className={warn && value > 0 ? '' : 'muted'} title={hint}>
        {label}
      </span>
      <span className="spacer" />
      <span
        className="num"
        style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 'var(--fw-med)' }}
      >
        {value}
        {warn && value > 0 && (
          <span style={{ color: 'var(--warn)' }} title={hint}>
            {' '}
            ⚠
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Where evidence is getting stuck between capture and report.
 *
 * The two warning rows are the honesty valve for the join described in
 * analytics.ts: observations that cannot be placed on a person or an event are
 * excluded from every number on this dashboard, so the count of them has to be
 * visible on the same screen as the numbers they are missing from.
 */
export function PipelineCard({
  summary,
  attribution,
}: {
  summary: WorkbenchSummary
  attribution: AttributionHealth
}) {
  // This dashboard is CHIEF_ROLES, but routing is ADMIN_ROLES: a chief evaluator
  // reading the pipeline would otherwise be offered a link that only bounces them
  // home. See navItems.ts for why the two sets differ here.
  const isAdmin = useHasWorkshopRole(ADMIN_ROLES)
  return (
    <div className="card">
      <h2>Pipeline</h2>
      <p className="muted small">Where evidence is between capture and report.</p>

      {/*
       * Captures and observations are DIFFERENT UNITS and the rows are grouped to
       * say so. Read as one flat list they invite a ratio that does not exist: a
       * reader comparing the workshop's observation count against the unrouted
       * capture count concludes that most captures failed to route, when one
       * routed capture routinely yields several observations and an unrouted one
       * yields none. That misreading is what made a real backlog look like a
       * different, larger problem than it was.
       */}
      <p className="muted small" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
        Captures — what evaluators submitted
      </p>
      <Row
        label="captures not yet processed"
        value={summary.capturesNotRouted}
        warn
        hint="Submitted captures that have produced no observations yet. Counted in captures, not observations: routing one capture usually yields several observations, so this number is not comparable to the observation counts below."
      />
      <Row
        label="captures made elsewhere"
        value={summary.orphanedCaptures}
        warn
        hint="Distinct captures referenced by observations but never synced to this device."
      />

      <p className="muted small" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
        Observations — what routing produced from them
      </p>
      <Row
        label="observations"
        value={attribution.total}
        hint="Individual observations routed from captures. One capture usually produces several, so this is never a like-for-like comparison with the capture counts above."
      />
      <Row
        label="not attributable to a person"
        value={summary.unattributedObservations}
        warn
        hint="Excluded from every report until a human attributes them."
      />
      <Row
        label="not attributable to an event"
        value={attribution.total - attribution.withActivity}
        warn
        hint="The capture that produced these is not on this device, so their event is unknowable here. They still count toward the person."
      />
      {isAdmin && (
        <p className="small" style={{ marginTop: 'var(--s-3)' }}>
          <Link to="/admin/routing">open Routing →</Link>
        </p>
      )}
    </div>
  )
}
