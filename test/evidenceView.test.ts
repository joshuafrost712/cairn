import { describe, it, expect } from 'vitest'
import {
  buildEvidenceContext,
  evidenceSummary,
  resolveEvidence,
  resolveOne,
} from '../src/workbench/evidenceView'
import { annotateObservations } from '../src/reports/verification'
import { activity, evaluation, obs, verdict } from './factories'

const act = activity({ id: 'act-1', title: 'Psalm 1 workshop' })

function ctxFor(
  observations = [obs({ id: 'o-1', capture_client_id: 'cap-1' })],
  verdicts: ReturnType<typeof verdict>[] = [],
  evaluations = [evaluation({ client_id: 'cap-1', activity_id: 'act-1', evaluator_email: 'ruth@sil.org' })],
  activities = [act],
) {
  return buildEvidenceContext(annotateObservations(observations, verdicts), evaluations, activities)
}

describe('resolveOne', () => {
  it('reads the observation, its quote, and its capture', () => {
    const v = resolveOne('o-1', ctxFor())
    expect(v.present).toBe(true)
    expect(v.text).toBe('did a thing')
    expect(v.excerpt).toBe('quote')
    expect(v.activityTitle).toBe('Psalm 1 workshop')
    expect(v.capturedAt).toBe('2026-08-26T09:00:00.000Z')
  })

  it('falls back to the capture for the evaluator, since the observation field is best-effort', () => {
    const v = resolveOne('o-1', ctxFor([obs({ id: 'o-1', capture_client_id: 'cap-1', evaluator_email: null })]))
    expect(v.evaluator).toBe('ruth@sil.org')
  })

  it('prefers the evaluator on the observation when it has one', () => {
    const v = resolveOne(
      'o-1',
      ctxFor([obs({ id: 'o-1', capture_client_id: 'cap-1', evaluator_email: 'david@sil.org' })]),
    )
    expect(v.evaluator).toBe('david@sil.org')
  })

  it('says the event is unknown rather than showing a blank field', () => {
    // The common case: the capture was made on another evaluator's device and
    // never reached this one, so the join misses.
    const v = resolveOne('o-1', ctxFor([obs({ id: 'o-1', capture_client_id: 'never-synced' })]))
    expect(v.present).toBe(true)
    expect(v.activityTitle).toBe(null)
    expect(v.capturedAt).toBe(null)
  })

  it('handles a capture that exists but is not tied to an activity', () => {
    const v = resolveOne(
      'o-1',
      ctxFor(undefined, [], [evaluation({ client_id: 'cap-1', activity_id: null })]),
    )
    expect(v.activityTitle).toBe(null)
    expect(v.capturedAt).not.toBe(null)
  })

  it('returns a row for a deleted observation instead of dropping it', () => {
    // Dropping it would make a claim look better evidenced than it was, with
    // nothing on screen to tell the reader a citation went missing.
    const v = resolveOne('gone', ctxFor())
    expect(v.present).toBe(false)
    expect(v.observationId).toBe('gone')
    expect(v.recordsHref).toBe(null)
  })

  it('names the adjustment when a verdict moved the designation', () => {
    const v = resolveOne(
      'o-1',
      ctxFor(
        [obs({ id: 'o-1', capture_client_id: 'cap-1', evidence_designation: 1 })],
        [
          // Both must land on the same value: an adjust plus a plain confirm is
          // two evaluators disagreeing, which the gate calls disputed.
          verdict({ observation_id: 'o-1', evaluator_email: 'a@x.org', decision: 'adjust', adjusted_designation: 3 }),
          verdict({ observation_id: 'o-1', evaluator_email: 'b@x.org', decision: 'adjust', adjusted_designation: 3 }),
        ],
      ),
    )
    expect(v.designation).toBe(3)
    expect(v.adjustedFrom).toBe(1)
    expect(v.status).toBe('adjusted')
  })

  it('leaves adjustedFrom null when nothing moved', () => {
    expect(resolveOne('o-1', ctxFor()).adjustedFrom).toBe(null)
  })

  it('maps every verdict for the chips', () => {
    const v = resolveOne(
      'o-1',
      ctxFor(undefined, [
        verdict({ observation_id: 'o-1', evaluator_email: 'a@x.org', decision: 'confirm' }),
        verdict({ observation_id: 'o-1', evaluator_email: 'b@x.org', decision: 'reject' }),
      ]),
    )
    expect(v.verdicts.map((x) => [x.evaluator, x.decision])).toEqual([
      ['a@x.org', 'confirm'],
      ['b@x.org', 'reject'],
    ])
  })

  it('deep links into the correction surface', () => {
    expect(resolveOne('o-1', ctxFor()).recordsHref).toBe('/admin/records?participant=p-1')
  })

  it('has no deep link for an unattributed observation', () => {
    const v = resolveOne(
      'o-1',
      ctxFor([obs({ id: 'o-1', capture_client_id: 'cap-1', participant_id: null })]),
    )
    expect(v.recordsHref).toBe(null)
  })
})

describe('resolveEvidence', () => {
  it('keeps the order the segment named', () => {
    const ctx = ctxFor([
      obs({ id: 'o-1', capture_client_id: 'cap-1' }),
      obs({ id: 'o-2', capture_client_id: 'cap-1' }),
    ])
    expect(resolveEvidence(['o-2', 'o-1'], ctx).map((v) => v.observationId)).toEqual(['o-2', 'o-1'])
  })

  it('is empty for a line that cites nothing', () => {
    expect(resolveEvidence([], ctxFor())).toEqual([])
  })
})

describe('evidenceSummary', () => {
  const ctx = ctxFor()
  it('says when there is nothing behind a line', () => {
    expect(evidenceSummary([])).toBe('No evidence behind this line.')
  })
  it('counts', () => {
    expect(evidenceSummary(resolveEvidence(['o-1'], ctx))).toBe('1 observation')
  })
  it('calls out citations it could not resolve', () => {
    expect(evidenceSummary(resolveEvidence(['o-1', 'gone'], ctx))).toBe(
      '2 observations, 1 no longer on this device',
    )
  })
})
