import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthContext'
import { db } from '../db/local'
import { readDocumentFile } from '../ai/parseDocument'
import {
  importScenarioDraft,
  parseDraftReply,
  MAX_SCENARIO_DOCUMENT_CHARS,
} from '../ai/scenarioDraft'
import { runAiJob } from '../ai/providers'
import { traceAiCall } from '../db/aiConfig'
import { aiEnabled, aiUnavailableReason } from '../ai/aiEnabled'
import { resolveAiConfig } from '../lib/aiConfig'
import { buildScale, type ScalePoint } from '../lib/scale'
import { c } from '../lib/content/chrome'
import type { ScenarioDraft } from '../ai/scenarioContract'

/**
 * "Upload a document → AI drafts the scenario → you edit it".
 *
 * Three things changed in tl-13, and each was a bug before it was a feature.
 *
 * IT GOES THROUGH THE PROVIDER. The panel no longer decides how the work gets done;
 * it hands a job to `runAiJob`, which checks the toggle, picks the mode, traces the
 * call, and comes back either with a draft or with a prompt for the operator. That is
 * why there is no longer a "Draft with Gemini" button beside a separate copy/paste
 * path: there is one button, and what it does depends on the workshop's mode.
 *
 * IT CARRIES THE WORKSHOP'S SCALE. tl-09 made the grading scale configurable and the
 * drafter went on asking for four descriptors, so a five-point workshop got a draft
 * that contradicted its own scale with no error anywhere (D2). The scale now travels
 * with the job, and `importScenarioDraft` reshapes whatever comes back onto the real
 * points.
 *
 * IT SAYS WHEN IT IS OFF. A switched-off function shows the reason rather than a
 * button that will be refused, and still points at the manual route, because "AI is
 * off here" must not read as "you cannot author a scenario".
 */
export function ScenarioDraftPanel({ workshopId }: { workshopId: string }) {
  const { identity } = useAuth()
  const [open, setOpen] = useState(false)
  const [docText, setDocText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [draft, setDraft] = useState<ScenarioDraft | null>(null)
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const configRows = useLiveQuery(() => db.aiConfigs.toArray(), [], [])
  const config = resolveAiConfig(workshopId, configRows ?? [])
  const enabled = aiEnabled('scenario_draft', config)
  const offReason = aiUnavailableReason('scenario_draft', config)

  const points = useLiveQuery(
    () => db.scalePoints.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as ScalePoint[],
  )
  const scale = buildScale(workshopId, points ?? []).points.map((p) => ({
    value: p.value,
    label: p.label,
  }))

  const tooLong = docText.length > MAX_SCENARIO_DOCUMENT_CHARS

  const onFile = async (file: File) => {
    setStatus(null)
    const r = await readDocumentFile(file)
    if (!r.ok) {
      setStatus(r.reason)
      return
    }
    if (r.text.length > MAX_SCENARIO_DOCUMENT_CHARS) {
      // Refused at the boundary rather than truncated: half a curriculum drafts a
      // scenario that looks complete and is missing whatever was in the other half.
      setStatus(
        c('setup.ai.draft.too-long', 'label', {
          chars: r.text.length.toLocaleString(),
          limit: MAX_SCENARIO_DOCUMENT_CHARS.toLocaleString(),
        }),
      )
      return
    }
    setDocText(r.text)
    setStatus(
      c('setup.ai.draft.loaded', 'label', {
        name: file.name,
        chars: r.text.length.toLocaleString(),
      }),
    )
  }

  /** One button, whatever the mode. The provider decides what happens. */
  const run = async () => {
    setBusy(true)
    setStatus(c('setup.ai.draft.working'))
    setDraft(null)
    setPrompt('')
    const outcome = await runAiJob(
      {
        fn: 'scenario_draft',
        workshopId,
        actorEmail: identity?.email ?? null,
        document: docText,
        scale,
      },
      { config },
    )
    setBusy(false)

    if (outcome.kind === 'result') {
      setDraft(outcome.value as ScenarioDraft)
      setStatus(c('setup.ai.draft.ready'))
      return
    }
    if (outcome.kind === 'operator_action') {
      setPrompt(outcome.prompt ?? '')
      let copied = false
      if (outcome.prompt && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(outcome.prompt)
          copied = true
        } catch {
          /* clipboard blocked: the textarea below still holds it */
        }
      }
      setStatus(
        `${c(outcome.instructionsId ?? 'setup.ai.op.fallback-prompt')} ${
          copied ? c('setup.ai.draft.copied') : c('setup.ai.draft.not-copied')
        }`,
      )
      return
    }
    setStatus(
      outcome.kind === 'refused'
        ? c(outcome.reason ?? 'setup.ai.fn.disabled')
        : c('setup.ai.draft.failed', 'label', { reason: outcome.reason ?? '' }),
    )
  }

  /**
   * The paste-back half of the hand-off, and it goes through the SAME GUARD.
   *
   * It did not, and that was the toggle's biggest hole: `parseReply` and `doImport`
   * called the contract and the importer directly, so with draft-fill switched off an
   * administrator could still paste a model's output and have it write activities,
   * goals and questions — no refusal and no trace, which is exactly what the spec's
   * "attempt to invoke it through the UI and confirm both are refused" is about. A
   * pasted reply is model output arriving by a different door; the door does not
   * change whether the workshop said yes.
   *
   * Capped as well, because a pasted blob is as arbitrary as an uploaded file and had
   * no limit at all where the document has three.
   */
  const parseReply = async () => {
    if (replyText.length > MAX_SCENARIO_DOCUMENT_CHARS) {
      setStatus(
        c('setup.ai.draft.too-long', 'label', {
          chars: replyText.length.toLocaleString(),
          limit: MAX_SCENARIO_DOCUMENT_CHARS.toLocaleString(),
        }),
      )
      return
    }
    if (!enabled) {
      setStatus(c(offReason ?? 'setup.ai.fn.disabled'))
      return
    }
    const r = parseDraftReply(replyText)
    // Traced by hand rather than through `runAiJob`, because no provider ran: the
    // model call happened in somebody else's tool. What the trace records is that
    // model output entered this workshop, which is the fact worth having.
    void traceAiCall({
      workshop_id: workshopId,
      fn: 'scenario_draft',
      mode: config.mode,
      model: null,
      actor_email: identity?.email ?? null,
      input_chars: replyText.length,
      outcome: r.ok ? 'result' : 'error',
      detail: r.ok ? 'setup.ai.op.pasted-reply' : r.reason,
      tokens_in: null,
      tokens_out: null,
      latency_ms: null,
    })
    if (r.ok) {
      setDraft(r.value)
      setStatus(c('setup.ai.draft.parsed'))
    } else {
      setStatus(c('setup.ai.draft.bad-reply', 'label', { reason: r.reason }))
    }
  }

  const doImport = async () => {
    if (!draft) return
    // The last gate before anything is written. A draft can sit in state across a
    // switch being turned off in another tab, and importing it would be the write the
    // switch exists to prevent.
    if (!enabled) {
      setStatus(c(offReason ?? 'setup.ai.fn.disabled'))
      return
    }
    setBusy(true)
    const r = await importScenarioDraft(draft, workshopId, scale)
    setBusy(false)
    setDraft(null)
    setDocText('')
    setReplyText('')
    setPrompt('')
    setStatus(
      c('setup.ai.draft.imported', 'label', {
        activities: r.activities,
        questions: r.ksas,
        wired: r.wired,
      }),
    )
  }

  if (!open) {
    return (
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{c('setup.ai.draft.title')}</h2>
          <button className="ghost" onClick={() => setOpen(true)}>
            {c('setup.ai.draft.open')}
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {c('setup.ai.draft.teaser')}
        </p>
        {offReason && (
          <p className="small" style={{ marginBottom: 0 }}>
            <span className="pill queued">{c('setup.ai.fn.off')}</span> {c(offReason)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{c('setup.ai.draft.title')}</h2>
        <button className="ghost" onClick={() => setOpen(false)}>
          {c('setup.ai.draft.close')}
        </button>
      </div>

      <p className="small muted">{c('setup.ai.draft.intro')}</p>
      <p className="small muted">{c(`setup.ai.draft.mode-note.${config.mode}`)}</p>

      {offReason ? (
        <div className="banner warn">
          <p className="small" style={{ marginBottom: 0 }}>
            {c(offReason)} {c('setup.ai.draft.manual-route')}
          </p>
        </div>
      ) : null}

      <label className="small muted" htmlFor="scenario-doc">
        {c('setup.ai.draft.source')}
      </label>
      <input
        id="scenario-doc"
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
        placeholder={c('setup.ai.draft.paste-placeholder')}
        style={{ marginTop: '0.4rem' }}
      />
      {tooLong && (
        <p className="small">
          <span className="pill error">{c('setup.ai.draft.too-long-pill')}</span>{' '}
          {c('setup.ai.draft.too-long', 'label', {
            chars: docText.length.toLocaleString(),
            limit: MAX_SCENARIO_DOCUMENT_CHARS.toLocaleString(),
          })}
        </p>
      )}

      <div className="row" style={{ marginTop: '0.4rem', flexWrap: 'wrap' }}>
        <button disabled={busy || !enabled || tooLong || !docText.trim()} onClick={() => void run()}>
          {c('setup.ai.draft.run')}
        </button>
      </div>

      {prompt && (
        <textarea
          className="mono"
          readOnly
          value={prompt}
          rows={6}
          onFocus={(e) => e.currentTarget.select()}
          style={{ marginTop: '0.5rem' }}
        />
      )}

      {/* Hidden, not merely disabled, while the function is off: an open box inviting
          a paste is a promise the switch has already withdrawn. */}
      {enabled && (
        <details style={{ marginTop: '0.5rem' }}>
          <summary className="small muted">{c('setup.ai.draft.paste-back')}</summary>
          <textarea
            rows={5}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={c('setup.ai.draft.reply-placeholder')}
            className="mono"
          />
          <button className="ghost" disabled={!replyText.trim()} onClick={() => void parseReply()}>
            {c('setup.ai.draft.use-reply')}
          </button>
        </details>
      )}

      {draft && (
        <div className="banner" style={{ marginTop: '0.5rem' }}>
          <div className="small">
            {c('setup.ai.draft.counts', 'label', {
              activities: draft.activities.length,
              questions: draft.ksas.length,
              wiring: draft.wiring.length,
            })}
          </div>
          <button disabled={busy} onClick={() => void doImport()} style={{ marginTop: '0.4rem' }}>
            {c('setup.ai.draft.import')}
          </button>
        </div>
      )}

      {status && (
        <p className="small muted" style={{ marginTop: '0.5rem' }}>
          {status}
        </p>
      )}
    </div>
  )
}
