import { describe, it, expect } from 'vitest'
import {
  confirmRecipient,
  messagesForDraft,
  queueProgress,
  runSendQueue,
  settledStatus,
  skipRecipient,
} from '../src/drafts/queue'
import { bodyFitsInUrl, createMailtoTransport, mailtoUrl } from '../src/drafts/transports/mailto'
import type { OutgoingMessage, SendResult, Transport } from '../src/drafts/transport'
import type { DraftDoc, DraftRecipient, RecipientStatus } from '../src/drafts/types'

const AT = '2026-08-26T21:00:00.000Z'

function recipient(email: string, status: RecipientStatus = 'pending'): DraftRecipient {
  return { email, name: null, status, at: null, error: null }
}

function draft(partial: Partial<DraftDoc> = {}): DraftDoc {
  return {
    id: 'participant_email::p-1::2026-08-26::r1',
    kind: 'participant_email',
    subjectKey: 'p-1',
    workshopId: 'w-1',
    title: 'Amos',
    subject: 'Your evaluation notes',
    dateLabel: '2026-08-26',
    revision: 1,
    supersedes: null,
    fanout: 'per-recipient',
    recipients: [recipient('a@x.org'), recipient('b@x.org')],
    segments: [],
    overrides: [],
    orphans: [],
    flags: [],
    status: 'approved',
    gateOverride: false,
    gateOverrideReason: null,
    generatedAt: AT,
    updatedAt: AT,
    approvedBy: 'josh@sil.org',
    approvedAt: AT,
    approvedSnapshot: { at: AT, by: 'josh@sil.org', markdown: 'Hi Amos,\n\nWell done.', evidence: [], gateOverrideReason: null },
    ...partial,
  }
}

/** A transport that records what it was asked to send, and can be made to fail. */
function fakeTransport(opts: { confirms?: boolean; failOn?: string[]; throwOn?: string[] } = {}) {
  const sent: OutgoingMessage[] = []
  const transport: Transport = {
    id: 'fake',
    label: 'Fake',
    confirmsDelivery: opts.confirms ?? true,
    available: () => true,
    async send(m): Promise<SendResult> {
      sent.push(m)
      if (opts.throwOn?.some((t) => m.to.includes(t))) throw new Error('network exploded')
      if (opts.failOn?.some((t) => m.to.includes(t))) return { ok: false, error: 'bounced' }
      return { ok: true }
    },
  }
  return { transport, sent }
}

/** Records the recipient states at every save, so the interleaving is visible. */
function recorder() {
  const saves: RecipientStatus[][] = []
  return {
    saves,
    save: async (d: DraftDoc) => {
      saves.push(d.recipients.map((r) => r.status))
    },
  }
}

const now = () => AT

describe('messagesForDraft', () => {
  it('produces one message per recipient for a participant email', () => {
    const msgs = messagesForDraft(draft())
    expect(msgs).toHaveLength(2)
    expect(msgs.map((m) => m.to)).toEqual([['a@x.org'], ['b@x.org']])
  })

  it('produces ONE message to everybody for an event digest', () => {
    // The whole reason fanout exists. Getting this wrong the other way would put
    // every participant's private evaluation on one email.
    const msgs = messagesForDraft(draft({ fanout: 'single' }))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to).toEqual(['a@x.org', 'b@x.org'])
  })

  it('sends the approved snapshot, not a fresh render', () => {
    expect(messagesForDraft(draft())[0].body).toBe('Hi Amos,\n\nWell done.')
  })

  it('refuses to send an unapproved draft', () => {
    expect(() => messagesForDraft(draft({ status: 'draft', approvedSnapshot: null }))).toThrow(
      /has not been approved/,
    )
  })

  it('skips a recipient with no address rather than emailing the empty string', () => {
    const msgs = messagesForDraft(draft({ recipients: [recipient(''), recipient('b@x.org')] }))
    expect(msgs.map((m) => m.to)).toEqual([['b@x.org']])
  })

  it('produces nothing when nobody is addressable', () => {
    expect(messagesForDraft(draft({ recipients: [recipient('')] }))).toEqual([])
  })
})

describe('runSendQueue', () => {
  it('writes each recipient status BEFORE starting the next send', async () => {
    // The entire resume story. Asserted on the interleaving, not on the end
    // state, because the end state is identical either way.
    const { transport } = fakeTransport()
    const rec = recorder()
    await runSendQueue(draft(), { transport, save: rec.save, now })

    expect(rec.saves).toEqual([
      ['pending', 'pending'], // status -> sending
      ['sent', 'pending'], // after a@x.org, before b@x.org
      ['sent', 'sent'],
      ['sent', 'sent'], // final settle
    ])
  })

  it('skips recipients who already went, so a resume does not re-send', async () => {
    const { transport, sent } = fakeTransport()
    const d = draft({ status: 'sending', recipients: [recipient('a@x.org', 'sent'), recipient('b@x.org')] })
    const r = await runSendQueue(d, { transport, save: async () => {}, now })

    expect(sent.map((m) => m.to)).toEqual([['b@x.org']])
    expect(r.attempted).toBe(1)
    expect(r.skipped).toBe(1)
  })

  it('parks at awaiting_confirmation on a transport that cannot confirm delivery', async () => {
    // Opening a compose window is not delivery, and the audit record must not
    // claim otherwise.
    const { transport } = fakeTransport({ confirms: false })
    const r = await runSendQueue(draft(), { transport, save: async () => {}, now })
    expect(r.draft.recipients.map((x) => x.status)).toEqual([
      'awaiting_confirmation',
      'awaiting_confirmation',
    ])
    expect(r.draft.status).toBe('sending')
  })

  it('marks only the failure and keeps going', async () => {
    const { transport } = fakeTransport({ failOn: ['a@x.org'] })
    const r = await runSendQueue(draft(), { transport, save: async () => {}, now })
    expect(r.draft.recipients.map((x) => x.status)).toEqual(['failed', 'sent'])
    expect(r.draft.recipients[0].error).toBe('bounced')
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
  })

  it('catches a transport that throws rather than losing the run', async () => {
    const { transport } = fakeTransport({ throwOn: ['a@x.org'] })
    const r = await runSendQueue(draft(), { transport, save: async () => {}, now })
    expect(r.draft.recipients[0].status).toBe('failed')
    expect(r.draft.recipients[0].error).toBe('network exploded')
    expect(r.draft.recipients[1].status).toBe('sent')
  })

  it('retries only the failures', async () => {
    const { transport, sent } = fakeTransport()
    const d = draft({
      status: 'sending',
      recipients: [recipient('a@x.org', 'failed'), recipient('b@x.org', 'sent')],
    })
    await runSendQueue(d, { transport, save: async () => {}, now, retryFailedOnly: true })
    expect(sent.map((m) => m.to)).toEqual([['a@x.org']])
  })

  it('stops mid-run when asked, leaving the rest pending', async () => {
    const { transport, sent } = fakeTransport()
    let calls = 0
    const r = await runSendQueue(draft(), {
      transport,
      save: async () => {},
      now,
      shouldStop: () => ++calls > 1,
    })
    expect(sent).toHaveLength(1)
    expect(r.stopped).toBe(true)
    expect(r.draft.recipients[1].status).toBe('pending')
  })

  it('refuses to send a draft that was never approved', async () => {
    const { transport } = fakeTransport()
    await expect(
      runSendQueue(draft({ status: 'draft' }), { transport, save: async () => {}, now }),
    ).rejects.toThrow(/draft cannot be sent/)
  })

  it('refuses a transport that is not available here', async () => {
    const transport: Transport = { ...fakeTransport().transport, available: () => false }
    await expect(runSendQueue(draft(), { transport, save: async () => {}, now })).rejects.toThrow(
      /not available/,
    )
  })

  it('marks the whole draft sent only when every recipient is resolved', async () => {
    const { transport } = fakeTransport()
    const r = await runSendQueue(draft(), { transport, save: async () => {}, now })
    expect(r.draft.status).toBe('sent')
  })
})

describe('settling', () => {
  it('a confirmation moves one row and can settle the draft', () => {
    const d = draft({
      status: 'sending',
      recipients: [recipient('a@x.org', 'awaiting_confirmation'), recipient('b@x.org', 'sent')],
    })
    const next = confirmRecipient(d, 'a@x.org', AT)
    expect(next.recipients[0].status).toBe('sent')
    expect(next.status).toBe('sent')
  })

  it('a skip counts as resolved', () => {
    const d = draft({
      status: 'sending',
      recipients: [recipient('a@x.org', 'awaiting_confirmation'), recipient('b@x.org', 'sent')],
    })
    expect(skipRecipient(d, 'a@x.org', AT).status).toBe('sent')
  })

  it('confirming a row that is not waiting does nothing', () => {
    const d = draft({ recipients: [recipient('a@x.org', 'pending')] })
    expect(confirmRecipient(d, 'a@x.org', AT).recipients[0].status).toBe('pending')
  })

  it('a draft with nobody addressable never settles as sent', () => {
    expect(settledStatus(draft({ recipients: [recipient('')] }))).toBe('sending')
  })

  it('progress ignores unaddressable rows', () => {
    const p = queueProgress(draft({ recipients: [recipient(''), recipient('b@x.org', 'sent')] }))
    expect(p).toEqual({ total: 1, sent: 1, awaiting: 0, failed: 0, skipped: 0, pending: 0 })
  })
})

describe('the mailto transport', () => {
  it('encodes spaces as %20, which is what mail clients understand', () => {
    const url = mailtoUrl({ to: ['a@x.org'], subject: 'your notes', body: 'hi there' })
    expect(url).toContain('subject=your%20notes')
    expect(url).not.toContain('+')
  })

  it('joins multiple recipients', () => {
    const url = mailtoUrl({ to: ['a@x.org', 'b@x.org'], subject: 's', body: 'b' })
    expect(url.startsWith('mailto:a%40x.org,b%40x.org?')).toBe(true)
  })

  it('drops the body from the URL when it would risk truncation, and copies it instead', async () => {
    const long = { to: ['a@x.org'], subject: 's', body: 'x'.repeat(4000) }
    expect(bodyFitsInUrl(long)).toBe(false)

    const opened: string[] = []
    const copied: string[] = []
    const t = createMailtoTransport({
      open: (u) => opened.push(u),
      copy: async (txt) => {
        copied.push(txt)
      },
    })
    await t.send(long)
    expect(copied).toEqual([long.body])
    expect(opened[0]).not.toContain('body=')
  })

  it('pre-fills a short body', async () => {
    const opened: string[] = []
    const t = createMailtoTransport({ open: (u) => opened.push(u) })
    await t.send({ to: ['a@x.org'], subject: 's', body: 'short' })
    expect(opened[0]).toContain('body=short')
  })

  it('never claims to confirm delivery', () => {
    expect(createMailtoTransport({ open: () => {} }).confirmsDelivery).toBe(false)
  })

  it('reports a failure rather than throwing when opening the mail app fails', async () => {
    const t = createMailtoTransport({
      open: () => {
        throw new Error('no handler')
      },
    })
    expect(await t.send({ to: ['a@x.org'], subject: 's', body: 'b' })).toEqual({
      ok: false,
      error: 'no handler',
    })
  })
})
