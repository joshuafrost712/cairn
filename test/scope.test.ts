import { describe, it, expect } from 'vitest'
import { scopeEvidence } from '../src/reports/scope'
import { observationsForWorkshop, unresolvedObservations } from '../src/reports/workshopOverview'
import { evaluation, obs, participant, team, verdict } from './factories'
import type { Goal, Ksa } from '../src/lib/types'

/**
 * tl-29. The rules that decide which rows one workshop's screen may read.
 *
 * The interesting cases are all about the NULLABLE `workshop_id` on an observation.
 * tl-04 fills it at ingest, and the rows that predate it are the stranded phone
 * evaluations tl-18 recovered, which are real evidence about real people. A filter
 * that drops them is a data-loss bug wearing the clothes of a scoping fix, so the
 * resolver has three fallbacks and the rows it still cannot place are counted rather
 * than hidden.
 */

const ksa = (code: string, workshopId: string | null): Ksa =>
  ({
    id: `k-${code}-${workshopId}`,
    code,
    short_label: code,
    evaluator_facing_prompt: code,
    workshop_id: workshopId,
    goal_id: `g-${workshopId}`,
    sort_order: 0,
  }) as unknown as Ksa

const goal = (workshopId: string | null): Goal =>
  ({
    id: `g-${workshopId}`,
    code: 'G1',
    title: `Goal of ${workshopId}`,
    workshop_id: workshopId,
    sort_order: 0,
  }) as unknown as Goal

describe('observationsForWorkshop resolves through three sources in confidence order', () => {
  it('takes the observation own workshop_id when it has one, and ignores the other two', () => {
    const rows = [
      obs({ id: 'a', workshop_id: 'w-1', capture_client_id: 'c-2', participant_id: 'p-2' }),
      obs({ id: 'b', workshop_id: 'w-2' }),
    ]
    const captures = [evaluation({ client_id: 'c-2', workshop_id: 'w-2' })]
    const people = [participant({ id: 'p-2', workshop_id: 'w-2' })]
    expect(observationsForWorkshop(rows, captures, 'w-1', people).map((o) => o.id)).toEqual(['a'])
  })

  it('falls back to the capture workshop when the row has none', () => {
    const rows = [obs({ id: 'a', workshop_id: null, capture_client_id: 'c-1' })]
    const captures = [evaluation({ client_id: 'c-1', workshop_id: 'w-1' })]
    expect(observationsForWorkshop(rows, captures, 'w-1').map((o) => o.id)).toEqual(['a'])
    expect(observationsForWorkshop(rows, captures, 'w-2')).toEqual([])
  })

  it('falls back to the participant when the capture is no longer on this device', () => {
    // The case setup/counts.ts carried its own resolver for: the devices holding the
    // most at-risk stranded evidence are exactly the ones whose captures have gone.
    const rows = [obs({ id: 'a', workshop_id: null, capture_client_id: 'gone', participant_id: 'p-1' })]
    const people = [participant({ id: 'p-1', workshop_id: 'w-1' })]
    expect(observationsForWorkshop(rows, [], 'w-1', people).map((o) => o.id)).toEqual(['a'])
  })

  it('does not consult the participant when the capture answered, even if they disagree', () => {
    const rows = [obs({ id: 'a', workshop_id: null, capture_client_id: 'c-1', participant_id: 'p-1' })]
    const captures = [evaluation({ client_id: 'c-1', workshop_id: 'w-2' })]
    const people = [participant({ id: 'p-1', workshop_id: 'w-1' })]
    expect(observationsForWorkshop(rows, captures, 'w-1', people)).toEqual([])
    expect(observationsForWorkshop(rows, captures, 'w-2', people).map((o) => o.id)).toEqual(['a'])
  })

  it('places nothing when no source can answer, and says so through unresolvedObservations', () => {
    const rows = [obs({ id: 'a', workshop_id: null, capture_client_id: 'gone', participant_id: 'gone' })]
    expect(observationsForWorkshop(rows, [], 'w-1', [])).toEqual([])
    expect(unresolvedObservations(rows, [], []).map((o) => o.id)).toEqual(['a'])
  })

  it('counts a placeable row as resolved even when it belongs to another workshop', () => {
    const rows = [obs({ id: 'a', workshop_id: 'w-2' })]
    expect(unresolvedObservations(rows, [], [])).toEqual([])
  })
})

describe('scopeEvidence narrows one device cache to one workshop', () => {
  const fixture = () => ({
    participants: [
      participant({ id: 'p-1', workshop_id: 'w-1', name: 'Ours' }),
      participant({ id: 'p-2', workshop_id: 'w-2', name: 'Theirs' }),
    ],
    teams: [team({ id: 't-1', workshop_id: 'w-1' }), team({ id: 't-2', workshop_id: 'w-2' })],
    ksas: [ksa('EXEG', 'w-1'), ksa('AESTH', 'w-2')],
    goals: [goal('w-1'), goal('w-2')],
    observations: [
      obs({ id: 'o-1', workshop_id: 'w-1', participant_id: 'p-1' }),
      obs({ id: 'o-2', workshop_id: 'w-2', participant_id: 'p-2' }),
    ],
    verdicts: [
      verdict({ observation_id: 'o-1', evaluator_email: 'a@x' }),
      verdict({ observation_id: 'o-2', evaluator_email: 'a@x' }),
    ],
    evaluations: [
      evaluation({ client_id: 'c-1', workshop_id: 'w-1' }),
      evaluation({ client_id: 'c-2', workshop_id: 'w-2' }),
    ],
  })

  it('keeps this workshop rows and drops the other one across every collection', () => {
    const s = scopeEvidence({ workshopId: 'w-1', ...fixture() })
    expect(s.participants.map((p) => p.name)).toEqual(['Ours'])
    expect(s.teams.map((t) => t.id)).toEqual(['t-1'])
    expect(s.ksas.map((k) => k.code)).toEqual(['EXEG'])
    expect(s.observations.map((o) => o.id)).toEqual(['o-1'])
    expect(s.evaluations.map((e) => e.client_id)).toEqual(['c-1'])
  })

  it('derives verdicts from the scoped observations rather than filtering them separately', () => {
    const s = scopeEvidence({ workshopId: 'w-1', ...fixture() })
    expect(s.verdicts.map((v) => v.observation_id)).toEqual(['o-1'])
  })

  it('joins each question to its own workshop goal title, code-sorted', () => {
    const f = fixture()
    f.ksas.push(ksa('ADVOC', 'w-1'))
    const s = scopeEvidence({ workshopId: 'w-1', ...f })
    expect(s.ksas.map((k) => k.code)).toEqual(['ADVOC', 'EXEG'])
    expect(s.ksas.every((k) => k.goal_title === 'Goal of w-1')).toBe(true)
  })

  it('passes everything through when there is no active workshop, which is a real state', () => {
    // A local-only build has no membership row and a signing-in device has not read one
    // yet. Narrowing to nothing there would empty the screen for the people most likely
    // to be evaluating with no backend.
    const s = scopeEvidence({ workshopId: null, ...fixture() })
    expect(s.participants).toHaveLength(2)
    expect(s.observations).toHaveLength(2)
    expect(s.verdicts).toHaveLength(2)
  })

  it('resolves a null-workshop observation through its participant, so stranded evidence still counts', () => {
    const f = fixture()
    f.observations.push(
      obs({ id: 'o-3', workshop_id: null, capture_client_id: 'gone', participant_id: 'p-1' }),
    )
    const s = scopeEvidence({ workshopId: 'w-1', ...f })
    expect(s.observations.map((o) => o.id)).toEqual(['o-1', 'o-3'])
    expect(s.unresolved).toEqual([])
  })

  it('reports the rows it could not place, rather than dropping them silently', () => {
    const f = fixture()
    f.observations.push(
      obs({ id: 'o-9', workshop_id: null, capture_client_id: 'gone', participant_id: 'gone' }),
    )
    const s = scopeEvidence({ workshopId: 'w-1', ...f })
    expect(s.observations.map((o) => o.id)).toEqual(['o-1'])
    expect(s.unresolved.map((o) => o.id)).toEqual(['o-9'])
  })

  it('treats a workshop with nothing in the cache as empty rather than as unscoped', () => {
    const s = scopeEvidence({ workshopId: 'w-3', ...fixture() })
    expect(s.participants).toEqual([])
    expect(s.observations).toEqual([])
    expect(s.ksas).toEqual([])
  })
})
