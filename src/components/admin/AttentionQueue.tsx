import { Link } from 'react-router-dom'
import type { FlaggedParticipant, RiskReason } from '../../reports/analytics'
import { EmptyState } from '../data/EmptyState'
import { useScale } from '../../hooks/useScale'
import { maxValue } from '../../lib/scale'

/**
 * Turn a machine reason into a sentence a human can act on.
 *
 * The `severity` number that ordered this list never appears here on purpose:
 * the moment a score attaches to a person's name, a reader treats it as a
 * verdict on them rather than on the state of the evidence.
 */
function describe(reason: RiskReason, top: number): string {
  switch (reason.kind) {
    case 'low_representative':
      return `${reason.ksa_code} ${reason.value}/${top}`
    case 'conflict':
      return `${reason.ksa_code} conflict ${reason.lo}↔${reason.hi}`
    case 'disputed':
      return `${reason.count} disputed observation${reason.count === 1 ? '' : 's'}`
    case 'thin_coverage':
      return `only ${reason.evidenced} of ${reason.total} areas evidenced`
    case 'no_evidence':
      return 'no evidence yet'
  }
}

/** A low designation is a different kind of signal from a thin evidence base. */
function marker(f: FlaggedParticipant): string {
  return f.reasons.some((r) => r.kind === 'low_representative') ? '●' : '▲'
}

export function AttentionQueue({
  flagged,
  limit = 5,
}: {
  flagged: FlaggedParticipant[]
  limit?: number
}) {
  // The ACTIVE workshop's scale: this queue only ever renders on that workshop's
  // dashboard. It printed a literal "/3" until tl-29.
  const top = maxValue(useScale())
  if (flagged.length === 0) {
    return (
      <EmptyState title="Nothing needs your attention">
        No participant is currently flagged for a low designation, a conflict, or thin coverage.
      </EmptyState>
    )
  }

  const shown = flagged.slice(0, limit)

  return (
    <div>
      {shown.map((f) => (
        <div className="activity-item" key={f.participant_id}>
          <span>
            <span aria-hidden="true" style={{ marginRight: 'var(--s-2)' }}>
              {marker(f)}
            </span>
            <Link to={`/admin/participants/${f.participant_id}`}>
              <strong>{f.participant_name}</strong>
            </Link>
            {f.team_name && <span className="muted small"> · {f.team_name}</span>}
            <br />
            <span className="muted small">{f.reasons.map((r) => describe(r, top)).join(' · ')}</span>
          </span>
          <span className="row">
            {f.gate?.status === 'ready' ? (
              <span className="pill synced">ready</span>
            ) : (
              <span className="pill queued">locked</span>
            )}
          </span>
        </div>
      ))}
      {flagged.length > shown.length && (
        <p className="small">
          <Link to="/admin/participants">see all {flagged.length} flagged →</Link>
        </p>
      )}
    </div>
  )
}
