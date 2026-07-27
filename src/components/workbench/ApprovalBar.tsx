import { useState } from 'react'
import type { DraftDoc } from '../../drafts/types'

/**
 * The bottom bar: what is stopping approval, and the one override.
 *
 * Blockers are rendered as sentences, not as a disabled button with a tooltip.
 * A control that refuses without saying why is the specific failure this
 * component exists to avoid.
 *
 * Only the verification gate has an override, and taking it requires typing a
 * reason. Stale flags and orphans have no override, because reviewing them IS
 * the fix: a second waive-it switch would just be a faster way to approve text
 * whose evidence has moved.
 */
export function ApprovalBar({
  draft,
  blockers,
  gateBlocked,
  onApprove,
  onOverrideGate,
  onReopen,
  busy,
}: {
  draft: DraftDoc
  blockers: string[]
  /** True when the only thing standing in the way is the verification gate. */
  gateBlocked: boolean
  onApprove: () => void
  onOverrideGate: (reason: string) => void
  onReopen: () => void
  busy: boolean
}) {
  const [reason, setReason] = useState('')
  const [showOverride, setShowOverride] = useState(false)

  if (draft.status !== 'draft') {
    return (
      <div className="approvebar">
        <span className="pill synced">{draft.status}</span>
        {draft.approvedBy && (
          <span className="small muted">
            Approved by {draft.approvedBy}
            {draft.approvedAt ? ` on ${new Date(draft.approvedAt).toLocaleString()}` : ''}
          </span>
        )}
        {draft.approvedSnapshot?.gateOverrideReason && (
          <span className="pill queued" title={draft.approvedSnapshot.gateOverrideReason}>
            sent unverified
          </span>
        )}
        <span className="spacer" />
        {draft.status === 'approved' && (
          <button className="ghost btn--sm" onClick={onReopen} disabled={busy}>
            Reopen for editing
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="approvebar">
      <div style={{ flex: 1, minWidth: '16rem' }}>
        {blockers.length === 0 ? (
          <span className="small muted">Ready to approve.</span>
        ) : (
          <ul className="blockers">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {draft.gateOverride && (
          <p className="small muted" style={{ margin: 'var(--s-1) 0 0' }}>
            Verification overridden: {draft.gateOverrideReason}
          </p>
        )}
      </div>

      <button className="primary" onClick={onApprove} disabled={busy || blockers.length > 0}>
        Approve
      </button>

      {gateBlocked && !draft.gateOverride && (
        showOverride ? (
          <div className="row" style={{ flexBasis: '100%' }}>
            <input
              value={reason}
              placeholder="Why send this unverified?"
              onChange={(e) => setReason(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
            <button
              className="danger btn--sm"
              disabled={!reason.trim()}
              onClick={() => {
                onOverrideGate(reason.trim())
                setShowOverride(false)
                setReason('')
              }}
            >
              Send as unverified
            </button>
            <button className="ghost btn--sm" onClick={() => setShowOverride(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="ghost btn--sm" onClick={() => setShowOverride(true)}>
            Send unverified anyway
          </button>
        )
      )}
    </div>
  )
}
