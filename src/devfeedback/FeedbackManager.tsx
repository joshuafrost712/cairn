import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useFeedback } from './feedbackContext'
import {
  fdb,
  deleteComment,
  markSent,
  updateComment,
  IMPORTANCE_ORDER,
  type FeedbackComment,
  type Importance,
} from './db'
import { renderBatchMarkdown } from './render'
import { sendBatch } from './send'

/**
 * The comment manager: review every open comment, re-rank or edit it, drop the
 * ones that no longer matter, then send the whole set to Claude as one batch.
 */
export function FeedbackManager() {
  const { managerOpen, setManagerOpen } = useFeedback()
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)

  const comments = useLiveQuery(async () => {
    const open = await fdb.comments.where('status').equals('open').toArray()
    return open.sort(
      (a, b) =>
        IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || a.createdAt.localeCompare(b.createdAt),
    )
  }, [])

  if (!managerOpen) return null

  const send = async () => {
    if (!comments || comments.length === 0 || sending) return
    // Snapshot the batch: `comments` is a live query and must not shift under us
    // between the send and the mark-sent flip.
    const batch = comments
    setSending(true)
    setStatus('Sending…')
    const md = renderBatchMarkdown(batch, new Date().toISOString())
    const result = await sendBatch(md)
    if (!result.ok) {
      setSending(false)
      setStatus("Couldn't send the batch — nothing was marked done, so nothing is lost. Please try again.")
      return
    }
    // Only flip status→sent after the batch is delivered/exported, and only
    // report success once that flip has actually persisted. If markSent fails
    // silently the comments stay `open` and get re-exported in the next batch —
    // that is the duplication bug this guard exists to prevent.
    try {
      await markSent(batch.map((c) => c.id))
    } catch {
      setSending(false)
      setStatus(
        'The batch was sent, but marking it done failed. Do NOT resend — reload and check the batch first, or these comments will be sent again.',
      )
      return
    }
    setSending(false)
    setStatus(
      result.fallback === 'download'
        ? `Dev server not reached — downloaded the batch instead. Move it into feedback/incoming/.`
        : `Sent ${batch.length} comment${batch.length === 1 ? '' : 's'} → ${result.path ?? 'feedback/incoming/'}`,
    )
  }

  return (
    <div className="dfb-root dfb-drawer-wrap" role="dialog" aria-label="Feedback manager">
      <div className="dfb-scrim" onClick={() => setManagerOpen(false)} />
      <aside className="dfb-drawer">
        <div className="dfb-panel-head">
          <strong>Feedback ({comments?.length ?? 0})</strong>
          <button type="button" className="dfb-x" onClick={() => setManagerOpen(false)}>
            Close
          </button>
        </div>

        <p className="dfb-muted dfb-hint">
          Review and rank, then send the whole set as one batch. They're handled together so
          recurring issues get fixed once, not one comment at a time.
        </p>

        <div className="dfb-list">
          {comments && comments.length === 0 && (
            <p className="dfb-muted">No open comments. Highlight text anywhere to add one.</p>
          )}
          {comments?.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </div>

        <div className="dfb-drawer-foot">
          {status && <span className="dfb-muted dfb-status">{status}</span>}
          <button
            type="button"
            className="dfb-btn dfb-btn-primary"
            disabled={!comments || comments.length === 0 || sending}
            onClick={send}
          >
            Send batch to Claude
          </button>
        </div>
      </aside>
    </div>
  )
}

function CommentRow({ comment }: { comment: FeedbackComment }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(comment.comment)

  const saveEdit = async () => {
    await updateComment(comment.id, { comment: text.trim() || comment.comment })
    setEditing(false)
  }

  return (
    <div className={`dfb-item dfb-imp-${comment.importance}`}>
      <div className="dfb-item-head">
        <select
          value={comment.importance}
          onChange={(e) => updateComment(comment.id, { importance: e.target.value as Importance })}
          aria-label="Importance"
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <span className="dfb-tag">{comment.route}</span>
        <div className="dfb-spacer" />
        <button type="button" className="dfb-link" onClick={() => (editing ? saveEdit() : setEditing(true))}>
          {editing ? 'Save' : 'Edit'}
        </button>
        <button
          type="button"
          className="dfb-link dfb-danger"
          onClick={() => {
            if (confirm('Delete this comment?')) void deleteComment(comment.id)
          }}
        >
          Delete
        </button>
      </div>

      {comment.locationLabel && <div className="dfb-muted dfb-loc">{comment.locationLabel}</div>}
      {comment.selectionText && <blockquote className="dfb-quote dfb-quote-sm">{comment.selectionText}</blockquote>}

      {editing ? (
        <textarea className="dfb-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      ) : (
        <div className="dfb-comment">{comment.comment}</div>
      )}
    </div>
  )
}
