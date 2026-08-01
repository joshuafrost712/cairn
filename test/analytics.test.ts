import { describe, it, expect } from 'vitest'
import { DEFAULT_SCALE, buildScale, normalizeScalePoints } from '../src/lib/scale'
import { activity, evaluation, ksa, obs, participant, team, verdict } from './factories'
import { annotateObservations, participantGate } from '../src/reports/verification'
import { buildAllReports } from '../src/reports/build'
import type { Gate } from '../src/reports/verification'
import { discrepancyId } from '../src/reports/discrepancy'
import {
  EMPTY_STATS,
  MIN_N_FOR_MEAN,
  UNKNOWN_EVALUATOR,
  activityAnalytics,
  attributionHealth,
  buildCaptureIndex,
  buildHeatmap,
  countsToward,
  designationStats,
  evaluatorAnalytics,
  flagParticipants,
  ksaAnalytics,
  situate,
  valueOf,
  workbenchSummary,
} from '../src/reports/analytics'

/** annotate + situate in one step, the way every page will do it. */
function prep(observations: ReturnType<typeof obs>[], evaluations = [evaluation({ client_id: 'cap-1' })]) {
  const annotated = annotateObservations(observations, [])
  return situate(annotated, buildCaptureIndex(evaluations))
}

function gatesFor(reports: ReturnType<typeof buildAllReports>): Map<string, Gate> {
  const m = new Map<string, Gate>()
  for (const r of reports) {
    m.set(r.participant_id, participantGate(r.ksaRollups.flatMap((k) => [...k.contributing, ...k.toVerify])))
  }
  return m
}

describe('buildCaptureIndex / situate', () => {
  it('joins activity_id and evaluator through capture_client_id', () => {
    const [o] = prep(
      [obs({ capture_client_id: 'cap-9' })],
      [evaluation({ client_id: 'cap-9', activity_id: 'act-7', evaluator_email: 'ruth@x.org' })],
    )
    expect(o.activity_id).toBe('act-7')
    expect(o.evaluator).toBe('ruth@x.org')
    expect(o.orphaned).toBe(false)
  })

  it('prefers the observation own evaluator_email over the capture one', () => {
    const [o] = prep(
      [obs({ capture_client_id: 'cap-9', evaluator_email: 'david@x.org' })],
      [evaluation({ client_id: 'cap-9', evaluator_email: 'ruth@x.org' })],
    )
    expect(o.evaluator).toBe('david@x.org')
  })

  it('falls back to the capture evaluator when the observation has none', () => {
    const [o] = prep(
      [obs({ capture_client_id: 'cap-9', evaluator_email: null })],
      [evaluation({ client_id: 'cap-9', evaluator_email: 'ruth@x.org' })],
    )
    expect(o.evaluator).toBe('ruth@x.org')
  })

  it('marks an unknown capture orphaned with a null activity, rather than dropping it', () => {
    const [o] = prep([obs({ capture_client_id: 'made-on-another-device' })], [])
    expect(o.orphaned).toBe(true)
    expect(o.activity_id).toBeNull()
    expect(o.evaluator).toBeNull()
  })

  it('attributionHealth counts orphans, missing activities and null participants', () => {
    const situated = prep(
      [
        obs({ capture_client_id: 'cap-1' }),
        obs({ capture_client_id: 'gone' }),
        obs({ capture_client_id: 'cap-1', participant_id: null }),
      ],
      [evaluation({ client_id: 'cap-1', activity_id: 'act-1', evaluator_email: 'a@x.org' })],
    )
    const h = attributionHealth(situated)
    expect(h.total).toBe(3)
    expect(h.withActivity).toBe(2)
    expect(h.orphanedCaptures).toEqual(['gone'])
    expect(h.unattributedParticipant).toBe(1)
  })
})

describe('designationStats', () => {
  it('is EMPTY_STATS at n=0, with a null mean rather than a zero', () => {
    expect(designationStats([])).toEqual(EMPTY_STATS)
    expect(designationStats([]).mean).toBeNull()
  })

  it('reports no printable mean at n=1, but still exposes the arithmetic one', () => {
    const s = designationStats([3])
    expect(s.n).toBe(1)
    expect(s.reportableMean).toBeNull()
    expect(s.mean).toBe(3)
    expect(s.min).toBe(3)
    expect(s.max).toBe(3)
    expect(s.lowN).toBe(true)
  })

  it('still suppresses the printable mean at n=2', () => {
    const s = designationStats([1, 3])
    expect(s.mean).toBe(2)
    expect(s.reportableMean).toBeNull()
    expect(s.lowN).toBe(true)
  })

  it('reports a printable mean from MIN_N_FOR_MEAN upward', () => {
    const s = designationStats([1, 2, 3])
    expect(MIN_N_FOR_MEAN).toBe(3)
    expect(s.lowN).toBe(false)
    expect(s.reportableMean).toBe(2)
  })

  it('takes the lower middle for an even-n median, never interpolating to 1.5', () => {
    expect(designationStats([0, 1, 2, 3]).median).toBe(1)
    expect(designationStats([0, 1, 2]).median).toBe(1)
  })

  it('indexes the distribution by designation and sums to n', () => {
    const s = designationStats([0, 0, 2, 3, 3, 3])
    expect(s.dist).toEqual([2, 0, 1, 3])
    expect(s.dist.reduce((a, b) => a + b, 0)).toBe(s.n)
  })

  it('counts at-risk values by the scale\'s trigger flags, not by a threshold (tl-09)', () => {
    // Unchanged on the app's original scale, where 0 and 1 are the triggers.
    expect(designationStats([0, 1, 2, 3], DEFAULT_SCALE).atRisk).toBe(2)

    // On a 1-5 scale where only the bottom point calls for a conversation, a
    // `v <= 1` rule would still have said one; it agrees here by accident. The
    // case that separates them is the scale below, where 2 IS a trigger and 1
    // is not, which no threshold can express.
    const odd = buildScale(
      'w1',
      normalizeScalePoints('w1', [
        { value: 1, label: 'unusual but fine', description: null, is_low_trigger: false },
        { value: 2, label: 'the worrying one', description: null, is_low_trigger: true },
        { value: 3, label: 'good', description: null, is_low_trigger: false },
      ]),
    )
    expect(designationStats([1, 2, 3], odd).atRisk).toBe(1)
    expect(designationStats([1, 1, 1], odd).atRisk).toBe(0)
  })

  it('buckets a distribution by scale POSITION, so a 1-5 scale has five buckets', () => {
    const five = buildScale(
      'w1',
      normalizeScalePoints('w1', [1, 2, 3, 4, 5].map((v) => ({
        value: v,
        label: `p${v}`,
        description: null,
        is_low_trigger: v === 1,
      }))),
    )
    const s = designationStats([1, 1, 3, 5], five)
    expect(s.dist).toEqual([2, 0, 1, 0, 1])
    expect(s.dist.reduce((a, b) => a + b, 0)).toBe(s.n)
  })
})

describe('counting policy', () => {
  const situatedFrom = (o: ReturnType<typeof obs>, vs: ReturnType<typeof verdict>[]) =>
    situate(annotateObservations([o], vs), buildCaptureIndex([evaluation({ client_id: 'cap-1' })]))[0]

  it("'counting' excludes an unverified needs_review observation", () => {
    const o = situatedFrom(obs({ id: 'o1', needs_review: true }), [])
    expect(countsToward(o, 'counting')).toBe(false)
    expect(countsToward(o, 'all')).toBe(true)
  })

  it("'counting' INCLUDES a verified observation that routing had flagged", () => {
    const o = situatedFrom(obs({ id: 'o1', needs_review: true, evidence_designation: 2 }), [
      verdict({ observation_id: 'o1', evaluator_email: 'a@x.org' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b@x.org' }),
    ])
    expect(o.vstatus).toBe('verified')
    expect(countsToward(o, 'counting')).toBe(true)
  })

  it("'counting' uses effective_designation on an adjusted observation", () => {
    const o = situatedFrom(obs({ id: 'o1', evidence_designation: 2 }), [
      verdict({ observation_id: 'o1', evaluator_email: 'a@x.org', decision: 'adjust', adjusted_designation: 1 }),
      verdict({ observation_id: 'o1', evaluator_email: 'b@x.org', decision: 'adjust', adjusted_designation: 1 }),
    ])
    expect(o.vstatus).toBe('adjusted')
    expect(valueOf(o, 'counting')).toBe(1)
  })

  it("'all' keeps a disputed observation at its RAW designation, so a harsh evaluator still reads harsh", () => {
    const o = situatedFrom(obs({ id: 'o1', evidence_designation: 0 }), [
      verdict({ observation_id: 'o1', evaluator_email: 'a@x.org', decision: 'reject' }),
    ])
    expect(o.vstatus).toBe('disputed')
    expect(countsToward(o, 'counting')).toBe(false)
    expect(countsToward(o, 'all')).toBe(true)
    expect(valueOf(o, 'all')).toBe(0)
  })
})

describe('activityAnalytics', () => {
  const ksas = [ksa('GENRE'), ksa('EXEG'), ksa('CLAT')]
  const act = activity({ id: 'act-1', title: 'Internalization' })
  const evals = [
    evaluation({ client_id: 'cap-1', activity_id: 'act-1', evaluator_email: 'ruth@x.org' }),
    evaluation({ client_id: 'cap-2', activity_id: 'act-2', evaluator_email: 'david@x.org' }),
  ]

  it('buckets observations to the right activity via the capture join', () => {
    const situated = prep(
      [
        obs({ capture_client_id: 'cap-1', ksa_code: 'GENRE', evidence_designation: 3 }),
        obs({ capture_client_id: 'cap-2', ksa_code: 'GENRE', evidence_designation: 0 }),
      ],
      evals,
    )
    const a = activityAnalytics(act, ksas, situated, evals)
    expect(a.observationCount).toBe(1)
    expect(a.overall.max).toBe(3)
  })

  it('excludes an orphaned observation and reports unrouted captures', () => {
    const situated = prep(
      [obs({ capture_client_id: 'never-synced', ksa_code: 'GENRE' })],
      [evaluation({ client_id: 'cap-1', activity_id: 'act-1' })],
    )
    const a = activityAnalytics(act, ksas, situated, [
      evaluation({ client_id: 'cap-1', activity_id: 'act-1' }),
    ])
    expect(a.observationCount).toBe(0)
    expect(a.unroutedCaptures).toBe(1)
  })

  it('includes every KSA, even those with no evidence', () => {
    const situated = prep([obs({ capture_client_id: 'cap-1', ksa_code: 'GENRE' })], evals)
    const a = activityAnalytics(act, ksas, situated, evals)
    expect(a.perKsa.map((k) => k.ksa_code)).toEqual(['GENRE', 'EXEG', 'CLAT'])
    expect(a.perKsa[1].stats).toEqual(EMPTY_STATS)
  })

  it('flags participants with an at-risk value, worst first', () => {
    const situated = prep(
      [
        obs({ capture_client_id: 'cap-1', participant_id: 'p-1', participant_name: 'Amos', ksa_code: 'EXEG', evidence_designation: 0 }),
        obs({ capture_client_id: 'cap-1', participant_id: 'p-2', participant_name: 'Chula', ksa_code: 'EXEG', evidence_designation: 1 }),
        obs({ capture_client_id: 'cap-1', participant_id: 'p-3', participant_name: 'Sajesh', ksa_code: 'EXEG', evidence_designation: 3 }),
      ],
      evals,
    )
    const a = activityAnalytics(act, ksas, situated, evals)
    expect(a.flagged.map((f) => f.participant_name)).toEqual(['Amos', 'Chula'])
    expect(a.flagged[0].lowest).toBe(0)
    expect(a.flagged[0].observationIds).toHaveLength(1)
  })

  it('rolls each KSA up to one row per participant, taking their best score', () => {
    const situated = prep(
      [
        // Amos scored twice on EXEG by two evaluators: one row, at his best.
        obs({ id: 'a', capture_client_id: 'cap-1', participant_id: 'p-1', participant_name: 'Amos', ksa_code: 'EXEG', evidence_designation: 0 }),
        obs({ id: 'b', capture_client_id: 'cap-1', participant_id: 'p-1', participant_name: 'Amos', ksa_code: 'EXEG', evidence_designation: 3 }),
        obs({ id: 'c', capture_client_id: 'cap-1', participant_id: 'p-2', participant_name: 'Chula', ksa_code: 'EXEG', evidence_designation: 1 }),
      ],
      evals,
    )
    const exeg = activityAnalytics(act, ksas, situated, evals).perKsa.find((k) => k.ksa_code === 'EXEG')!
    // stats still counts observations; byParticipant counts people.
    expect(exeg.stats.n).toBe(3)
    expect(exeg.byParticipant.map((p) => [p.participant_name, p.value])).toEqual([
      ['Chula', 1],
      ['Amos', 3],
    ])
    expect(exeg.byParticipant.find((p) => p.participant_name === 'Amos')!.observationIds.sort()).toEqual(['a', 'b'])
    // Amos is NOT weak: his report would call him a 3, so the event view must too.
    expect(exeg.weak.map((p) => p.participant_name)).toEqual(['Chula'])
  })

  it('keeps unattributed observations as separate rows rather than one phantom participant', () => {
    const situated = prep(
      [
        obs({ capture_client_id: 'cap-1', participant_id: null, participant_name: 'Someone', ksa_code: 'EXEG', evidence_designation: 0 }),
        obs({ capture_client_id: 'cap-1', participant_id: null, participant_name: 'Another', ksa_code: 'EXEG', evidence_designation: 1 }),
      ],
      evals,
    )
    const exeg = activityAnalytics(act, ksas, situated, evals).perKsa.find((k) => k.ksa_code === 'EXEG')!
    expect(exeg.byParticipant).toHaveLength(2)
  })

  it('counts distinct evaluators and sorts the unknown bucket last', () => {
    const situated = prep(
      [
        obs({ capture_client_id: 'cap-1', evaluator_email: 'zoe@x.org' }),
        obs({ capture_client_id: 'cap-1', evaluator_email: null }),
        obs({ capture_client_id: 'cap-1', evaluator_email: 'ruth@x.org' }),
      ],
      [evaluation({ client_id: 'cap-1', activity_id: 'act-1', evaluator_email: null })],
    )
    const a = activityAnalytics(act, ksas, situated, evals)
    expect(a.evaluators).toEqual(['ruth@x.org', 'zoe@x.org', UNKNOWN_EVALUATOR])
  })
})

describe('flagParticipants', () => {
  const ksas = [ksa('GENRE'), ksa('EXEG'), ksa('CLAT')]
  const people = [participant({ id: 'p-1', name: 'Amos' })]
  const teams = [team()]

  const build = (observations: ReturnType<typeof obs>[], vs: ReturnType<typeof verdict>[] = []) => {
    const annotated = annotateObservations(observations, vs)
    const reports = buildAllReports(people, ksas, annotated, teams)
    return { reports, flags: flagParticipants(reports, gatesFor(reports)) }
  }

  it('flags a low representative', () => {
    const { flags } = build([obs({ participant_id: 'p-1', ksa_code: 'EXEG', evidence_designation: 0 })])
    expect(flags[0].reasons).toContainEqual({ kind: 'low_representative', ksa_code: 'EXEG', value: 0 })
    expect(flags[0].lowestRepresentative).toBe(0)
  })

  it('flags a conflicting rollup with its lo and hi', () => {
    const { flags } = build([
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 }),
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
    ])
    expect(flags[0].reasons).toContainEqual({ kind: 'conflict', ksa_code: 'GENRE', lo: 1, hi: 3 })
  })

  it('flags thin coverage below the floor', () => {
    const { flags } = build([obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 })])
    expect(flags[0].reasons).toContainEqual({ kind: 'thin_coverage', evidenced: 1, total: 3 })
  })

  it('reports no_evidence rather than thin_coverage when nothing landed at all', () => {
    const { flags } = build([])
    expect(flags[0].reasons).toContainEqual({ kind: 'no_evidence' })
  })

  it('orders a zero above a one above a bare conflict', () => {
    const ppl = [
      participant({ id: 'p-1', name: 'Zero' }),
      participant({ id: 'p-2', name: 'One' }),
      participant({ id: 'p-3', name: 'Conflict' }),
    ]
    const observations = [
      ...ksas.map((k) => obs({ participant_id: 'p-1', ksa_code: k.code, evidence_designation: 0 })),
      ...ksas.map((k) => obs({ participant_id: 'p-2', ksa_code: k.code, evidence_designation: 1 })),
      ...ksas.flatMap((k) => [
        obs({ participant_id: 'p-3', ksa_code: k.code, evidence_designation: 1 }),
        obs({ participant_id: 'p-3', ksa_code: k.code, evidence_designation: 3 }),
      ]),
    ]
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports(ppl, ksas, annotated, teams)
    const flags = flagParticipants(reports, gatesFor(reports))
    expect(flags.map((f) => f.participant_name)).toEqual(['Zero', 'One', 'Conflict'])
  })

  it('produces no flags for a fully-evidenced strong participant', () => {
    const { flags } = build(
      ksas.map((k) => obs({ participant_id: 'p-1', ksa_code: k.code, evidence_designation: 3 })),
    )
    expect(flags).toEqual([])
  })
})

describe('evaluatorAnalytics leniency', () => {
  const acts = [activity({ id: 'act-1' })]
  // One capture per evaluator, so the join gives each observation an owner.
  const evals = [
    evaluation({ client_id: 'cap-r', activity_id: 'act-1', evaluator_email: 'ruth@x.org' }),
    evaluation({ client_id: 'cap-d', activity_id: 'act-1', evaluator_email: 'david@x.org' }),
  ]
  const pair = (p: string, k: string, ruth: number, david: number) => [
    obs({ capture_client_id: 'cap-r', participant_id: p, ksa_code: k, evidence_designation: ruth as 0 | 1 | 2 | 3 }),
    obs({ capture_client_id: 'cap-d', participant_id: p, ksa_code: k, evidence_designation: david as 0 | 1 | 2 | 3 }),
  ]
  const run = (observations: ReturnType<typeof obs>[], evaluations = evals) =>
    evaluatorAnalytics(prep(observations, evaluations), [], evaluations, acts)

  it('suppresses the delta below MIN_PAIRED_CELLS and says why', () => {
    const out = run([...pair('p-1', 'GENRE', 3, 2), ...pair('p-2', 'GENRE', 3, 2)])
    const ruth = out.find((e) => e.evaluator === 'ruth@x.org')!
    expect(ruth.leniency.pairedCells).toBe(2)
    expect(ruth.leniency.delta).toBeNull()
    expect(ruth.leniency.suppressed).toBe('insufficient_overlap')
  })

  it('reports +1.0 for an evaluator giving 3 where the only peer gives 2, across five cells', () => {
    const observations = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].flatMap((p) => pair(p, 'GENRE', 3, 2))
    const out = run(observations)
    const ruth = out.find((e) => e.evaluator === 'ruth@x.org')!
    const david = out.find((e) => e.evaluator === 'david@x.org')!
    expect(ruth.leniency.pairedCells).toBe(5)
    expect(ruth.leniency.delta).toBeCloseTo(1)
    expect(david.leniency.delta).toBeCloseTo(-1)
  })

  it('reports 0.0 for two evaluators who always agree', () => {
    const observations = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].flatMap((p) => pair(p, 'GENRE', 2, 2))
    const ruth = run(observations).find((e) => e.evaluator === 'ruth@x.org')!
    expect(ruth.leniency.delta).toBeCloseTo(0)
    expect(ruth.leniency.sd).toBeCloseTo(0)
  })

  it('excludes cells only one evaluator scored', () => {
    const observations = [
      ...['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].flatMap((p) => pair(p, 'GENRE', 3, 2)),
      obs({ capture_client_id: 'cap-r', participant_id: 'p-9', ksa_code: 'SOLO', evidence_designation: 0 }),
    ]
    const ruth = run(observations).find((e) => e.evaluator === 'ruth@x.org')!
    expect(ruth.leniency.pairedCells).toBe(5)
    expect(ruth.leniency.cells.some((c) => c.ksa_code === 'SOLO')).toBe(false)
  })

  it('weights `others` by evaluator, not by observation count', () => {
    // David logs three observations on one cell; Ana logs one. Ana must not be
    // outweighed 3:1 — `others` is the mean of their two per-evaluator means.
    const three = [
      evaluation({ client_id: 'cap-r', activity_id: 'act-1', evaluator_email: 'ruth@x.org' }),
      evaluation({ client_id: 'cap-d', activity_id: 'act-1', evaluator_email: 'david@x.org' }),
      evaluation({ client_id: 'cap-a', activity_id: 'act-1', evaluator_email: 'ana@x.org' }),
    ]
    const observations = [
      obs({ capture_client_id: 'cap-r', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
      obs({ capture_client_id: 'cap-d', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0 }),
      obs({ capture_client_id: 'cap-d', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0 }),
      obs({ capture_client_id: 'cap-d', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 0 }),
      obs({ capture_client_id: 'cap-a', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2 }),
    ]
    const ruth = evaluatorAnalytics(prep(observations, three), [], three, acts).find(
      (e) => e.evaluator === 'ruth@x.org',
    )!
    // others = mean(mean([0,0,0]), mean([2])) = mean(0, 2) = 1, not mean([0,0,0,2]) = 0.5
    expect(ruth.leniency.cells[0].others).toBeCloseTo(1)
    expect(ruth.leniency.cells[0].peers).toBe(2)
  })

  it('separates an inconsistent evaluator from a neutral one via the sd', () => {
    // Ruth is +2 on half the cells and -2 on the other half: delta ~0, sd large.
    const observations = [
      ...pair('p-1', 'GENRE', 3, 1),
      ...pair('p-2', 'GENRE', 3, 1),
      ...pair('p-3', 'GENRE', 3, 1),
      ...pair('p-4', 'GENRE', 1, 3),
      ...pair('p-5', 'GENRE', 1, 3),
      ...pair('p-6', 'GENRE', 1, 3),
    ]
    const ruth = run(observations).find((e) => e.evaluator === 'ruth@x.org')!
    expect(ruth.leniency.delta).toBeCloseTo(0)
    expect(ruth.leniency.sd ?? 0).toBeGreaterThan(1.5)
  })

  it('lets the unadjusted mean and the paired delta point in OPPOSITE directions', () => {
    // The whole reason the paired statistic exists. Ruth only observed a strong
    // participant, so her raw mean is high; but on the one cell she shares with
    // David she scored BELOW him.
    const observations = [
      // shared cells: ruth 2, david 3  -> ruth reads stricter
      ...['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].flatMap((p) => pair(p, 'GENRE', 2, 3)),
      // ruth alone on a batch of strong participants, lifting her raw mean
      ...['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'].map((p) =>
        obs({ capture_client_id: 'cap-r', participant_id: p, ksa_code: 'SOLO', evidence_designation: 3 }),
      ),
      // david alone on a batch of weak ones, dragging his raw mean down
      ...['w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6'].map((p) =>
        obs({ capture_client_id: 'cap-d', participant_id: p, ksa_code: 'SOLO', evidence_designation: 0 }),
      ),
    ]
    const out = run(observations)
    const ruth = out.find((e) => e.evaluator === 'ruth@x.org')!
    const david = out.find((e) => e.evaluator === 'david@x.org')!

    // Raw: Ruth looks far more generous than David.
    expect((ruth.given.mean ?? 0) - (david.given.mean ?? 0)).toBeGreaterThan(1)
    // Paired: on the evidence they both saw, Ruth is the stricter one.
    expect(ruth.leniency.delta).toBeCloseTo(-1)
    expect(david.leniency.delta).toBeCloseTo(1)
  })
})

describe('evaluatorAnalytics coverage and verdicts', () => {
  const acts = [activity({ id: 'act-1', title: 'Internalization' })]
  const evals = [evaluation({ client_id: 'cap-r', activity_id: 'act-1', evaluator_email: 'ruth@x.org' })]

  it('counts who they reviewed most, and verdicts cast on other people work', () => {
    const observations = [
      obs({ id: 'o1', capture_client_id: 'cap-r', participant_id: 'p-1', participant_name: 'Amos' }),
      obs({ id: 'o2', capture_client_id: 'cap-r', participant_id: 'p-1', participant_name: 'Amos' }),
      obs({ id: 'o3', capture_client_id: 'cap-r', participant_id: 'p-2', participant_name: 'Chula' }),
      obs({ id: 'o4', capture_client_id: 'other', participant_id: 'p-2', participant_name: 'Chula' }),
    ]
    const vs = [
      verdict({ observation_id: 'o1', evaluator_email: 'ruth@x.org' }), // on her own
      verdict({ observation_id: 'o4', evaluator_email: 'ruth@x.org', decision: 'reject' }), // on another's
    ]
    const ruth = evaluatorAnalytics(prep(observations, evals), vs, evals, acts).find(
      (e) => e.evaluator === 'ruth@x.org',
    )!
    expect(ruth.topParticipants[0]).toMatchObject({ participant_name: 'Amos', n: 2 })
    expect(ruth.activities[0]).toMatchObject({ title: 'Internalization', n: 3 })
    expect(ruth.verdicts).toEqual({ confirm: 1, adjust: 0, reject: 1, total: 2 })
    expect(ruth.verdictsOnOthers).toBe(1)
  })
})

describe('ksaAnalytics', () => {
  const ksas = [ksa('GENRE')]
  const people = [participant({ id: 'p-1', name: 'Amos' })]
  const teams = [team()]
  const acts = [activity({ id: 'act-1', day: '2026-08-26' }), activity({ id: 'act-2', day: '2026-08-27' })]
  const evals = [
    evaluation({ client_id: 'cap-1', activity_id: 'act-1' }),
    evaluation({ client_id: 'cap-2', activity_id: 'act-2' }),
  ]

  it('separates the representative mean from the observed mean', () => {
    // One participant with observations [1, 3]: representative is 3 (the max
    // rule), but the observations themselves average 2. Both are true; the
    // dashboard must not silently pick one.
    const observations = [
      obs({ capture_client_id: 'cap-1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 }),
      obs({ capture_client_id: 'cap-1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
    ]
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports(people, ksas, annotated, teams)
    const [k] = ksaAnalytics(ksas, people, reports, prep(observations, evals), acts)

    expect(k.representative.n).toBe(1)
    expect(k.representative.max).toBe(3)
    expect(k.observed.n).toBe(2)
    expect(k.observed.mean).toBe(2)
    expect(k.conflictCount).toBe(1)
  })

  it('builds byDay chronologically off Activity.day and omits empty days', () => {
    const observations = [
      obs({ capture_client_id: 'cap-2', ksa_code: 'GENRE', evidence_designation: 3 }),
      obs({ capture_client_id: 'cap-1', ksa_code: 'GENRE', evidence_designation: 1 }),
    ]
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports(people, ksas, annotated, teams)
    const [k] = ksaAnalytics(ksas, people, reports, prep(observations, evals), acts)
    expect(k.byDay.map((d) => d.day)).toEqual(['2026-08-26', '2026-08-27'])
    expect(k.byDay[0].stats.n).toBe(1)
  })

  it('falls back to the capture date when the activity has no day', () => {
    const dayless = [activity({ id: 'act-1', day: null })]
    const evs = [
      evaluation({ client_id: 'cap-1', activity_id: 'act-1', created_at: '2026-09-02T08:00:00.000Z' }),
    ]
    const observations = [obs({ capture_client_id: 'cap-1', ksa_code: 'GENRE' })]
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports(people, ksas, annotated, teams)
    const [k] = ksaAnalytics(ksas, people, reports, prep(observations, evs), dayless)
    expect(k.byDay.map((d) => d.day)).toEqual(['2026-09-02'])
  })
})

describe('buildHeatmap', () => {
  const ksas = [ksa('GENRE'), ksa('EXEG')]
  const teams = [team()]

  const matrixFor = (observations: ReturnType<typeof obs>[], people: ReturnType<typeof participant>[], sort?: 'weakest') => {
    const annotated = annotateObservations(observations, [])
    const reports = buildAllReports(people, ksas, annotated, teams)
    return { reports, matrix: buildHeatmap(reports, ksas, sort ? { sort } : undefined) }
  }

  it('leaves a cell null where there is no evidence, rather than zero', () => {
    const { matrix } = matrixFor(
      [obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2 })],
      [participant({ id: 'p-1' })],
    )
    expect(matrix.cells[0][0].value).toBe(2)
    expect(matrix.cells[0][1].value).toBeNull()
  })

  it('propagates the conflict flag from the rollup', () => {
    const { matrix } = matrixFor(
      [
        obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 }),
        obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
      ],
      [participant({ id: 'p-1' })],
    )
    expect(matrix.cells[0][0].conflict).toBe(true)
    expect(matrix.cells[0][0].contributing).toBe(2)
  })

  it("sorts 'weakest' by count of at-risk cells, not by mean", () => {
    // Wide has two at-risk cells; Deep has one lower cell but only one at risk.
    const people = [participant({ id: 'p-deep', name: 'Deep' }), participant({ id: 'p-wide', name: 'Wide' })]
    const { matrix } = matrixFor(
      [
        obs({ participant_id: 'p-deep', ksa_code: 'GENRE', evidence_designation: 0 }),
        obs({ participant_id: 'p-deep', ksa_code: 'EXEG', evidence_designation: 3 }),
        obs({ participant_id: 'p-wide', ksa_code: 'GENRE', evidence_designation: 1 }),
        obs({ participant_id: 'p-wide', ksa_code: 'EXEG', evidence_designation: 1 }),
      ],
      people,
      'weakest',
    )
    expect(matrix.rows.map((r) => r.name)).toEqual(['Wide', 'Deep'])
  })

  it('agrees with ksaAnalytics on every column mean', () => {
    // The invariant that stops the heatmap and the KSA table from ever
    // disagreeing about the same number.
    const people = [participant({ id: 'p-1', name: 'A' }), participant({ id: 'p-2', name: 'B' })]
    const observations = [
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 }),
      obs({ participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3 }),
      obs({ participant_id: 'p-2', ksa_code: 'GENRE', evidence_designation: 2 }),
      obs({ participant_id: 'p-2', ksa_code: 'EXEG', evidence_designation: 0 }),
    ]
    const { reports, matrix } = matrixFor(observations, people)
    const analytics = ksaAnalytics(ksas, people, reports, prep(observations), [])
    matrix.cols.forEach((col, i) => {
      expect(col.colStats.mean).toBe(analytics[i].representative.mean)
      expect(col.colStats.n).toBe(analytics[i].representative.n)
    })
  })
})

describe('workbenchSummary', () => {
  const ksas = [ksa('GENRE')]
  const people = [participant({ id: 'p-1' })]
  const teams = [team()]

  it('counts ready gates, pipeline gaps, and open discrepancies only', () => {
    const observations = [
      obs({ id: 'o1', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 2 }),
    ]
    const vs = [
      verdict({ observation_id: 'o1', evaluator_email: 'a@x.org' }),
      verdict({ observation_id: 'o1', evaluator_email: 'b@x.org' }),
    ]
    const annotated = annotateObservations(observations, vs)
    const reports = buildAllReports(people, ksas, annotated, teams)
    const evals = [
      evaluation({ client_id: 'cap-1', routing_status: 'routed' }),
      evaluation({ client_id: 'cap-2', routing_status: 'sent' }),
    ]
    const s = workbenchSummary({
      reports,
      gates: gatesFor(reports),
      situated: situate(annotated, buildCaptureIndex(evals)),
      discrepancies: [
        { participant_id: 'p-1', participant_name: 'A', ksa_code: 'GENRE', lo: 1, hi: 3, timeGapNote: null, contributing: [] } as never,
      ],
      resolutions: [],
      conversations: [],
      evaluations: evals,
    })
    expect(s.reportsReady).toBe(1)
    expect(s.reportsLocked).toBe(0)
    expect(s.capturesNotRouted).toBe(1)
    expect(s.openDiscrepancies).toBe(1)
  })

  it('drops a discrepancy once it has been resolved', () => {
    const annotated = annotateObservations([obs({ participant_id: 'p-1' })], [])
    const reports = buildAllReports(people, ksas, annotated, teams)
    const s = workbenchSummary({
      reports,
      gates: gatesFor(reports),
      situated: situate(annotated, buildCaptureIndex([])),
      discrepancies: [
        { participant_id: 'p-1', participant_name: 'A', ksa_code: 'GENRE', lo: 1, hi: 3, timeGapNote: null, contributing: [] } as never,
      ],
      resolutions: [{ id: discrepancyId('p-1', 'GENRE') } as never],
      conversations: [],
      evaluations: [],
    })
    expect(s.openDiscrepancies).toBe(0)
  })
})
