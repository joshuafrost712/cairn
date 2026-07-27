import { useState } from 'react'
import type { DraftDoc } from '../../drafts/types'
import {
  confirmRecipient,
  messagesForDraft,
  queueProgress,
  runSendQueue,
  skipRecipient,
} from '../../drafts/queue'
import { bodyFitsInUrl, browserMailtoTransport } from '../../drafts/transports/mailto'

/**
 * The send walkthrough.
 *
 * A walkthrough rather than a "Send all" button, because the transport cannot
 * confirm anything: opening a compose window is not delivery. So each recipient
 * parks at "waiting for you to confirm" and the count only moves when a human
 * says it went. The audit record then says the admin asserts it was sent, which
 * is true, rather than that the app sent it, which would not be.
 */
export function SendQueue({
  draft,
  onSave,
}: {
  draft: DraftDoc
  onSave: (next: DraftDoc) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (draft.status === 'draft' || draft.status === 'superseded') return null

  const progress = queueProgress(draft)
  const messages = safeMessages(draft)
  const oversize = messages.some((m) => !bodyFitsInUrl(m))

  const run = async (retryFailedOnly: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await runSendQueue(draft, {
        transport: browserMailtoTransport,
        save: onSave,
        now: () => new Date().toISOString(),
        // One at a time with a pause: the mail client needs a moment, and
        // twenty-six compose windows at once is not a workflow.
        delayMs: 400,
        retryFailedOnly,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Send</h2>
        <span className="spacer" />
        <span className="small muted">
          {progress.sent} of {progress.total} confirmed
          {progress.awaiting > 0 && ` · ${progress.awaiting} waiting on you`}
          {progress.failed > 0 && ` · ${progress.failed} failed`}
        </span>
      </div>

      <p className="small muted">
        {draft.fanout === 'single'
          ? 'One email to the whole facilitator team.'
          : 'One email per recipient, sent one at a time from your own mail app.'}{' '}
        Your mail app cannot tell this device whether a message actually left, so each row waits
        for you to confirm it.
      </p>

      {oversize && (
        <div className="banner warn">
          This document is too long to pre-fill into a mail window without risking truncation. The
          body is copied to your clipboard instead; paste it into the empty compose window.
        </div>
      )}

      {err && <div className="banner warn">{err}</div>}

      <div className="row">
        <button className="primary" disabled={busy || progress.pending === 0} onClick={() => run(false)}>
          {progress.pending === 0 ? 'Nothing pending' : `Open ${progress.pending} mail window(s)`}
        </button>
        {progress.failed > 0 && (
          <button className="ghost" disabled={busy} onClick={() => run(true)}>
            Retry {progress.failed} failed
          </button>
        )}
      </div>

      <div className="stack-tight">
        {draft.recipients.map((r) => (
          <div className="row rail" key={r.email || r.name || 'unaddressed'}>
            <span className={`pill ${statusClass(r.status)}`}>{label(r.status)}</span>
            <span className="small">
              {r.email || <span className="muted">no address on the roster</span>}
              {r.name ? <span className="muted"> · {r.name}</span> : null}
            </span>
            {r.error && <span className="small" style={{ color: 'var(--danger)' }}>{r.error}</span>}
            <span className="spacer" />
            {r.status === 'awaiting_confirmation' && (
              <>
                <button
                  className="primary btn--sm"
                  disabled={busy}
                  onClick={() => onSave(confirmRecipient(draft, r.email, new Date().toISOString()))}
                >
                  I sent it
                </button>
                <button
                  className="ghost btn--sm"
                  disabled={busy}
                  onClick={() => onSave(skipRecipient(draft, r.email, new Date().toISOString()))}
                >
                  Skip
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** messagesForDraft throws on an unapproved draft; here that just means no rows yet. */
function safeMessages(draft: DraftDoc) {
  try {
    return messagesForDraft(draft)
  } catch {
    return []
  }
}

function label(status: string): string {
  if (status === 'awaiting_confirmation') return 'waiting on you'
  return status
}

function statusClass(status: string): string {
  if (status === 'sent') return 'synced'
  if (status === 'failed') return 'error'
  if (status === 'skipped') return ''
  return 'queued'
}
