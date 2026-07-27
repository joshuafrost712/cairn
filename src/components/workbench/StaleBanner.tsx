import type { DraftDoc } from '../../drafts/types'

/**
 * What changed underneath the edits, and what to do about it.
 *
 * Deliberately not dismissible. These are approval blockers, so a banner you
 * could close would leave a disabled Approve button with its explanation hidden.
 */
export function StaleBanner({
  draft,
  onGoTo,
  onDiscardOrphan,
}: {
  draft: DraftDoc
  onGoTo: (segmentId: string) => void
  onDiscardOrphan: (segmentId: string) => void
}) {
  if (draft.flags.length === 0 && draft.orphans.length === 0) return null

  return (
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
  )
}
