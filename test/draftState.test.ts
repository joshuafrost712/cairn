import { describe, it, expect } from 'vitest'
import {
  approvalBlockers,
  approveDraft,
  canApprove,
  draftId,
  isEditable,
  overrideGate,
  superseding,
  unapproveDraft,
} from '../src/drafts/state'
import type { DraftDoc, DraftRecipient } from '../src/drafts/types'
import type { DocSegment } from '../src/reports/segments'
import type { Gate } from '../src/reports/verification'

const AT = '2026-08-26T21:00:00.000Z'
const LATER = '2026-08-26T22:00:00.000Z'

function seg(id: string, text: string, evidence: string[] = [], gapAfter = false): DocSegment {
  return { id: `v1/${id}`, kind: 'bullet', text, gapAfter, evidence, editable: true }
}

function recipient(partial: Partial<DraftRecipient> = {}): DraftRecipient {
  return { email: 'amos@x.org', name: 'Amos', status: 'pending', at: null, error: null, ...partial }
}

function draft(partial: Partial<DraftDoc> = {}): DraftDoc {
  return {
    id: draftId('participant_email', 'p-1', '2026-08-26', 1),
    kind: 'participant_email',
    subjectKey: 'p-1',
    workshopId: 'w-1',
    title: 'Amos Khokhar',
    subject: 'Your evaluation notes',
    dateLabel: '2026-08-26',
    revision: 1,
    supersedes: null,
    fanout: 'per-recipient',
    recipients: [recipient()],
    segments: [seg('a', 'Hi Amos,', [], true), seg('b', 'Genre Theory: strong (3/3).', ['o-1'])],
    overrides: [],
    orphans: [],
    flags: [],
    status: 'draft',
    gateOverride: false,
    gateOverrideReason: null,
    generatedAt: AT,
    updatedAt: AT,
    approvedBy: null,
    approvedAt: null,
    approvedSnapshot: null,
    ...partial,
  }
}

const gate = (partial: Partial<Gate> = {}): Gate => ({
  status: 'locked',
  total: 5,
  verified: 3,
  pending: 2,
  disputed: 0,
  required: 2,
  ...partial,
})

const approveInput = { by: 'josh@sil.org', at: LATER, snapshotEvidence: [] }

describe('the verification gate', () => {
  it('blocks approval while a report is locked', () => {
    const blockers = approvalBlockers(draft(), { gate: gate() })
    expect(blockers[0]).toBe('Not verified: 3 of 5 observations confirmed, 2 pending (needs 2 evaluators each).')
  })

  it('does not block once the gate is ready', () => {
    expect(canApprove(draft(), { gate: gate({ status: 'ready', verified: 5, pending: 0 }) })).toBe(true)
  })

  it('does not block a document that has no gate, like an event digest', () => {
    expect(canApprove(draft({ kind: 'event_digest' }))).toBe(true)
  })

  it('is the one blocker a human may override, and the reason is kept', () => {
    const d = overrideGate(draft(), 'Amos leaves at 6am; sending unverified.', LATER)
    expect(canApprove(d, { gate: gate() })).toBe(true)
    const approved = approveDraft(d, approveInput, { gate: gate() })
    expect(approved.approvedSnapshot!.gateOverrideReason).toBe('Amos leaves at 6am; sending unverified.')
  })

  it('records no override reason when there was no override', () => {
    const approved = approveDraft(draft(), approveInput, { gate: gate({ status: 'ready' }) })
    expect(approved.approvedSnapshot!.gateOverrideReason).toBe(null)
  })
})

describe('other blockers', () => {
  it('will not approve over an unreviewed staleness flag', () => {
    const d = draft({
      flags: [{ segmentId: 'v1/b', kind: 'stale-evidence', addedEvidence: ['o-2'], removedEvidence: [] }],
    })
    expect(approvalBlockers(d)).toEqual([
      '1 edited line has evidence that changed after you edited it.',
    ])
  })

  it('counts the two kinds of staleness separately, because they mean different things', () => {
    const d = draft({
      flags: [
        { segmentId: 'v1/a', kind: 'stale-evidence', addedEvidence: ['o-2'], removedEvidence: [] },
        { segmentId: 'v1/b', kind: 'stale-text', addedEvidence: [], removedEvidence: [] },
        { segmentId: 'v1/c', kind: 'stale-text', addedEvidence: [], removedEvidence: [] },
      ],
    })
    expect(approvalBlockers(d)).toEqual([
      '1 edited line has evidence that changed after you edited it.',
      '2 edited lines were reworded by the generator after you edited them.',
    ])
  })

  it('will not approve while an edit is orphaned', () => {
    const d = draft({
      orphans: [
        { segmentId: 'v1/x', text: 'mine', baseText: 'old', baseEvidenceKey: '', at: AT, by: null, reason: 'segment-gone' },
      ],
    })
    expect(approvalBlockers(d)).toContain('1 edited line no longer exists in the document.')
  })

  it('will not approve a document with nowhere to send it', () => {
    expect(approvalBlockers(draft({ recipients: [recipient({ email: '' })] }))).toContain(
      'No email address on file for this recipient.',
    )
  })

  it('says plainly that an already-approved draft is done, and stops there', () => {
    expect(approvalBlockers(draft({ status: 'approved' }))).toEqual(['This draft is already approved.'])
  })

  it('names a superseded revision as superseded rather than as approved', () => {
    expect(approvalBlockers(draft({ status: 'superseded' }))[0]).toContain('superseded')
  })
})

describe('approveDraft', () => {
  it('freezes the document exactly as edited', () => {
    const d = draft({
      overrides: [
        {
          segmentId: 'v1/b',
          text: 'You read the genre better than anyone in the room.',
          baseText: 'Genre Theory: strong (3/3).',
          baseEvidenceKey: 'o-1',
          at: AT,
          by: 'josh@sil.org',
        },
      ],
    })
    const approved = approveDraft(d, approveInput)
    expect(approved.approvedSnapshot!.markdown).toBe(
      'Hi Amos,\n\nYou read the genre better than anyone in the room.',
    )
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe('josh@sil.org')
  })

  it('throws rather than silently doing nothing, so the UI cannot show a fake approval', () => {
    expect(() => approveDraft(draft(), approveInput, { gate: gate() })).toThrow(/Cannot approve/)
  })

  it('keeps the resolved evidence the caller looked up', () => {
    const evidence = [
      {
        observation_id: 'o-1',
        present: true,
        text: 'named the genre',
        source_excerpt: 'this is a lament',
        evaluator_email: 'ruth@x.org',
        evidence_designation: 3,
        effective_designation: 3,
        vstatus: 'verified',
        verdicts: [],
      },
    ]
    const approved = approveDraft(draft(), { ...approveInput, snapshotEvidence: evidence })
    expect(approved.approvedSnapshot!.evidence).toEqual(evidence)
  })
})

describe('reopening', () => {
  it('is allowed while nothing has gone out', () => {
    const approved = approveDraft(draft(), approveInput)
    const reopened = unapproveDraft(approved, LATER)
    expect(reopened.status).toBe('draft')
    expect(reopened.approvedSnapshot).toBe(null)
  })

  it('is refused once a recipient has it, because that document is now a fact', () => {
    const approved = approveDraft(draft(), approveInput)
    const sent = { ...approved, recipients: [recipient({ status: 'sent' })] }
    expect(() => unapproveDraft(sent, LATER)).toThrow(/already gone/)
  })

  it('is refused on something that was never approved', () => {
    expect(() => unapproveDraft(draft(), LATER)).toThrow(/Only an approved draft/)
  })
})

describe('superseding', () => {
  const merged = {
    segments: [seg('a', 'Hi Amos,', [], true), seg('b', 'Genre Theory: strong (3/3).', ['o-1', 'o-2'])],
    overrides: [],
    orphans: [],
    flags: [],
  }

  it('leaves the approved artifact alone and starts a new revision', () => {
    const approved = approveDraft(draft(), approveInput)
    const next = superseding(approved, merged, LATER)
    expect(next.revision).toBe(2)
    expect(next.supersedes).toBe(approved.id)
    expect(next.id).not.toBe(approved.id)
    expect(next.status).toBe('draft')
    expect(next.approvedSnapshot).toBe(null)
    // The approved row is untouched by this function; the caller marks it.
    expect(approved.status).toBe('approved')
    expect(approved.approvedSnapshot).not.toBe(null)
  })

  it('resets recipients, because they received a different document', () => {
    const approved = { ...approveDraft(draft(), approveInput), recipients: [recipient({ status: 'sent', at: LATER })] }
    const next = superseding(approved, merged, LATER)
    expect(next.recipients.map((r) => r.status)).toEqual(['pending'])
    expect(next.recipients[0].at).toBe(null)
  })

  it('does not carry the gate override forward: that judgment gets made again', () => {
    const overridden = overrideGate(draft(), 'leaving early', AT)
    const approved = approveDraft(overridden, approveInput, { gate: gate() })
    const next = superseding(approved, merged, LATER)
    expect(next.gateOverride).toBe(false)
    expect(next.gateOverrideReason).toBe(null)
  })
})

describe('editability', () => {
  it('is only true in draft', () => {
    expect(isEditable('draft')).toBe(true)
    for (const s of ['approved', 'sending', 'sent', 'superseded'] as const) {
      expect(isEditable(s)).toBe(false)
    }
  })
})
