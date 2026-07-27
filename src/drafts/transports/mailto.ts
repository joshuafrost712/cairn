// Send by handing the message to the operating system's mail client.
//
// Why this rather than a relay, stated plainly, because it looks like the lazy
// choice and is not:
//
// The correct fix for a Gmail bulk-sending concern is not sending slower, it is
// sending from an authenticated domain, and that is an SIL DNS and IT dependency
// on somebody else's timeline. Meanwhile twenty-six one-to-one emails with
// genuinely different bodies from Joshua's own warmed account is LESS bulk-like
// than a burst from a brand-new unwarmed relay domain. Bali is in August.
//
// Everything hard about sending is in queue.ts and is transport-independent, so
// a RelayTransport (a Supabase edge function calling Resend) drops in later
// without touching the queue, the audit record, or this file's callers.

import type { OutgoingMessage, SendResult, Transport } from '../transport'

/**
 * Some mail clients and some browsers truncate a long mailto URL, and the limit
 * varies by platform in ways that cannot be feature-detected. Past this length
 * the walkthrough leans on the clipboard copy instead of pre-filling the body,
 * so a truncated email cannot be sent without the sender noticing.
 */
export const MAILTO_BODY_LIMIT = 1800

export function mailtoUrl(message: OutgoingMessage, includeBody = true): string {
  const to = message.to.map((t) => encodeURIComponent(t)).join(',')
  const params = new URLSearchParams()
  params.set('subject', message.subject)
  if (includeBody) params.set('body', message.body)
  // URLSearchParams encodes spaces as '+', which mail clients render literally
  // in a subject line. %20 is what they all understand.
  return `mailto:${to}?${params.toString().replace(/\+/g, '%20')}`
}

export function bodyFitsInUrl(message: OutgoingMessage): boolean {
  return mailtoUrl(message).length <= MAILTO_BODY_LIMIT
}

export interface MailtoDeps {
  /** Injected so a test does not need a window. */
  open: (url: string) => void
  copy?: (text: string) => Promise<void>
}

export function createMailtoTransport(deps: MailtoDeps): Transport {
  return {
    id: 'mailto',
    label: 'Your mail app',
    // The load-bearing false. Opening a compose window is not delivery, and the
    // queue must not write "sent" into an audit record on the strength of it.
    confirmsDelivery: false,
    available: () => true,
    async send(message: OutgoingMessage): Promise<SendResult> {
      try {
        const withBody = bodyFitsInUrl(message)
        if (!withBody && deps.copy) {
          // Body on the clipboard, compose window empty: better than a silently
          // truncated email that looks complete in the sent folder.
          await deps.copy(message.body)
        }
        deps.open(mailtoUrl(message, withBody))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/** The browser-backed instance the app actually uses. */
export const browserMailtoTransport = createMailtoTransport({
  open: (url) => {
    window.location.href = url
  },
  copy: async (text) => {
    await navigator.clipboard.writeText(text)
  },
})
