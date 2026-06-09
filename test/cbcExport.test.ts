import { describe, it, expect } from 'vitest'
import { buildParticipantReport } from '../src/reports/build'
import { annotateObservations, participantGate } from '../src/reports/verification'
import { buildCbcExport, cbcKsaCsv } from '../src/reports/cbcExport'
import { ksa, obs, participant, team, verdict } from './factories'

const ksas = [ksa('GENRE', { cbc_subpoint_refs: ['Guiding Teams', 'Modes'] }), ksa('CHECK', { cbc_subpoint_refs: ['Consulting'] })]
const p = participant({ id: 'p-1', name: 'CIT One' })
const teams = [team({ id: 't-1', name: 'Team A' })]

function exportFor(annotated: ReturnType<typeof annotateObservations>, onlyFinalized: boolean) {
  const reports = buildParticipantReport(p, ksas, annotated, teams)
  const gateOf = () => participantGate(annotated.filter((o) => o.participant_id === 'p-1'))
  return buildCbcExport([reports], gateOf, {
    workshop: { id: 'w-1', name: 'WS' },
    generatedOn: '2026-06-09',
    requiredConfirmations: 2,
    onlyFinalized,
  })
}

describe('buildCbcExport', () => {
  it('omits participants with unverified evidence when onlyFinalized', () => {
    const annotated = annotateObservations([obs({ id: 'o1', ksa_code: 'GENRE', evidence_designation: 3 })], [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }),
    ]) // one confirm: pending → not finalized
    expect(exportFor(annotated, true).participants).toHaveLength(0)
    expect(exportFor(annotated, false).participants).toHaveLength(1)
  })

  it('rolls a sub-point designation up as the max of its feeding KSAs', () => {
    const annotated = annotateObservations(
      [
        obs({ id: 'o1', ksa_code: 'GENRE', evidence_designation: 2 }),
        obs({ id: 'o2', ksa_code: 'CHECK', evidence_designation: 3 }),
      ],
      [
        verdict({ observation_id: 'o1', evaluator_email: 'a' }), verdict({ observation_id: 'o1', evaluator_email: 'b' }),
        verdict({ observation_id: 'o2', evaluator_email: 'a' }), verdict({ observation_id: 'o2', evaluator_email: 'b' }),
      ],
    )
    const x = exportFor(annotated, true)
    expect(x.participants).toHaveLength(1)
    const part = x.participants[0]
    expect(part.finalized).toBe(true)
    expect(part.competencies.find((c) => c.subpoint === 'Guiding Teams')!.designation).toBe(2)
    expect(part.competencies.find((c) => c.subpoint === 'Consulting')!.designation).toBe(3)
  })

  it('emits a CSV row per participant-KSA', () => {
    const annotated = annotateObservations([obs({ id: 'o1', ksa_code: 'GENRE', evidence_designation: 2 })], [
      verdict({ observation_id: 'o1', evaluator_email: 'a' }), verdict({ observation_id: 'o1', evaluator_email: 'b' }),
    ])
    const csv = cbcKsaCsv(exportFor(annotated, true))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('participant,team,finalized,ksa_code')
    expect(lines).toHaveLength(1 + ksas.length) // header + one row per KSA
  })
})
