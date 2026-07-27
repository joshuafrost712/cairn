import { Link } from 'react-router-dom'
import type { EvidenceView } from '../../workbench/evidenceView'
import { DesignationChip } from '../data/DesignationChip'

/**
 * One observation, exactly as recorded.
 *
 * Every field here is read off a record. There is no synthesis, no summary, and
 * no justification of the sentence this evidence sits behind, because Joshua
 * asked to be routed to the evidence rather than to an account of it. The one
 * piece of prose on this pane is the segment's computed derivation note, which
 * states the arithmetic rule and lives in the pane header, not here.
 */
export function EvidenceCard({ v }: { v: EvidenceView }) {
  if (!v.present) {
    return (
      <div className="ev-card ev-card--missing">
        <p className="small muted" style={{ margin: 0 }}>
          This line cites an observation that is no longer on this device
          {' ('}
          <code>{v.observationId}</code>
          {'). '}
          It was either deleted, or it arrived from another evaluator's device and has not synced
          back. The line still counts it.
        </p>
      </div>
    )
  }

  return (
    <div className="ev-card">
      <div className="row">
        <DesignationChip value={v.designation} />
        {v.adjustedFrom !== null && (
          <span className="pill" title="A verdict moved this designation">
            adjusted from {v.adjustedFrom}
          </span>
        )}
        <span className={`pill ${statusClass(v.status)}`}>{v.status}</span>
        {v.needsReview && <span className="pill queued">routing flagged</span>}
        {v.origin === 'group' && <span className="pill">group</span>}
      </div>

      <p className="small" style={{ marginBottom: 0 }}>
        {v.text}
      </p>

      {v.excerpt && <blockquote className="ev-card__quote small">“{v.excerpt}”</blockquote>}

      <div className="ev-card__meta">
        <div>{v.evaluator ?? 'evaluator unknown'}</div>
        <div>
          {v.activityTitle ?? (
            <span title="The capture that produced this observation is not on this device">
              event unknown
            </span>
          )}
          {v.capturedAt ? ` · ${new Date(v.capturedAt).toLocaleString()}` : ''}
        </div>
        {v.verdicts.length > 0 && (
          <div className="row" style={{ marginTop: 'var(--s-1)' }}>
            {v.verdicts.map((verdict) => (
              <span
                key={`${verdict.evaluator}-${verdict.at}`}
                className="pill"
                title={`${verdict.evaluator} on ${new Date(verdict.at).toLocaleString()}`}
              >
                {verdict.decision}
                {verdict.adjustedTo !== null ? ` → ${verdict.adjustedTo}` : ''}
              </span>
            ))}
          </div>
        )}
        {v.recordsHref && (
          <div style={{ marginTop: 'var(--s-1)' }}>
            <Link to={v.recordsHref}>open the full record →</Link>
          </div>
        )}
      </div>
    </div>
  )
}

function statusClass(status: string | null): string {
  if (status === 'verified' || status === 'adjusted') return 'synced'
  if (status === 'disputed') return 'error'
  return 'queued'
}
