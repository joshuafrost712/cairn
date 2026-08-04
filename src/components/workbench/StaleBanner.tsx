import type { DraftDoc } from '../../drafts/types'
import { c } from '../../lib/content/chrome'

/**
 * What changed underneath the edits, and what to do about it.
 *
 * Deliberately not dismissible. The evidence findings are approval blockers, so a
 * banner you could close would leave a disabled Approve button with its explanation
 * hidden.
 *
 * TWO DIFFERENT FACTS LIVE HERE AND THEY ARE NOT INTERCHANGEABLE (tl-16 added the
 * second). "The evidence moved" means a line somebody edited now rests on something
 * else, and it blocks approval. "The wording moved" means an administrator changed a
 * template after this draft was generated, and it deliberately does NOT block: the
 * document is coherent and sending it as it stands is a legitimate choice, so letting
 * a typo fix strand the evening's batch would be the warning layer costing more than
 * it saves. That is why the headline is per-block rather than one line over both.
 */
export function StaleBanner({
  draft,
  templatesMoved = false,
  onGoTo,
  onDiscardOrphan,
}: {
  draft: DraftDoc
  /** tl-16: the authored templates changed after this draft was generated. */
  templatesMoved?: boolean
  onGoTo: (segmentId: string) => void
  onDiscardOrphan: (segmentId: string) => void
}) {
  const evidenceMoved = draft.flags.length > 0 || draft.orphans.length > 0
  if (!evidenceMoved && !templatesMoved) return null

  return (
    <>
      {evidenceMoved && (
        <div className="banner warn stack-tight">
          <strong>The evidence moved after you edited this.</strong>

          {draft.flags.map((f) => (
            <div className="row" key={f.segmentId}>
              <span className="small">
                {f.kind === 'stale-evidence' ? (
                  <>
                    A line you edited now rests on different evidence
                    {f.addedEvidence.length > 0 && <> ({f.addedEvidence.length} new observation(s))</>}
                    {f.removedEvidence.length > 0 && <> ({f.removedEvidence.length} removed)</>}.
                  </>
                ) : (
                  <>A line you edited was reworded by the generator, most likely after a verdict.</>
                )}
              </span>
              <span className="spacer" />
              <button className="ghost btn--sm" onClick={() => onGoTo(f.segmentId)}>
                Show me
              </button>
            </div>
          ))}

          {draft.orphans.map((o) => (
            <div className="row" key={o.segmentId}>
              <span className="small">
                A line you edited is no longer in the document. Your wording:{' '}
                <em>“{(o.text ?? '').slice(0, 90)}”</em>
              </span>
              <span className="spacer" />
              <button className="ghost btn--sm" onClick={() => onDiscardOrphan(o.segmentId)}>
                Discard it
              </button>
            </div>
          ))}
        </div>
      )}

      {templatesMoved && (
        <div className="banner stack-tight">
          <strong>{c('workbench.templates-moved.title')}</strong>
          {/* A block, not a span. `stack-tight` lays out block children, so an inline
              one ran straight on from the bold headline — "…after this was written.An
              administrator edited…" — which the walkthrough's own screenshot showed and
              no assertion could. The evidence branch above gets this right by accident,
              because each of its children is a `div.row`.

              No button, either. Regeneration is a BATCH action and it lives on Outgoing,
              which holds the sender name and the facilitator list this page does not
              have; a button here could only regenerate one document with defaults
              substituted for both, which is a worse document than the stale one. The
              copy names where to go instead. */}
          <div className="small">{c('workbench.templates-moved.body')}</div>
        </div>
      )}
    </>
  )
}
