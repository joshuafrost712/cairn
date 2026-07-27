import type { AnnotatedObservation } from '../../reports/verification'
import { EmptyState } from '../data/EmptyState'
import { DesignationChip } from '../data/DesignationChip'

function evaluatorLabel(email: string | null | undefined): string {
  if (!email) return 'an evaluator'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

const STATUS_PILL: Record<string, string> = {
  verified: 'pill synced',
  adjusted: 'pill synced',
  pending: 'pill queued',
  disputed: 'pill error',
}

/**
 * The raw evidence behind a number: one card per observation, with the verbatim
 * excerpt.
 *
 * Deliberately no summary and no explanation of why the observations add up to
 * the designation they do. The rule is stated once above the list (it is
 * deterministic and known), and below that the reader gets what the evaluator
 * actually wrote. An AI paraphrase here would put a layer between the reader and
 * the testimony, which is the opposite of the point.
 */
export function EvidenceList({
  observations,
  showEvaluator = true,
}: {
  observations: AnnotatedObservation[]
  showEvaluator?: boolean
}) {
  if (observations.length === 0) {
    return <EmptyState title="No evidence yet">Nothing has been captured for this area.</EmptyState>
  }

  return (
    <div>
      {observations.map((o) => {
        const adjusted = o.effective_designation !== o.evidence_designation
        return (
          <div className="card" key={o.id} style={{ marginBottom: 'var(--s-3)' }}>
            <div className="row">
              <DesignationChip value={o.effective_designation} />
              {adjusted && (
                <span className="muted small">adjusted from {o.evidence_designation}</span>
              )}
              {o.origin === 'group' && <span className="pill">group</span>}
              <span className="spacer" />
              <span className={STATUS_PILL[o.vstatus] ?? 'pill'}>{o.vstatus}</span>
            </div>

            <p style={{ margin: 'var(--s-2) 0 0' }}>{o.text}</p>

            {o.source_excerpt && (
              <blockquote
                style={{
                  margin: 'var(--s-2) 0 0',
                  paddingLeft: 'var(--s-3)',
                  borderLeft: '3px solid var(--line)',
                  color: 'var(--muted)',
                  fontStyle: 'italic',
                }}
              >
                “{o.source_excerpt}”
              </blockquote>
            )}

            <div className="row small muted" style={{ marginTop: 'var(--s-2)' }}>
              {showEvaluator && <span>{evaluatorLabel(o.evaluator_email)}</span>}
              <span className="spacer" />
              <span>
                {o.confirmCount} confirm{o.confirmCount === 1 ? '' : 's'}
                {o.rejectCount > 0 ? `, ${o.rejectCount} reject` : ''}
              </span>
            </div>

            {o.verdicts.length > 0 && (
              <div className="row small muted" style={{ marginTop: 'var(--s-1)' }}>
                {o.verdicts.map((v) => (
                  <span className="pill" key={v.id} title={v.note ?? undefined}>
                    {evaluatorLabel(v.evaluator_email)}: {v.decision}
                    {v.adjusted_designation != null ? ` → ${v.adjusted_designation}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
