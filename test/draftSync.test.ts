import { describe, expect, it } from 'vitest'
import { mergeRemoteDraft, statusRank } from '../src/drafts/remoteMerge'
import { describeSync, fromRow } from '../src/db/draftSync'
import type { DraftDoc, DraftStatus } from '../src/drafts/types'

function draft(over: Partial<DraftDoc> = {}): DraftDoc {
  return {
    id: 'participant_email::p1::2026-08-26::r1',
    kind: 'participant_email',
    subjectKey: 'p1',
    workshopId: 'w1',
    title: 'Amos Khokhar',
    subject: 'Psalms Workshop — 26 August',
    dateLabel: '2026-08-26',
    revision: 1,
    supersedes: null,
    fanout: 'per-recipient',
    recipients: [{ email: 'amos@x.org', name: 'Amos', status: 'pending', at: null, error: null }],
    segments: [],
    overrides: [],
    orphans: [],
    flags: [],
    status: 'draft',
    gateOverride: false,
    gateOverrideReason: null,
    generatedAt: '2026-08-26T18:00:00.000Z',
    updatedAt: '2026-08-26T18:00:00.000Z',
    approvedBy: null,
    approvedAt: null,
    approvedSnapshot: null,
    ...over,
  }
}

describe('statusRank', () => {
  it('orders the lifecycle by what must never be undone', () => {
    const order: DraftStatus[] = ['draft', 'approved', 'superseded', 'sending', 'sent']
    const ranks = order.map(statusRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(order.length)
  })

  it('puts a send above being superseded', () => {
    // A document that actually reached somebody must never be relabelled as
    // replaced: the send is the stronger fact and it cannot be taken back.
    expect(statusRank('sent')).toBeGreaterThan(statusRank('superseded'))
    expect(statusRank('sending')).toBeGreaterThan(statusRank('superseded'))
  })
})

describe('mergeRemoteDraft', () => {
  it('never lets a remote draft regress a local send, however new it claims to be', () => {
    // The rule the whole module exists for. A device offline since this morning
    // must not overwrite tonight's send with its stale copy, which would put a
    // lie in the audit trail.
    const local = draft({ status: 'sent', updatedAt: '2026-08-26T19:00:00.000Z' })
    const remote = draft({ status: 'draft', updatedAt: '2026-08-27T09:00:00.000Z' })
    const out = mergeRemoteDraft(local, remote)
    expect(out.winner).toBe('local')
    expect(out.draft.status).toBe('sent')
  })

  it('adopts a remote copy that is further along', () => {
    const local = draft({ status: 'draft', updatedAt: '2026-08-26T21:00:00.000Z' })
    const remote = draft({
      status: 'sent',
      updatedAt: '2026-08-26T19:00:00.000Z',
      approvedBy: 'chief@sil.org',
    })
    const out = mergeRemoteDraft(local, remote)
    expect(out.winner).toBe('remote')
    expect(out.advanced).toBe(true)
    expect(out.draft.approvedBy).toBe('chief@sil.org')
  })

  it('falls back to the newer timestamp at equal status', () => {
    const local = draft({ status: 'draft', updatedAt: '2026-08-26T18:00:00.000Z' })
    const remote = draft({ status: 'draft', updatedAt: '2026-08-26T20:00:00.000Z' })
    expect(mergeRemoteDraft(local, remote).winner).toBe('remote')
  })

  it('keeps local when local is newer at equal status', () => {
    const local = draft({ status: 'approved', updatedAt: '2026-08-26T22:00:00.000Z' })
    const remote = draft({ status: 'approved', updatedAt: '2026-08-26T20:00:00.000Z' })
    expect(mergeRemoteDraft(local, remote).winner).toBe('local')
  })

  it('breaks an exact tie toward local, so a sync does not flicker', () => {
    const at = '2026-08-26T20:00:00.000Z'
    expect(mergeRemoteDraft(draft({ updatedAt: at }), draft({ updatedAt: at })).winner).toBe('local')
  })

  it('carries awaiting_confirmation across unchanged rather than rounding it to sent', () => {
    // That state exists because the mailto transport cannot know whether the
    // message was really sent. A sync that "tidied" it would invent a fact.
    const remote = draft({
      status: 'sending',
      updatedAt: '2026-08-26T20:00:00.000Z',
      recipients: [
        { email: 'a@x.org', name: null, status: 'awaiting_confirmation', at: '2026-08-26T20:00:00.000Z', error: null },
      ],
    })
    const out = mergeRemoteDraft(draft(), remote)
    expect(out.winner).toBe('remote')
    expect(out.draft.recipients[0].status).toBe('awaiting_confirmation')
  })

  it('prefers a superseding revision over an unapproved local draft', () => {
    const local = draft({ status: 'draft', updatedAt: '2026-08-26T18:00:00.000Z' })
    const remote = draft({ status: 'superseded', updatedAt: '2026-08-26T17:00:00.000Z' })
    expect(mergeRemoteDraft(local, remote).winner).toBe('remote')
  })
})

describe('fromRow', () => {
  const row = {
    id: 'd1',
    workshop_id: 'w1',
    kind: 'participant_email',
    subject_key: 'p1',
    title: 'T',
    subject: 'S',
    date_label: '2026-08-26',
    revision: 2,
    supersedes: 'd0',
    fanout: 'per-recipient',
    status: 'approved',
    recipients: [],
    segments: [],
    overrides: [],
    orphans: [],
    flags: [],
    gate_override: false,
    gate_override_reason: null,
    generated_at: '2026-08-26T18:00:00.000Z',
    updated_at: '2026-08-26T19:00:00.000Z',
    approved_by: 'chief@sil.org',
    approved_at: '2026-08-26T19:00:00.000Z',
    approved_snapshot: null,
  }

  it('maps the snake_case row onto the camelCase draft', () => {
    const d = fromRow(row)
    expect(d.subjectKey).toBe('p1')
    expect(d.dateLabel).toBe('2026-08-26')
    expect(d.gateOverride).toBe(false)
    expect(d.approvedBy).toBe('chief@sil.org')
  })

  it('reads an unknown status as the LEAST advanced value', () => {
    // So a row written by a newer build can never win a merge against a local
    // copy this build actually understands.
    expect(fromRow({ ...row, status: 'quantum' }).status).toBe('draft')
    expect(statusRank(fromRow({ ...row, status: 'quantum' }).status)).toBe(0)
  })

  it('tolerates a jsonb array arriving as something else', () => {
    const d = fromRow({ ...row, recipients: null, segments: 'oops' })
    expect(d.recipients).toEqual([])
    expect(d.segments).toEqual([])
  })
})

describe('describeSync', () => {
  it('says nothing happened rather than reporting a silent success', () => {
    expect(describeSync({ pushed: 0, pulled: 0, refused: 0, unscoped: 0, error: null })).toBe(
      'Already up to date.',
    )
  })

  it('names unshareable drafts rather than omitting them', () => {
    // A draft with no workshop is invisible under RLS. Saying "1 shared" while
    // one stayed behind is exactly the false reassurance this view exists to
    // avoid.
    const msg = describeSync({ pushed: 1, pulled: 0, refused: 0, unscoped: 1, error: null })
    expect(msg).toContain('1 shared')
    expect(msg).toContain('not shareable')
  })

  it('reports an error instead of a count', () => {
    expect(describeSync({ pushed: 0, pulled: 0, refused: 0, unscoped: 0, error: 'nope' })).toBe('nope')
  })
})
