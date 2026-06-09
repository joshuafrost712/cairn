import { describe, it, expect } from 'vitest'
import { buildParticipantReport, unattributedObservations } from '../src/reports/build'
import { composeSourceText } from '../src/lib/compose'
import { ksa, obs, participant, team } from './factories'

const ksas = [ksa('GENRE', { cbc_subpoint_refs: ['Guiding Teams'] }), ksa('CHECK', { cbc_subpoint_refs: ['Consulting'] })]
const p = participant({ id: 'p-1', name: 'CIT One' })
const teams = [team({ id: 't-1', name: 'Team A' })]

describe('buildParticipantReport (draft view)', () => {
  it('takes the max of counting designations and lists evidence', () => {
    const observations = [
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 }),
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
    ]
    const r = buildParticipantReport(p, ksas, observations, teams)
    const genre = r.ksaRollups.find((k) => k.ksa_code === 'GENRE')!
    expect(genre.representative).toBe(3)
    expect(genre.contributing).toHaveLength(2)
    expect(r.totals.evidencedKsas).toBe(1)
  })

  it('excludes needs_review observations from the draft count', () => {
    const observations = [obs({ ksa_code: 'CHECK', evidence_designation: 3, needs_review: true })]
    const r = buildParticipantReport(p, ksas, observations, teams)
    const check = r.ksaRollups.find((k) => k.ksa_code === 'CHECK')!
    expect(check.representative).toBeNull()
    expect(check.toVerify).toHaveLength(1)
  })

  it('flags a conflict when designations spread by 2 or more', () => {
    const observations = [
      obs({ ksa_code: 'GENRE', evidence_designation: 1 }),
      obs({ ksa_code: 'GENRE', evidence_designation: 3 }),
    ]
    const r = buildParticipantReport(p, ksas, observations, teams)
    expect(r.ksaRollups.find((k) => k.ksa_code === 'GENRE')!.conflict).toBe(true)
  })

  it('does not flag a conflict for a spread of 1', () => {
    const observations = [
      obs({ ksa_code: 'GENRE', evidence_designation: 2 }),
      obs({ ksa_code: 'GENRE', evidence_designation: 3 }),
    ]
    const r = buildParticipantReport(p, ksas, observations, teams)
    expect(r.ksaRollups.find((k) => k.ksa_code === 'GENRE')!.conflict).toBe(false)
  })

  it('groups designations under each referenced CBC sub-point', () => {
    const observations = [obs({ ksa_code: 'GENRE', evidence_designation: 2 })]
    const r = buildParticipantReport(p, ksas, observations, teams)
    const sub = r.cbc.find((c) => c.subpoint === 'Guiding Teams')!
    expect(sub.entries[0]).toMatchObject({ ksa_code: 'GENRE', representative: 2 })
  })
})

describe('unattributedObservations', () => {
  it('returns only observations with a null participant_id', () => {
    const list = [obs({ participant_id: 'p-1' }), obs({ participant_id: null })]
    expect(unattributedObservations(list)).toHaveLength(1)
  })
})

describe('composeSourceText', () => {
  it('labels answered KSAs and skips empty answers', () => {
    const k = ksa('GENRE', { id: 'k1', evaluator_facing_prompt: 'genre?' })
    const text = composeSourceText({ k1: 'they mapped well', k2: '   ' }, [k])
    expect(text).toContain('[GENRE] genre?')
    expect(text).toContain('they mapped well')
    expect(text).not.toContain('k2')
  })
})
