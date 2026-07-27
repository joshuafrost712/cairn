import { useEffect, useRef, useState } from 'react'
import type { DocSegment } from '../../reports/segments'
import type { DraftFlag } from '../../drafts/types'

/**
 * One clickable line of the document, and its editor.
 *
 * Editing is a TEXTAREA SWAP, not contenteditable. Four reasons, in order of
 * how much they would have cost:
 *
 *   - The content is plain markdown. contenteditable hands back an HTML fragment
 *     that needs sanitizing and a round-trip back to markdown: a whole
 *     correctness and XSS surface for a need that does not exist here.
 *   - There is a live useLiveQuery underneath, so re-renders are frequent, and
 *     contenteditable fights React 19 with a caret jump on each one.
 *   - The repo already does this swap twice (ObsEditor in RecordsBrowser,
 *     CommentRow in FeedbackManager), so it is the idiom here.
 *   - An evidence segment is genuinely multi-line.
 *
 * The honest cost is losing click-to-place-caret. Mitigated by sizing the
 * textarea to the text on mount so the document does not jump, and by placing
 * the caret at the end rather than selecting all, which would make the first
 * keystroke destroy the line.
 */
export function SegmentRow({
  seg,
  selected,
  editing,
  overrideText,
  deleted,
  flag,
  canEdit,
  onSelect,
  onStartEdit,
  onCommit,
  onCancel,
  onDelete,
  onRestore,
}: {
  seg: DocSegment
  selected: boolean
  editing: boolean
  /** The human's text, when there is one. */
  overrideText: string | null | undefined
  deleted: boolean
  flag: DraftFlag | undefined
  canEdit: boolean
  onSelect: () => void
  onStartEdit: () => void
  onCommit: (text: string) => void
  onCancel: () => void
  onDelete: () => void
  onRestore: () => void
}) {
  const shown = overrideText ?? seg.text
  const edited = overrideText !== undefined && overrideText !== null

  if (editing) {
    return (
      <SegmentEditor
        initial={shown}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    )
  }

  return (
    <div>
      <button
        type="button"
        className="seg"
        role="option"
        aria-selected={selected}
        data-kind={seg.kind}
        data-level={seg.level}
        data-editable={canEdit}
        data-edited={edited}
        data-flagged={Boolean(flag)}
        data-deleted={deleted}
        onClick={onSelect}
        onDoubleClick={() => canEdit && onStartEdit()}
      >
        <span className="seg__badges">
          {seg.evidence.length > 0 && (
            <span className="seg__n" title={`${seg.evidence.length} observation(s) behind this line`}>
              {seg.evidence.length}
            </span>
          )}
          {edited && <span className="pill">edited</span>}
          {flag && (
            <span className="pill queued">
              {flag.kind === 'stale-evidence' ? 'evidence changed' : 'reworded'}
            </span>
          )}
        </span>
        {deleted ? shown : shown || ' '}
      </button>

      {selected && canEdit && (
        <div className="row" style={{ padding: '0 var(--s-2) var(--s-2)' }}>
          {deleted ? (
            <button className="ghost btn--sm" onClick={onRestore}>
              Restore this line
            </button>
          ) : (
            <>
              <button className="ghost btn--sm" onClick={onStartEdit}>
                Edit
              </button>
              {/* A button, never a bare keystroke: Delete on a selected row is
                  one slip away from removing a line you were only reading. */}
              <button className="ghost btn--sm" onClick={onDelete}>
                Delete line
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SegmentEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.focus()
    // Caret at the end, not select-all: the first keystroke should append, not
    // wipe the line the user meant to tweak.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  return (
    <div style={{ padding: 'var(--s-1) var(--s-2)' }}>
      <textarea
        ref={ref}
        className="seg-edit"
        value={text}
        rows={1}
        onChange={(e) => {
          setText(e.target.value)
          grow(e.currentTarget)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onCommit(text)
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            onCommit(text)
          }
        }}
      />
      <div className="seg-edit__bar">
        <button className="primary btn--sm" onClick={() => onCommit(text)}>
          Save
        </button>
        <button className="ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <span className="small muted">⌘↵ saves · Esc cancels</span>
      </div>
    </div>
  )
}
