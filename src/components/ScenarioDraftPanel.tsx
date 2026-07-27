import { useState } from 'react'
import { readDocumentFile } from '../ai/parseDocument'
import {
  buildScenarioPrompt,
  canDraftWithAI,
  draftScenarioWithAI,
  importScenarioDraft,
  parseDraftReply,
} from '../ai/scenarioDraft'
import type { ScenarioDraft } from '../ai/scenarioContract'

/**
 * "Upload a document → AI drafts the scenario → you edit it" panel for the Builder.
 * Two paths: a one-click Gemini path via the draft-scenario Edge Function, and a
 * token-free copy/paste path (paste the prompt into any LLM, paste the JSON back).
 * Either way the result is a DRAFT that lands as editable rows for human review.
 */
export function ScenarioDraftPanel({ workshopId }: { workshopId: string }) {
  const [open, setOpen] = useState(false)
  const [docText, setDocText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [draft, setDraft] = useState<ScenarioDraft | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onFile = async (file: File) => {
    setStatus(null)
    const r = await readDocumentFile(file)
    if (r.ok) {
      setDocText(r.text)
      setStatus(`Loaded ${file.name} (${r.text.length.toLocaleString()} chars).`)
    } else {
      setStatus(r.reason)
    }
  }

  const runAI = async () => {
    setBusy(true)
    setStatus('Drafting with Gemini…')
    setDraft(null)
    const r = await draftScenarioWithAI(docText)
    setBusy(false)
    if (r.ok) {
      setDraft(r.value)
      setStatus('Draft ready — review the counts below, then import.')
    } else {
      setStatus(`AI drafting failed: ${r.reason}. You can use the copy/paste path instead.`)
    }
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildScenarioPrompt(docText))
      setStatus('Prompt copied. Paste it into your LLM, then paste the JSON reply below.')
    } catch {
      setStatus('Could not access the clipboard; select the prompt text manually.')
    }
  }

  const parseReply = () => {
    const r = parseDraftReply(replyText)
    if (r.ok) {
      setDraft(r.value)
      setStatus('Draft parsed — review the counts below, then import.')
    } else {
      setStatus(`Could not use that reply: ${r.reason}`)
    }
  }

  const doImport = async () => {
    if (!draft) return
    setBusy(true)
    const r = await importScenarioDraft(draft, workshopId)
    setBusy(false)
    setDraft(null)
    setDocText('')
    setReplyText('')
    setStatus(
      `Imported ${r.activities} event(s), ${r.ksas} question(s), ${r.wired} wiring link(s). ` +
        'Review and edit them below before use.',
    )
  }

  if (!open) {
    return (
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Draft from a document (AI)</h2>
          <button className="ghost" onClick={() => setOpen(true)}>Open</button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Upload or paste a curriculum and let AI draft the events, questions, and boxes for you to edit.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Draft from a document (AI)</h2>
        <button className="ghost" onClick={() => setOpen(false)}>Close</button>
      </div>

      <p className="small muted">
        The AI writes a first draft; nothing is saved until you import, and everything imported is fully editable.
        Note: the Gemini free tier may use submitted text to improve Google's products — avoid pasting confidential
        material, or use your own LLM via the copy/paste path.
      </p>

      <label className="small muted">Source document</label>
      <input
        type="file"
        accept=".txt,.md,.markdown,.text,.csv,.json,text/*,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
        }}
      />
      <textarea
        rows={5}
        value={docText}
        onChange={(e) => setDocText(e.target.value)}
        placeholder="…or paste the curriculum / competency text here"
        style={{ marginTop: '0.4rem' }}
      />

      <div className="row" style={{ marginTop: '0.4rem', flexWrap: 'wrap' }}>
        {canDraftWithAI && (
          <button disabled={busy || !docText.trim()} onClick={runAI}>
            Draft with Gemini
          </button>
        )}
        <button className="ghost" disabled={!docText.trim()} onClick={copyPrompt}>
          Copy prompt for my own LLM
        </button>
      </div>

      <details style={{ marginTop: '0.5rem' }}>
        <summary className="small muted">Paste an LLM reply (copy/paste path)</summary>
        <textarea
          rows={5}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Paste the JSON the LLM returned here"
          className="mono"
        />
        <button className="ghost" disabled={!replyText.trim()} onClick={parseReply}>
          Use this reply
        </button>
      </details>

      {draft && (
        <div className="banner" style={{ marginTop: '0.5rem' }}>
          <div className="small">
            Draft: <strong>{draft.activities.length}</strong> event(s),{' '}
            <strong>{draft.ksas.length}</strong> question(s),{' '}
            <strong>{draft.wiring.length}</strong> wiring group(s).
          </div>
          <button disabled={busy} onClick={doImport} style={{ marginTop: '0.4rem' }}>
            Import into this scenario
          </button>
        </div>
      )}

      {status && <p className="small muted" style={{ marginTop: '0.5rem' }}>{status}</p>}
    </div>
  )
}
