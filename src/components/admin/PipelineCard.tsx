import { Link } from 'react-router-dom'
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
  return (
    <div className="card">
      <h2>Pipeline</h2>
      <p className="muted small">Where evidence is between capture and report.</p>
      <Row label="observations" value={attribution.total} />
      <Row label="captures not yet routed" value={summary.capturesNotRouted} warn hint="Submitted, but no observations have come back from routing yet." />
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
      <Row
        label="captures made elsewhere"
        value={summary.orphanedCaptures}
        warn
        hint="Distinct captures referenced by observations but never synced to this device."
      />
      <p className="small" style={{ marginTop: 'var(--s-3)' }}>
        <Link to="/routing">open Routing →</Link>
      </p>
    </div>
  )
}
