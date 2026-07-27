import type { DocSegment } from '../../reports/segments'
import type { EvidenceContext } from '../../workbench/evidenceView'
import { evidenceSummary, resolveEvidence } from '../../workbench/evidenceView'
import { EvidenceCard } from './EvidenceCard'
import { EmptyState } from '../data/EmptyState'

/**
 * The right-hand column: what the selected line rests on.
 *
 * The header carries the segment's computed derivation note when it has one.
 * That is the arithmetic ("3/3 is the highest of 3 counting designations"), not
 * a rationale, and without it the pane shows four observations under a 3/3 and
 * leaves the last inch of the reasoning unexplained.
 */
export function EvidencePane({
  segment,
  ctx,
}: {
  segment: DocSegment | null
  ctx: EvidenceContext
}) {
  if (!segment) {
    return (
      <div className="card">
        <EmptyState title="Click a line">
          The evidence behind it appears here.
        </EmptyState>
      </div>
    )
  }

  const views = resolveEvidence(segment.evidence, ctx)

  return (
    <div className="card">
      <div className="row">
        <strong>Evidence</strong>
        <span className="spacer" />
        <span className="small muted">{evidenceSummary(views)}</span>
      </div>

      {segment.note && <p className="ev-note">{segment.note}</p>}

      {views.length === 0 ? (
        <p className="small muted">
          {segment.kind === 'heading'
            ? 'A heading, so there is nothing behind it.'
            : 'This line is framing rather than a claim about anybody, so it cites nothing.'}
        </p>
      ) : (
        views.map((v) => <EvidenceCard key={v.observationId} v={v} />)
      )}
    </div>
  )
}
