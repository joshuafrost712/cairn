// How an approved document leaves the device.
//
// A seam, because the transport is the part most likely to change and the least
// interesting part of the problem. Everything hard (the queue, per-recipient
// state, resume, retry, the audit record) is transport-independent and lives in
// queue.ts, so swapping mailto for a real relay later is one file.

export interface OutgoingMessage {
  /** Recipients on this single message. One for a participant email; all of them for a digest. */
  to: string[]
  subject: string
  body: string
}

export interface SendResult {
  ok: boolean
  error?: string
}

export interface Transport {
  id: string
  label: string
  /**
   * Whether a successful send means the message actually went.
   *
   * This is the field that keeps the audit trail honest. `MailtoTransport`
   * returning ok means a mail window was opened, which is not the same thing at
   * all, so the queue parks those recipients at `awaiting_confirmation` until a
   * human says otherwise. A relay that gets a 202 back can set this true and the
   * queue will mark them sent.
   */
  confirmsDelivery: boolean
  /** False when this transport cannot run here (no relay configured, no mail client). */
  available(): boolean
  send(message: OutgoingMessage): Promise<SendResult>
}
