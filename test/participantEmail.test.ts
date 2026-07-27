import { describe, it, expect } from 'vitest'
import { buildAllReports } from '../src/reports/build'
import {
  buildParticipantEmailSegments,
  participantEmailSubject,
  renderParticipantEmailMarkdown,
} from '../src/reports/participantEmail'
import { annotateObservations, participantGate } from '../src/reports/verification'
import { ksa, obs, participant, team, verdict } from './factories'
import type { ObservationRecord, VerificationVerdict } from '../src/lib/types'

const ksas = [ksa('GENRE', { area: 'Genre Theory' }), ksa('CHECK', { area: 'Checking' })]
const p = participant({ id: 'p-1', name: 'Amos Khokhar' })
const teams = [team()]

function build(observations: ObservationRecord[] = [], verdicts: VerificationVerdict[] = [], withGate = false) {
  const annotated = annotateObservations(observations, verdicts)
  const report = buildAllReports([p], ksas, annotated, teams)[0]
  const gate = withGate ? participantGate(annotated) : undefined
  return { report, gate, annotated }
}

function md(observations: ObservationRecord[] = [], verdicts: VerificationVerdict[] = [], withGate = false) {
  const { report, gate } = build(observations, verdicts, withGate)
  return renderParticipantEmailMarkdown(report, gate, 'Psalms Workshop', '2026-08-26', { fromName: 'Josh' })
}

describe('addressing', () => {
  it('greets by first name', () => {
    expect(md([obs({ participant_id: 'p-1', evidence_designation: 3 })])).toContain('Hi Amos,')
  })

  it('does not name the evaluator in the evidence', () => {
    const out = md([
      obs({ participant_id: 'p-1', evidence_designation: 3, evaluator_email: 'ruth@sil.org', text: 'named the genre' }),
    ])
    // The quote is what the participant needs. Which colleague wrote it turns
    // feedback into an attribution to argue with, and it stays in the admin pane.
    expect(out).toContain('named the genre')
    expect(out).not.toContain('ruth')
  })

  it('keeps the subject line beside the body', () => {
    expect(participantEmailSubject('Psalms Workshop', '2026-08-26')).toBe(
      'Psalms Workshop: your evaluation notes for 2026-08-26',
    )
  })
})

describe('content', () => {
  it('leads with what went well', () => {
    const out = md([obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 })])
    expect(out).toContain('**What went well**')
    expect(out).toContain('Genre Theory: strong (3/3).')
    expect(out).not.toContain('Where to keep working')
  })

  it('names a growth area and promises the conversation without dressing it up', () => {
    const out = md([obs({ participant_id: 'p-1', ksa_code: 'CHECK', evidence_designation: 1 })])
    expect(out).toContain('**Where to keep working**')
    expect(out).toContain('Checking: emerging (1/3).')
    expect(out).toContain('short conversation')
    expect(out).toContain('not a review')
  })

  it('never tells the participant their evaluators disagreed', () => {
    const out = md([
      obs({ id: 'a', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, evaluator_email: 'a@x.org' }),
      obs({ id: 'b', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1, evaluator_email: 'b@x.org' }),
    ])
    expect(out).not.toMatch(/conflict|reconcil|disagree/i)
  })

  it('caps the highlights', () => {
    const many = ['GENRE', 'CHECK'].map((code, i) =>
      obs({ id: `k-${i}`, participant_id: 'p-1', ksa_code: code, evidence_designation: 3 }),
    )
    const { report, gate } = build(many)
    const segs = buildParticipantEmailSegments(report, gate, 'W', 'D', { maxHighlights: 1 })
    expect(segs.filter((s) => s.id.includes('/hl/k:'))).toHaveLength(2) // one claim + its evidence
  })

  it('says nothing was recorded rather than inventing encouragement', () => {
    const out = md([])
    expect(out).toContain('did not record observations')
    expect(out).toContain('not a judgment about your work')
    expect(out).not.toContain('What went well')
  })
})

describe('the verification caveat', () => {
  it('appears while the gate is not clear', () => {
    expect(md([obs({ participant_id: 'p-1', evidence_designation: 3 })], [], true)).toContain(
      'still being confirmed by a second facilitator',
    )
  })

  it('is absent once the gate is clear', () => {
    const o = obs({ id: 'o-1', participant_id: 'p-1', evidence_designation: 3 })
    const verdicts = [
      verdict({ observation_id: 'o-1', evaluator_email: 'a@x.org' }),
      verdict({ observation_id: 'o-1', evaluator_email: 'b@x.org' }),
    ]
    expect(md([o], verdicts, true)).not.toContain('still being confirmed')
  })

  it('can be forced on, which is how an override says so in the document itself', () => {
    const { report } = build([obs({ participant_id: 'p-1', evidence_designation: 3 })])
    const out = buildParticipantEmailSegments(report, undefined, 'W', 'D', { statePendingVerification: true })
    expect(out.some((s) => s.id.endsWith('/gate'))).toBe(true)
  })
})

describe('provenance', () => {
  it('claims carry their whole counting set and evidence bullets carry one', () => {
    const { report, gate } = build([
      obs({ id: 'a', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
      obs({ id: 'b', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2 }),
    ])
    const segs = buildParticipantEmailSegments(report, gate, 'W', 'D')
    const claim = segs.find((s) => s.id.endsWith('/hl/k:GENRE/claim'))!
    expect(claim.evidence.sort()).toEqual(['a', 'b'])
    expect(claim.note).toContain('highest of 2 counting designations')
    for (const s of segs.filter((x) => x.kind === 'evidence')) expect(s.evidence).toHaveLength(1)
  })

  it('namespaces ids to the participant so two people cannot share a draft id', () => {
    const { report, gate } = build([obs({ participant_id: 'p-1', evidence_designation: 3 })])
    for (const s of buildParticipantEmailSegments(report, gate, 'W', 'D')) {
      expect(s.id.startsWith('v1/pe:p-1/')).toBe(true)
    }
  })
})
