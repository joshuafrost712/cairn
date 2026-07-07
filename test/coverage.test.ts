import { describe, it, expect } from 'vitest'
import { aggregateCoverage, coverageRowFromEvaluation } from '../src/db/coverage'
import type { CoverageRow, EvaluationRecord } from '../src/lib/types'

// coverageRowFromEvaluation maps a submitted evaluation to a coverage row (union
// of participant_scope ids + focus id), and returns null for un-attested drafts.
// aggregateCoverage rolls coverage rows up per participant (count / evaluators /
// lastAt). Together they drive the "who still needs evaluation" cue.

function evaluation(partial: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    client_id: partial.client_id ?? 'c-1',
    evaluator_email: 'evaluator_email' in partial ? (partial.evaluator_email ?? null) : 'ana_lee@x',
    activity_id: partial.activity_id ?? 'act-1',
    workshop_id: partial.workshop_id ?? 'w-1',
    source_language: 'English',
    answers: {},
    quick_ratings: {},
    focus_participant_id: partial.focus_participant_id ?? null,
    source_text: '',
    participant_scope: partial.participant_scope ?? [],
    attestation: partial.attestation ?? true,
    ruleset_version: 'v1',
    edit_history: [],
    created_at: partial.created_at ?? '2026-07-07T00:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-07-07T00:00:00.000Z',
    sync_status: partial.sync_status ?? 'queued',
  }
}

describe('coverageRowFromEvaluation', () => {
  it('unions participant_scope ids and the focus id, dropping entries with no id', () => {
    const row = coverageRowFromEvaluation(
      evaluation({
        client_id: 'c-9',
        participant_scope: [
          { participant_id: 'p-1', name: 'One' },
          { name: 'Unnamed group remark' }, // no id — ignored
          { participant_id: 'p-2', name: 'Two' },
        ],
        focus_participant_id: 'p-3',
      }),
    )
    expect(row).not.toBeNull()
    expect(row!.client_id).toBe('c-9')
    expect(row!.participant_ids.sort()).toEqual(['p-1', 'p-2', 'p-3'])
  })

  it('de-dupes when the focus id is also in scope', () => {
    const row = coverageRowFromEvaluation(
      evaluation({ participant_scope: [{ participant_id: 'p-1', name: 'One' }], focus_participant_id: 'p-1' }),
    )
    expect(row!.participant_ids).toEqual(['p-1'])
  })

  it('returns null for an un-attested draft', () => {
    expect(coverageRowFromEvaluation(evaluation({ attestation: false }))).toBeNull()
    expect(coverageRowFromEvaluation(null)).toBeNull()
    expect(coverageRowFromEvaluation(undefined)).toBeNull()
  })
})

describe('aggregateCoverage', () => {
  const row = (partial: Partial<CoverageRow>): CoverageRow => ({
    client_id: partial.client_id ?? 'c-1',
    activity_id: partial.activity_id ?? 'act-1',
    workshop_id: partial.workshop_id ?? 'w-1',
    evaluator_email: 'evaluator_email' in partial ? (partial.evaluator_email ?? null) : 'ana_lee@x',
    participant_ids: partial.participant_ids ?? [],
    submitted_at: partial.submitted_at ?? '2026-07-07T00:00:00.000Z',
  })

  it('counts one evaluation for a covered participant', () => {
    const map = aggregateCoverage([row({ participant_ids: ['p-1'] })])
    expect(map.get('p-1')).toEqual({ count: 1, evaluators: ['ana_lee@x'], lastAt: '2026-07-07T00:00:00.000Z' })
    expect(map.has('p-2')).toBe(false)
  })

  it('two evaluators raise the count to 2 and list both, distinct', () => {
    const map = aggregateCoverage([
      row({ client_id: 'c-1', participant_ids: ['p-1'], evaluator_email: 'ana_lee@x' }),
      row({ client_id: 'c-2', participant_ids: ['p-1'], evaluator_email: 'bob_ng@x', submitted_at: '2026-07-07T01:00:00.000Z' }),
    ])
    const cov = map.get('p-1')!
    expect(cov.count).toBe(2)
    expect(cov.evaluators.sort()).toEqual(['ana_lee@x', 'bob_ng@x'])
    expect(cov.lastAt).toBe('2026-07-07T01:00:00.000Z') // most recent wins
  })

  it('does not double-list the same evaluator submitting twice', () => {
    const map = aggregateCoverage([
      row({ client_id: 'c-1', participant_ids: ['p-1'], evaluator_email: 'ana_lee@x' }),
      row({ client_id: 'c-2', participant_ids: ['p-1'], evaluator_email: 'ana_lee@x' }),
    ])
    expect(map.get('p-1')!.count).toBe(2)
    expect(map.get('p-1')!.evaluators).toEqual(['ana_lee@x'])
  })

  it('an edit that drops a participant lowers that participant\'s count (recompute from rows)', () => {
    // Before edit: two evaluations cover p-1 and p-2.
    const before = aggregateCoverage([
      row({ client_id: 'c-1', participant_ids: ['p-1', 'p-2'] }),
      row({ client_id: 'c-2', participant_ids: ['p-1'] }),
    ])
    expect(before.get('p-1')!.count).toBe(2)
    expect(before.get('p-2')!.count).toBe(1)
    // c-1 is edited to remove p-2 (its row is replaced wholesale by client_id).
    const after = aggregateCoverage([
      row({ client_id: 'c-1', participant_ids: ['p-1'] }),
      row({ client_id: 'c-2', participant_ids: ['p-1'] }),
    ])
    expect(after.get('p-1')!.count).toBe(2)
    expect(after.has('p-2')).toBe(false)
  })

  it('spans multiple participants from a whole-group capture', () => {
    const map = aggregateCoverage([row({ participant_ids: ['p-1', 'p-2', 'p-3'] })])
    expect([...map.keys()].sort()).toEqual(['p-1', 'p-2', 'p-3'])
    expect(map.get('p-2')!.count).toBe(1)
  })
})
