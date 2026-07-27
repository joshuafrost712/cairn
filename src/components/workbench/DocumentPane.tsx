import { useEffect, useRef } from 'react'
import type { DocSegment } from '../../reports/segments'
import type { DraftFlag, SegmentOverride } from '../../drafts/types'
import { canEditSegment, nextSegmentId, type NavKey } from '../../workbench/nav'
import { SegmentRow } from './SegmentRow'

/**
 * The left-hand column: the document as a list of clickable lines.
 *
 * A listbox rather than a set of loose buttons, so a screen reader announces it
 * as a document you are moving through rather than as forty unrelated controls.
 */
export function DocumentPane({
  segments,
  overrides,
  flags,
  selectedId,
  editingId,
  editable,
  onSelect,
  onStartEdit,
  onCommit,
  onCancelEdit,
  onDelete,
  onRestore,
}: {
  segments: DocSegment[]
  overrides: SegmentOverride[]
  flags: DraftFlag[]
  selectedId: string | null
  editingId: string | null
  editable: boolean
  onSelect: (id: string) => void
  onStartEdit: (id: string) => void
  onCommit: (id: string, text: string) => void
  onCancelEdit: () => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
}) {
  const overrideById = new Map(overrides.map((o) => [o.segmentId, o]))
  const flagById = new Map(flags.map((f) => [f.segmentId, f]))
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keyboard movement lives here rather than on each row: one listener, and the
  // arrow keys keep working when the focused element is the container itself.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return
      const map: Record<string, NavKey> = {
        ArrowDown: 'down',
        ArrowUp: 'up',
        Home: 'home',
        End: 'end',
      }
      const key = map[e.key]
      if (key) {
        e.preventDefault()
        const next = nextSegmentId(segments, selectedId, key)
        if (next) onSelect(next)
        return
      }
      if (e.key === 'Enter' && selectedId) {
        const seg = segments.find((s) => s.id === selectedId)
        if (canEditSegment(seg, editable)) {
          e.preventDefault()
          onStartEdit(selectedId)
        }
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [segments, selectedId, editingId, editable, onSelect, onStartEdit])

  return (
    <div
      className="card doc"
      role="listbox"
      aria-label="Document"
      tabIndex={0}
      ref={listRef}
    >
      {segments.map((seg) => {
        const ov = overrideById.get(seg.id)
        return (
          <SegmentRow
            key={seg.id}
            seg={seg}
            selected={selectedId === seg.id}
            editing={editingId === seg.id}
            overrideText={ov?.text}
            deleted={ov?.text === null}
            flag={flagById.get(seg.id)}
            canEdit={canEditSegment(seg, editable)}
            onSelect={() => onSelect(seg.id)}
            onStartEdit={() => onStartEdit(seg.id)}
            onCommit={(text) => onCommit(seg.id, text)}
            onCancel={onCancelEdit}
            onDelete={() => onDelete(seg.id)}
            onRestore={() => onRestore(seg.id)}
          />
        )
      })}
    </div>
  )
}
