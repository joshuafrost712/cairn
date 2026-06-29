import { describe, it, expect } from 'vitest'
import { buildAllReports } from '../src/reports/build'
import { renderDayEmailMarkdown } from '../src/reports/dayEmail'
import { annotateObservations, participantGate, type Gate } from '../src/reports/verification'
import type { ObservationRecord, VerificationVerdict } from '../src/lib/types'
import { ksa, obs, participant, team } from './factories'

const ksas = [ksa('GENRE', { area: 'Genre Theory' }), ksa('CHECK', { area: 'Checking' })]
const p = participant({ id: 'p-1', name: 'CIT One' })
const teams = [team({ id: 't-1', name: 'Team A' })]

function buildEmail(observations: ObservationRecord[] = [], verdicts: VerificationVerdict[] = []) {
  const annotated = annotateObservations(observations, verdicts)
  const reports = buildAllReports([p], ksas, annotated, teams)
  const gates = new Map<string, Gate>([['p-1', participantGate(annotated.filter((o) => o.participant_id === 'p-1'))]])
  return renderDayEmailMarkdown(reports, gates, 'Psalms Workshop', '2026-06-29', { fromName: 'Josh' })
}

describe('renderDayEmailMarkdown', () => {
  it('names the participant, shows the merged designation, and flags a two-evaluator conflict', () => {
    const observations = [
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, evaluator_email: 'josh@sil.org' }),
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1, evaluator_email: 'boss@sil.org' }),
    ]
    const md = buildEmail(observations)
    // participant surfaced
    expect(md).toContain('CIT One')
    // merged designation is the max (3), as Reports does
    expect(md).toContain('Designation 3/3')
    // conflict made explicit with the range
    expect(md).toMatch(/conflicted/i)
    expect(md).toContain('1–3')
    // both evaluators attributed by name
    expect(md).toContain('josh rated 3/3')
    expect(md).toContain('boss rated 1/3')
  })

  it('reports agreement (no conflict) when two evaluators land on the same score', () => {
    const observations = [
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2, evaluator_email: 'josh@sil.org' }),
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2, evaluator_email: 'boss@sil.org' }),
    ]
    const md = buildEmail(observations)
    expect(md).toContain('Designation 2/3')
    expect(md).toMatch(/Evaluators agreed/)
    expect(md).not.toMatch(/conflicted here/i)
  })

  it('falls back gracefully when an observation has no evaluator attribution', () => {
    const observations = [obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2 })]
    const md = buildEmail(observations)
    expect(md).toContain('an evaluator rated 2/3')
  })

  it('handles a day with no observations', () => {
    const md = buildEmail()
    expect(md).toContain('No observations have been recorded yet today')
    expect(md).toContain('Josh')
  })
})
