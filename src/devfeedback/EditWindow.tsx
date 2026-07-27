import { useEffect, useState } from 'react'
import { findChromeNode, type ChromeField } from '../lib/content/chrome'
import { useFeedback } from './feedbackContext'
import { addProposal, type ProposalTable } from './db'
import { applyChromeEdit } from './applyEdit'
import { loadRefRow, readRefField, refFieldLabel } from './refField'
import type { EditDraft } from './feedbackContext'

const CHROME_FIELD_LABEL: Record<string, string> = {
  label: 'text',
  guidance: 'guidance note',
  help: 'explainer',
}

/**
 * Edit-in-place. Opens on the CURRENT stored value of the selected string, never
 * on the rendered text, so a token like {total} stays visible and the edit stays
 * valid for every render of that string.
 *
 * Chrome saves apply immediately through the dev server: a hot reload plus a git
 * diff, seconds later. Reference saves never apply here. That text is live for
 * every evaluator, and rewording a question underneath someone mid-capture is
 * exactly what this design prevents, so a reference save files a proposal for
 * approval on the Admin page instead.
 *
 * The panel is keyed on the edit target. Reliability invariant #2 in
 * docs/feedback-widget-pattern.md: a singleton panel keeps its local draft state
 * across targets, so a previous target's typed text leaks into the next one that
 * opens. Remounting on target identity resets that state by construction, which
 * is sturdier than clearing it in an effect and cannot be half-applied.
 */
export function EditWindow() {
  const { editDraft } = useFeedback()
  if (!editDraft) return null
  return (
    <EditPanel
      key={`${editDraft.source}:${editDraft.nodeId}:${editDraft.field}`}
      draft={editDraft}
    />
  )
}

function EditPanel({ draft }: { draft: EditDraft }) {
  const { closeEdit } = useFeedback()
  const [text, setText] = useState<string | null>(null)
  const [oldText, setOldText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const isRef = draft.source === 'ref'

  // Resolve the authoritative current value: chrome from the bundled JSON,
  // reference from the local row. Read here rather than from the DOM so an edit
  // starts from the stored string (tokens intact), not the rendered one.
  useEffect(() => {
    let cancelled = false
    const resolve = async (): Promise<string> => {
      if (draft.source === 'chrome') {
        const value = findChromeNode(draft.nodeId)?.[draft.field as ChromeField]
        return typeof value === 'string' ? value : ''
      }
      const row = await loadRefRow((draft.table ?? 'ksa') as ProposalTable, draft.nodeId)
      return readRefField(row, draft.field)
    }
    void resolve().then((value) => {
      if (cancelled) return
      setOldText(value)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [draft.source, draft.nodeId, draft.field, draft.table])

  const value = text ?? oldText
  const dirty = value.trim() !== oldText.trim()
  const fieldLabel = isRef
    ? refFieldLabel(draft.field)
    : (CHROME_FIELD_LABEL[draft.field] ?? draft.field)

  const save = async () => {
    const newText = value.trim()
    if (!newText || !dirty || saving) return
    setSaving(true)
    setNotice('')

    if (isRef) {
      await addProposal({
        table: (draft.table ?? 'ksa') as ProposalTable,
        rowId: draft.nodeId,
        field: draft.field,
        oldText,
        newText,
        route: draft.route,
        locationLabel: draft.locationLabel,
      })
      setSaving(false)
      closeEdit()
      return
    }

    const result = await applyChromeEdit({
      nodeId: draft.nodeId,
      field: draft.field,
      oldText,
      newText,
    })
    setSaving(false)
    if (result === 'applied') return closeEdit()
    if (result === 'stale') {
      return setNotice('This text changed since the page loaded. Reload, then redo the edit.')
    }
    if (result === 'unavailable') {
      return setNotice(
        'No dev server here, so app text cannot be written to file. Run the app locally with npm run dev to edit it.',
      )
    }
    setNotice('The dev server refused the edit. Check its console for the reason.')
  }

  return (
    <div className="dfb-root dfb-overlay" role="dialog" aria-label="Edit text">
      <div className="dfb-panel">
        <div className="dfb-panel-head">
          <strong>Edit {fieldLabel}</strong>
          <button type="button" className="dfb-x" onClick={closeEdit}>
            Cancel
          </button>
        </div>

        <div className="dfb-meta">
          <span className="dfb-tag">{draft.route}</span>
          {draft.locationLabel && <span className="dfb-tag dfb-tag-soft">{draft.locationLabel}</span>}
          <span className="dfb-tag dfb-tag-soft">{isRef ? `${draft.table} record` : 'app text'}</span>
        </div>

        <p className="dfb-muted">
          {isRef
            ? 'Live for every evaluator, so saving files this for approval on the Admin page rather than changing it now.'
            : 'Saving rewrites content/chrome.json and hot-reloads. Keep any {tokens} — they are filled in at render.'}
        </p>

        <textarea
          autoFocus
          rows={5}
          className="dfb-textarea"
          value={loading ? '' : value}
          disabled={loading || saving}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save()
          }}
        />

        {notice && <p className="dfb-muted dfb-status">{notice}</p>}

        <div className="dfb-row">
          <div className="dfb-spacer" />
          <button
            type="button"
            className="dfb-btn dfb-btn-primary"
            disabled={loading || saving || !dirty || !value.trim()}
            onClick={save}
          >
            {saving ? 'Saving…' : isRef ? 'Propose change' : 'Save to file'}
          </button>
        </div>
      </div>
    </div>
  )
}
