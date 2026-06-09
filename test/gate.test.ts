import { describe, it, expect } from 'vitest'
import { observationStatus, annotateObservations, participantGate, getRequiredConfirmations } from '../src/reports/verification'
import { buildParticipantReport } from '../src/reports/build'
import { obs, verdict, ksa, participant, team } from './factories'

// Tests assume the default threshold (2). Guard so they remain meaningful.
describe('getRequiredConfirmations', () => {
  it('defaults to 2 in tests', () => expect(getRequiredConfirmations()).toBe(2))
})

describe('observationStatus', () => {
  const o = obs({ id: 'o1', evidence_designation: 2 })

  it('is pending below the threshold', () => {
    const s = observationStatus(o, [verdict({ observation_id: 'o1', evaluator_email: 'a' })])
    expect(s.status).toBe('pending')
  })

  it('is verified when N evaluators confirm', () => {
    const s = observationStatus(o, [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b' }),
    ])
    expect(s.status).toBe('verified')
    expect(s.effective_designation).toBe(2)
  })

  it('is adjusted when N evaluators agree on a different value', () => {
    const s = observationStatus(o, [
      verdict({ observation_id: 'o1', evaluator_email: 'a', decision: 'adjust', adjusted_designation: 1 }),
      verdict({ observation_id: 'o1', evaluator_email: 'b', decision: 'adjust', adjusted_designation: 1 }),
    ])
    expect(s.status).toBe('adjusted')
    expect(s.effective_designation).toBe(1)
  })

  it('is disputed on any reject', () => {
    const s = observationStatus(o, [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b', decision: 'reject' }),
    ])
    expect(s.status).toBe('disputed')
  })

  it('is disputed when confirmers disagree on the value', () => {
    const s = observationStatus(o, [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }), // confirm at 2
      verdict({ observation_id: 'o1', evaluator_email: 'b', decision: 'adjust', adjusted_designation: 1 }),
    ])
    expect(s.status).toBe('disputed')
  })
})

describe('participantGate', () => {
  it('is locked until every observation is verified/adjusted', () => {
    const annotated = annotateObservations([obs({ id: 'o1' }), obs({ id: 'o2' })], [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b' }),
    ])
    const g = participantGate(annotated)
    expect(g.status).toBe('locked')
    expect(g.verified).toBe(1)
    expect(g.pending).toBe(1)
  })

  it('is ready when all observations are verified', () => {
    const annotated = annotateObservations([obs({ id: 'o1' })], [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b' }),
    ])
    expect(participantGate(annotated).status).toBe('ready')
  })

  it('is locked while anything is disputed', () => {
    const annotated = annotateObservations([obs({ id: 'o1' })], [
      verdict({ observation_id: 'o1', evaluator_email: 'a', decision: 'reject' }),
    ])
    expect(participantGate(annotated).status).toBe('locked')
    expect(participantGate(annotated).disputed).toBe(1)
  })
})

describe('rollup is verification-aware when annotated', () => {
  const ksas = [ksa('AESTH'), ksa('GENRE')]
  const p = participant({ id: 'p-1' })
  const teams = [team()]

  it('counts a verified/adjusted item even if routing flagged it', () => {
    const flagged = obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'AESTH', evidence_designation: 2, needs_review: true })
    const annotated = annotateObservations([flagged], [
      verdict({ observation_id: 'o1', evaluator_email: 'a', decision: 'adjust', adjusted_designation: 1 }),
      verdict({ observation_id: 'o1', evaluator_email: 'b', decision: 'adjust', adjusted_designation: 1 }),
    ])
    const r = buildParticipantReport(p, ksas, annotated, teams)
    const aesth = r.ksaRollups.find((k) => k.ksa_code === 'AESTH')!
    expect(aesth.representative).toBe(1) // adjusted value counts
    expect(aesth.toVerify).toHaveLength(0)
  })

  it('drops a disputed item from the count', () => {
    const o = obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, needs_review: false })
    const annotated = annotateObservations([o], [
      verdict({ observation_id: 'o1', evaluator_email: 'a', decision: 'reject' }),
    ])
    const r = buildParticipantReport(p, ksas, annotated, teams)
    const genre = r.ksaRollups.find((k) => k.ksa_code === 'GENRE')!
    expect(genre.representative).toBeNull()
    expect(genre.toVerify).toHaveLength(1)
  })
})
