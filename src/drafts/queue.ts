// Sending an approved document, one recipient at a time, resumably.
//
// The whole idempotency story is one rule: PER-RECIPIENT STATUS IS WRITTEN
// BEFORE THE NEXT SEND STARTS. A crash, a refresh, or a closed laptop mid-run
// then resumes without re-sending, because the rows that already went are on
// disk. Batching the writes to the end would be faster and would mean a
// mid-run refresh re-sends everything that had already gone out, which for
// twenty-six people is twenty-six duplicate emails about their evaluation.

import type { DraftDoc, DraftRecipient } from './types'
import type { OutgoingMessage, Transport } from './transport'

export interface QueuedMessage extends OutgoingMessage {
  /** Which recipient rows this one message covers. */
  recipientEmails: string[]
}

/**
 * The messages an approved draft turns into.
 *
 * Respects fanout: a participant email produces one message per recipient, and
 * an event digest produces one message to the whole facilitator team. That
 * difference is the whole reason the field exists, and getting it wrong means
 * either six identical copies of the digest or one email with every
 * participant's private evaluation on it.
 *
 * The body always comes from the approved snapshot rather than from a fresh
 * render. Sending anything else would send text nobody approved.
 */
export function messagesForDraft(draft: DraftDoc): QueuedMessage[] {
  const body = draft.approvedSnapshot?.markdown
  if (body === undefined) {
    throw new Error('This draft has not been approved, so there is nothing frozen to send.')
  }

  const addressable = draft.recipients.filter((r) => r.email.trim().length > 0)
  if (addressable.length === 0) return []

  if (draft.fanout === 'single') {
    return [
      {
        to: addressable.map((r) => r.email),
        subject: draft.subject,
        body,
        recipientEmails: addressable.map((r) => r.email),
      },
    ]
  }

  return addressable.map((r) => ({
    to: [r.email],
    subject: draft.subject,
    body,
    recipientEmails: [r.email],
  }))
}

/** A recipient the queue still has work to do for. */
export function isPending(r: DraftRecipient): boolean {
  return r.status === 'pending' || r.status === 'failed'
}

export interface SendQueueDeps {
  transport: Transport
  /**
   * Persist the draft. Awaited before the next send begins, which is what makes
   * the run resumable. Injected rather than importing Dexie so the interleaving
   * can be asserted in a test.
   */
  save: (draft: DraftDoc) => Promise<void>
  now: () => string
  /** Pause between sends. Real transports get one; the test passes 0. */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Checked before each send so the UI can stop a run mid-way. */
  shouldStop?: () => boolean
  /** Retry only the failures from a previous run. */
  retryFailedOnly?: boolean
}

export interface SendQueueResult {
  draft: DraftDoc
  attempted: number
  succeeded: number
  failed: number
  skipped: number
  stopped: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Walk the queue.
 *
 * Recipients already sent (or already awaiting confirmation) are skipped, so
 * calling this again after a crash resumes rather than restarts. A failure marks
 * only that recipient and the run carries on: one bad address should not hold up
 * twenty-five good ones.
 */
export async function runSendQueue(
  input: DraftDoc,
  deps: SendQueueDeps,
): Promise<SendQueueResult> {
  if (input.status !== 'approved' && input.status !== 'sending') {
    throw new Error(`A ${input.status} draft cannot be sent.`)
  }
  if (!deps.transport.available()) {
    throw new Error(`${deps.transport.label} is not available on this device.`)
  }

  const sleep = deps.sleep ?? defaultSleep
  const delayMs = deps.delayMs ?? 0
  let draft: DraftDoc = { ...input, status: 'sending', updatedAt: deps.now() }
  await deps.save(draft)

  const messages = messagesForDraft(draft)
  let attempted = 0
  let succeeded = 0
  let failed = 0
  let skipped = 0
  let stopped = false

  for (const msg of messages) {
    const rows = draft.recipients.filter((r) => msg.recipientEmails.includes(r.email))
    const outstanding = rows.filter((r) =>
      deps.retryFailedOnly ? r.status === 'failed' : isPending(r),
    )
    if (outstanding.length === 0) {
      skipped += rows.length
      continue
    }

    if (deps.shouldStop?.()) {
      stopped = true
      break
    }

    attempted += outstanding.length
    let result
    try {
      result = await deps.transport.send(msg)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    const at = deps.now()
    const status: DraftRecipient['status'] = result.ok
      ? deps.transport.confirmsDelivery
        ? 'sent'
        : 'awaiting_confirmation'
      : 'failed'

    if (result.ok) succeeded += outstanding.length
    else failed += outstanding.length

    draft = {
      ...draft,
      recipients: draft.recipients.map((r) =>
        msg.recipientEmails.includes(r.email) && outstanding.some((o) => o.email === r.email)
          ? { ...r, status, at, error: result.ok ? null : (result.error ?? 'Send failed.') }
          : r,
      ),
      updatedAt: at,
    }

    // Before the next send. Not after the loop.
    await deps.save(draft)

    if (delayMs > 0) await sleep(delayMs)
  }

  draft = { ...draft, status: settledStatus(draft), updatedAt: deps.now() }
  await deps.save(draft)

  return { draft, attempted, succeeded, failed, skipped, stopped }
}

/**
 * A draft is only `sent` once every addressable recipient is resolved AND
 * confirmed. Anything parked at `awaiting_confirmation` keeps it in `sending`,
 * because with a non-confirming transport nobody yet knows it went.
 */
export function settledStatus(draft: DraftDoc): DraftDoc['status'] {
  const addressable = draft.recipients.filter((r) => r.email.trim().length > 0)
  if (addressable.length === 0) return 'sending'
  return addressable.every((r) => r.status === 'sent' || r.status === 'skipped') ? 'sent' : 'sending'
}

/** The human's "I sent it" on a non-confirming transport. */
export function confirmRecipient(draft: DraftDoc, email: string, at: string): DraftDoc {
  const next: DraftDoc = {
    ...draft,
    recipients: draft.recipients.map((r) =>
      r.email === email && r.status === 'awaiting_confirmation'
        ? { ...r, status: 'sent', at, error: null }
        : r,
    ),
    updatedAt: at,
  }
  return { ...next, status: settledStatus(next) }
}

/** The human's "skip this one". */
export function skipRecipient(draft: DraftDoc, email: string, at: string): DraftDoc {
  const next: DraftDoc = {
    ...draft,
    recipients: draft.recipients.map((r) =>
      r.email === email ? { ...r, status: 'skipped', at, error: null } : r,
    ),
    updatedAt: at,
  }
  return { ...next, status: settledStatus(next) }
}

export interface QueueProgress {
  total: number
  sent: number
  awaiting: number
  failed: number
  skipped: number
  pending: number
}

export function queueProgress(draft: DraftDoc): QueueProgress {
  const rows = draft.recipients.filter((r) => r.email.trim().length > 0)
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    awaiting: rows.filter((r) => r.status === 'awaiting_confirmation').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    pending: rows.filter((r) => r.status === 'pending').length,
  }
}
