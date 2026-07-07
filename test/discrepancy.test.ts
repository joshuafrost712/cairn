import { describe, it, expect } from 'vitest'
import { buildAllReports } from '../src/reports/build'
import { annotateObservations } from '../src/reports/verification'
import { findDiscrepancies, buildCaptureTimeMap, discrepancyId } from '../src/reports/discrepancy'
import { renderDiscrepancyEmails } from '../src/reports/discrepancyEmail'
import { ksa, obs, participant, team } from './factories'
import type { EvaluationRecord } from '../src/lib/types'

const ksas = [ksa('GENRE', { area: 'Genre Theory' }), ksa('CHECK', { area: 'Checking' })]
const p = participant({ id: 'p-1', name: 'CIT One' })
const teams = [team({ id: 't-1', name: 'Team A' })]

function evalRecord(clientId: string, createdAt: string): EvaluationRecord {
  return {
    client_id: clientId,
    evaluator_email: null,
    activity_id: null,
    workshop_id: null,
    source_language: 'eng',
    answers: {},
    source_text: '',
    participant_scope: [],
    attestation: true,
    ruleset_version: null,
    edit_history: [],
    created_at: createdAt,
    updated_at: createdAt,
    sync_status: 'local',
  }
}

function buildDiscrepancies(observations: ReturnType<typeof obs>[], evaluations: EvaluationRecord[] = []) {
  const annotated = annotateObservations(observations, [])
  const reports = buildAllReports([p], ksas, annotated, teams)
  const captureTimes = buildCaptureTimeMap(evaluations)
  return { discrepancies: findDiscrepancies(reports, captureTimes), annotated, reports }
}

describe('findDiscrepancies', () => {
  it('detects a discrepancy when two scores spread by 2 or more', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1, evaluator_email: 'low@sil.org', capture_client_id: 'cap-1' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, evaluator_email: 'high@sil.org', capture_client_id: 'cap-2' }),
    ]
    const { discrepancies } = buildDiscrepancies(observations)
    expect(discrepancies).toHaveLength(1)
    const d = discrepancies[0]
    expect(d.participant_id).toBe('p-1')
    expect(d.ksa_code).toBe('GENRE')
    expect(d.lo).toBe(1)
    expect(d.hi).toBe(3)
    expect(d.observations).toHaveLength(2)
  })

  it('does NOT detect a discrepancy for a spread of exactly 1', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2, capture_client_id: 'cap-1' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, capture_client_id: 'cap-2' }),
    ]
    const { discrepancies } = buildDiscrepancies(observations)
    expect(discrepancies).toHaveLength(0)
  })

  it('does NOT detect a discrepancy when both evaluators agree', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2, capture_client_id: 'cap-1' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2, capture_client_id: 'cap-2' }),
    ]
    const { discrepancies } = buildDiscrepancies(observations)
    expect(discrepancies).toHaveLength(0)
  })

  it('does NOT fire on a single observation (no one to conflict with)', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0, capture_client_id: 'cap-1' }),
    ]
    const { discrepancies } = buildDiscrepancies(observations)
    expect(discrepancies).toHaveLength(0)
  })

  it('emits a timeGapNote when captures are 4+ hours apart', () => {
    const t1 = '2026-06-09T08:00:00.000Z'
    const t2 = '2026-06-09T13:00:00.000Z' // 5 hours later
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0, capture_client_id: 'cap-early' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, capture_client_id: 'cap-late' }),
    ]
    const evaluations = [evalRecord('cap-early', t1), evalRecord('cap-late', t2)]
    const { discrepancies } = buildDiscrepancies(observations, evaluations)
    expect(discrepancies).toHaveLength(1)
    expect(discrepancies[0].timeGapNote).not.toBeNull()
    expect(discrepancies[0].timeGapNote).toMatch(/hours? apart/)
    expect(discrepancies[0].timeGapMs).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000)
  })

  it('does NOT emit a timeGapNote when captures are close together', () => {
    const t1 = '2026-06-09T09:00:00.000Z'
    const t2 = '2026-06-09T09:30:00.000Z' // 30 minutes later
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0, capture_client_id: 'cap-a' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, capture_client_id: 'cap-b' }),
    ]
    const evaluations = [evalRecord('cap-a', t1), evalRecord('cap-b', t2)]
    const { discrepancies } = buildDiscrepancies(observations, evaluations)
    expect(discrepancies).toHaveLength(1)
    expect(discrepancies[0].timeGapNote).toBeNull()
  })

  it('returns null timeGapMs when fewer than 2 timestamps are known', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0, capture_client_id: 'cap-x' }),
      obs({ id: 'o2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, capture_client_id: 'cap-y' }),
    ]
    // Only one evaluation record available
    const evaluations = [evalRecord('cap-x', '2026-06-09T09:00:00.000Z')]
    const { discrepancies } = buildDiscrepancies(observations, evaluations)
    expect(discrepancies[0].timeGapMs).toBeNull()
    expect(discrepancies[0].timeGapNote).toBeNull()
  })
})

describe('discrepancyId', () => {
  it('produces a deterministic key', () => {
    expect(discrepancyId('p-1', 'GENRE')).toBe('disc::p-1::GENRE')
  })
})

describe('renderDiscrepancyEmails', () => {
  const loObs = obs({
    id: 'o1',
    participant_id: 'p-1',
    ksa_code: 'GENRE',
    evidence_designation: 1,
    evaluator_email: 'low@sil.org',
    capture_client_id: 'cap-1',
    text: 'did not demonstrate genre mapping',
    source_excerpt: 'they struggled',
  })
  const hiObs = obs({
    id: 'o2',
    participant_id: 'p-1',
    ksa_code: 'GENRE',
    evidence_designation: 3,
    evaluator_email: 'high@sil.org',
    capture_client_id: 'cap-2',
    text: 'showed strong genre understanding',
    source_excerpt: 'excellent work',
  })

  function buildDisc() {
    const observations = [loObs, hiObs]
    const { discrepancies } = buildDiscrepancies(observations)
    return discrepancies[0]
  }

  it('produces exactly 3 drafts', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const drafts = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(drafts).toHaveLength(3)
  })

  it('addresses the chief email to the chief', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const [chief] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(chief.to).toBe('chief@sil.org')
  })

  it('addresses evaluator drafts to the low and high scorers', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const [, evalA, evalB] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(evalA.to).toBe('low@sil.org')
    expect(evalB.to).toBe('high@sil.org')
  })

  it('includes the score range in the chief email body', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const [chief] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(chief.body).toContain('1/3 to 3/3')
    expect(chief.body).toContain('Genre Theory')
    expect(chief.body).toContain('GENRE')
    expect(chief.body).toContain('CIT One')
  })

  it('includes excerpts in the evaluator emails', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const [, evalA, evalB] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(evalA.body).toContain('they struggled')
    expect(evalA.body).toContain('excellent work')
    expect(evalB.body).toContain('excellent work')
    expect(evalB.body).toContain('they struggled')
  })

  it('includes the time-gap note in all three emails when present', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = {
      ...d,
      observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1'),
      timeGapNote: 'Observations were captured 5 hours apart; they may reflect different moments in the activity.',
    }
    const [chief, evalA, evalB] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(chief.body).toContain('5 hours apart')
    expect(evalA.body).toContain('5 hours apart')
    expect(evalB.body).toContain('5 hours apart')
  })

  it('degrades gracefully when an evaluator email is missing', () => {
    const loNoEmail = { ...loObs, evaluator_email: null }
    const observations = [loNoEmail, hiObs]
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports([p], ksas, annotated, teams)
    const discrepancies = findDiscrepancies(reports, new Map())
    expect(discrepancies).toHaveLength(1)
    const disc = discrepancies[0]
    const drafts = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    // Second draft has an empty "to" but is still produced
    expect(drafts).toHaveLength(3)
    expect(drafts[1].to).toBe('')
    expect(drafts[1].body).toBeTruthy()
  })

  it('uses a shared subject line across all three drafts', () => {
    const d = buildDisc()
    const annotated = annotateObservations([loObs, hiObs], [])
    const disc = { ...d, observations: annotated.filter((o) => o.ksa_code === 'GENRE' && o.participant_id === 'p-1') }
    const [chief, evalA, evalB] = renderDiscrepancyEmails(disc, 'chief@sil.org', 'Psalms Workshop')
    expect(chief.subject).toBe(evalA.subject)
    expect(evalA.subject).toBe(evalB.subject)
    expect(chief.subject).toContain('CIT One')
    expect(chief.subject).toContain('GENRE')
  })
})
