import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useFeedback } from './feedbackContext'

/** Where on the page is this selection? Nearest heading, then aria-label, then a snippet. */
function deriveLocationLabel(range: Range): string {
  const node = range.startContainer
  const startEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)

  // Nearest preceding heading is the most useful "which section" label.
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
  let heading = ''
  if (startEl) {
    for (const h of headings) {
      if (h.compareDocumentPosition(startEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        heading = (h.textContent ?? '').trim()
      }
    }
  }
  if (heading) return heading

  let el: Element | null = startEl
  while (el) {
    const label = el.getAttribute?.('aria-label')
    if (label) return label.trim()
    el = el.parentElement
  }

  const txt = (startEl?.textContent ?? '').trim().replace(/\s+/g, ' ')
  return txt ? txt.slice(0, 60) : 'page'
}

/** True when the selection lives inside our own feedback UI (so we ignore it). */
function insideOwnUI(node: Node | null): boolean {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null)
  return !!el?.closest('.dfb-root')
}

/**
 * The addressable string a selection sits inside, if any. Elements rendered from
 * the content layer (components/Copy.tsx) or tagged reference data carry
 * data-dfb-node / data-dfb-field / data-dfb-source; walking up to the nearest one
 * is what turns "some highlighted words" into "this field of this record".
 */
interface EditTarget {
  nodeId: string
  field: string
  source: 'chrome' | 'ref'
  table?: string
}

function findEditTarget(node: Node | null): EditTarget | null {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null)
  const tagged = el?.closest<HTMLElement>('[data-dfb-node]')
  const nodeId = tagged?.dataset.dfbNode
  const field = tagged?.dataset.dfbField
  const source = tagged?.dataset.dfbSource
  if (!nodeId || !field || (source !== 'chrome' && source !== 'ref')) return null
  return { nodeId, field, source, table: tagged?.dataset.dfbTable }
}

interface Anchor {
  top: number
  left: number
  text: string
  label: string
  target: EditTarget | null
}

/**
 * Watches text selection across the whole app. When the user highlights
 * something, a small "Comment" button appears at the selection; clicking it
 * opens the comment window pre-filled with the highlighted text and a guess at
 * its location. Cmd/Ctrl+Shift+C does the same from the keyboard, and also
 * works with no selection to leave a page-level note.
 */
export function SelectionLayer() {
  const { pathname } = useLocation()
  const { openComment, openEdit, draft, editDraft, managerOpen } = useFeedback()
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  const readSelection = useCallback((): Anchor | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const text = sel.toString().trim()
    if (!text) return null
    if (insideOwnUI(sel.anchorNode)) return null
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    return {
      top: Math.max(4, rect.top - 38),
      left: Math.min(rect.left, window.innerWidth - 220),
      text,
      label: deriveLocationLabel(range),
      target: findEditTarget(range.startContainer),
    }
  }, [])

  useEffect(() => {
    // Don't track selection while a comment window or the manager is open; the
    // button is also hidden in render below, so no stale anchor shows through.
    if (draft || editDraft || managerOpen) return
    const show = () => setAnchor(readSelection())
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setAnchor(null)
    }
    const onScroll = () => setAnchor(null)
    document.addEventListener('mouseup', show)
    document.addEventListener('keyup', show)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseup', show)
      document.removeEventListener('keyup', show)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [readSelection, draft, editDraft, managerOpen])

  // Keyboard shortcut: comment on the current selection, or a page-level note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        const a = readSelection()
        openComment({
          route: pathname,
          selectionText: a?.text ?? '',
          locationLabel: a?.label ?? 'page',
        })
        setAnchor(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [readSelection, openComment, pathname])

  if (!anchor || draft || editDraft || managerOpen) return null

  return (
    <div className="dfb-root dfb-selection-actions" style={{ top: anchor.top, left: anchor.left }}>
      <button
        type="button"
        className="dfb-selection-btn"
        onMouseDown={(e) => e.preventDefault()} // keep the selection alive through the click
        onClick={() => {
          openComment({ route: pathname, selectionText: anchor.text, locationLabel: anchor.label })
          setAnchor(null)
        }}
      >
        💬 Comment
      </button>
      {/* Only offered when the selection resolves to an addressable string. Plain
          text with no data-dfb-node has nowhere to write back to. */}
      {anchor.target && (
        <button
          type="button"
          className="dfb-selection-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            openEdit({ ...anchor.target!, route: pathname, locationLabel: anchor.label })
            setAnchor(null)
          }}
        >
          ✏️ Edit
        </button>
      )}
    </div>
  )
}
