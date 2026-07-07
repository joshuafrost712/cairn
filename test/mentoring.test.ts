import { describe, it, expect } from 'vitest'
import { annotateObservations } from '../src/reports/verification'
import { deriveNeededConversations } from '../src/db/mentoring'
import { obs, verdict, participant } from './factories'
import type { Participant } from '../src/lib/types'

// deriveNeededConversations turns confirmed-low observations into 'needed'
// mentoring conversations. "Confirmed low" = vstatus verified/adjusted AND
// effective_designation 0 or 1. The default confirmation threshold is 2.

const NOW = '2026-06-26T00:00:00.000Z'

function pmap(...ps: Participant[]): Map<string, Participant> {
  return new Map(ps.map((p) => [p.id, p]))
}

// Two confirming verdicts push an observation to 'verified' at its designation.
function confirmedTwice(observation_id: string) {
  return [
    verdict({ observation_id, evaluator_email: 'a@x' }),
    verdict({ observation_id, evaluator_email: 'b@x' }),
  ]
}

describe('deriveNeededConversations', () => {
  it('(a) makes one needed conversation for a confirmed low (designation 0 or 1)', () => {
    for (const d of [0, 1] as const) {
      const o = obs({ id: `low-${d}`, evidence_designation: d, participant_id: 'p-1' })
      const annotated = annotateObservations([o], confirmedTwice(o.id))
      const result = deriveNeededConversations(annotated, pmap(participant({ id: 'p-1', name: 'CIT One' })), NOW)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(`mc::low-${d}`)
      expect(result[0].status).toBe('needed')
      expect(result[0].trigger_designation).toBe(d)
      expect(result[0].trigger_observation_id).toBe(o.id)
      expect(result[0].participant_name).toBe('CIT One')
      expect(result[0].created_at).toBe(NOW)
      expect(result[0].sync_status).toBe('local')
    }
  })

  it('also fires for an adjusted-down observation (verdicts adjust to 1)', () => {
    // Routed at 3 but both evaluators adjust down to 1 → adjusted, effective 1.
    const o = obs({ id: 'adj-1', evidence_designation: 3, participant_id: 'p-1' })
    const annotated = annotateObservations([o], [
      verdict({ observation_id: o.id, evaluator_email: 'a@x', decision: 'adjust', adjusted_designation: 1 }),
      verdict({ observation_id: o.id, evaluator_email: 'b@x', decision: 'adjust', adjusted_designation: 1 }),
    ])
    const result = deriveNeededConversations(annotated, pmap(participant({ id: 'p-1' })), NOW)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('mc::adj-1')
    expect(result[0].trigger_designation).toBe(1)
  })

  it('(b) makes none for a designation of 2 or 3', () => {
    for (const d of [2, 3] as const) {
      const o = obs({ id: `high-${d}`, evidence_designation: d, participant_id: 'p-1' })
      const annotated = annotateObservations([o], confirmedTwice(o.id))
      const result = deriveNeededConversations(annotated, pmap(participant({ id: 'p-1' })), NOW)
      expect(result).toHaveLength(0)
    }
  })

  it('(c) makes none for a disputed or set-aside (pending) low observation', () => {
    // Disputed: one reject present.
    const disputed = obs({ id: 'disp', evidence_designation: 0, participant_id: 'p-1' })
    const disputedAnn = annotateObservations([disputed], [
      verdict({ observation_id: disputed.id, evaluator_email: 'a@x' }),
      verdict({ observation_id: disputed.id, evaluator_email: 'b@x', decision: 'reject' }),
    ])
    expect(deriveNeededConversations(disputedAnn, pmap(participant({ id: 'p-1' })), NOW)).toHaveLength(0)

    // Set aside / pending: only one confirmation, below the threshold of 2.
    const pending = obs({ id: 'pend', evidence_designation: 1, participant_id: 'p-1' })
    const pendingAnn = annotateObservations([pending], [
      verdict({ observation_id: pending.id, evaluator_email: 'a@x' }),
    ])
    expect(deriveNeededConversations(pendingAnn, pmap(participant({ id: 'p-1' })), NOW)).toHaveLength(0)
  })

  it('(d) makes two conversations for two low observations on different KSAs', () => {
    const o1 = obs({ id: 'k1', ksa_code: 'GENRE', evidence_designation: 0, participant_id: 'p-1' })
    const o2 = obs({ id: 'k2', ksa_code: 'EXEGESIS', evidence_designation: 1, participant_id: 'p-1' })
    const annotated = annotateObservations([o1, o2], [...confirmedTwice('k1'), ...confirmedTwice('k2')])
    const result = deriveNeededConversations(annotated, pmap(participant({ id: 'p-1' })), NOW)

    expect(result).toHaveLength(2)
    expect(result.map((c) => c.id).sort()).toEqual(['mc::k1', 'mc::k2'])
    expect(result.map((c) => c.trigger_ksa_code).sort()).toEqual(['EXEGESIS', 'GENRE'])
  })

  it('skips observations with no participant_id', () => {
    const o = obs({ id: 'orphan', evidence_designation: 0, participant_id: null })
    const annotated = annotateObservations([o], confirmedTwice(o.id))
    expect(deriveNeededConversations(annotated, pmap(), NOW)).toHaveLength(0)
  })
})
