// Golden test against the realistic fixture.
//
// The unit tests in analytics.test.ts pin each function on hand-built input. This
// one runs the whole chain over src/data/demoScenario.ts — the same records the
// app seeds behind Admin's "Load demo scenario" button — and asserts the four
// paths its header comment promises land where they should. That catches a class
// of join and attribution bugs hand-built fixtures never will, because the demo
// data has the awkward shapes real data has: several evaluators per participant,
// a conflict five hours apart, and captures spread across three activities.
//
// If this file fails after a change to demoScenario.ts, check the scenario's own
// header comment first: the two are meant to describe the same thing.

import { describe, it, expect } from 'vitest'
import { buildDemoRecords } from '../src/data/demoScenario'
import { seedActivities, seedKsas, seedParticipants, seedTeams } from '../src/data/seed'
import { annotateObservations, participantGate } from '../src/reports/verification'
import type { Gate } from '../src/reports/verification'
import { buildAllReports } from '../src/reports/build'
import { buildCaptureTimeMap, findDiscrepancies } from '../src/reports/discrepancy'
import {
  activityAnalytics,
  attributionHealth,
  buildCaptureIndex,
  buildHeatmap,
  evaluatorAnalytics,
  flagParticipants,
  ksaAnalytics,
  situate,
  workbenchSummary,
} from '../src/reports/analytics'

const AMOS = 'Amos Khokhar'

function pipeline() {
  const { evaluations, observations, verdicts } = buildDemoRecords()
  const annotated = annotateObservations(observations, verdicts)
  const situated = situate(annotated, buildCaptureIndex(evaluations))
  const ksas = [...seedKsas].sort((a, b) => a.code.localeCompare(b.code))
  const reports = buildAllReports(seedParticipants, ksas, annotated, seedTeams)
  const gates = new Map<string, Gate>()
  for (const r of reports) {
    gates.set(
      r.participant_id,
      participantGate(r.ksaRollups.flatMap((k) => [...k.contributing, ...k.toVerify])),
    )
  }
  return { evaluations, observations, verdicts, annotated, situated, ksas, reports, gates }
}

describe('demo scenario end to end', () => {
  it('attributes every observation to a capture and an activity', () => {
    // Every demo observation's capture is seeded alongside it, so nothing should
    // orphan. If this ever fails, the per-event dashboard is silently dropping rows.
    const { situated } = pipeline()
    const h = attributionHealth(situated)
    expect(h.total).toBeGreaterThan(0)
    expect(h.orphanedCaptures).toEqual([])
    expect(h.withActivity).toBe(h.total)
    expect(h.unattributedParticipant).toBe(0)
  })

  it('path 1: the confirmed 0/3 on EXEG flags Amos', () => {
    const { reports, gates } = pipeline()
    const flags = flagParticipants(reports, gates)
    const amos = flags.find((f) => f.participant_name === AMOS)
    expect(amos).toBeDefined()
    expect(amos!.reasons).toContainEqual({ kind: 'low_representative', ksa_code: 'EXEG', value: 0 })
    expect(amos!.lowestRepresentative).toBe(0)
  })

  it('path 2: the twin 3/3s on GENRE are consensus, not a flag', () => {
    const { reports } = pipeline()
    const amos = reports.find((r) => r.participant_name === AMOS)!
    const genre = amos.ksaRollups.find((k) => k.ksa_code === 'GENRE')!
    expect(genre.representative).toBe(3)
    expect(genre.conflict).toBe(false)
    expect(genre.contributing).toHaveLength(2)
  })

  it('path 3: the CLAT 1-vs-3 disagreement is a conflict and an open discrepancy', () => {
    const { reports, gates, evaluations, situated } = pipeline()
    const amos = reports.find((r) => r.participant_name === AMOS)!
    const clat = amos.ksaRollups.find((k) => k.ksa_code === 'CLAT')!
    expect(clat.conflict).toBe(true)
    expect(clat.designations[0]).toBe(1)
    expect(clat.designations[clat.designations.length - 1]).toBe(3)

    const flags = flagParticipants(reports, gates)
    expect(flags.find((f) => f.participant_name === AMOS)!.reasons).toContainEqual({
      kind: 'conflict',
      ksa_code: 'CLAT',
      lo: 1,
      hi: 3,
    })

    const discrepancies = findDiscrepancies(reports, buildCaptureTimeMap(evaluations))
    const clatDisc = discrepancies.find((d) => d.ksa_code === 'CLAT')
    expect(clatDisc).toBeDefined()

    const summary = workbenchSummary({
      reports,
      gates,
      situated,
      discrepancies,
      resolutions: [],
      conversations: [],
      evaluations,
    })
    expect(summary.openDiscrepancies).toBeGreaterThanOrEqual(1)
  })

  it('path 4: the late CHECK 0/3 lands on its own activity, not on the earlier ones', () => {
    const { situated, ksas, evaluations } = pipeline()
    const checkObs = situated.filter((o) => o.ksa_code === 'CHECK')
    expect(checkObs.length).toBeGreaterThan(0)
    const checkActivity = checkObs[0].activity_id!

    const analytics = activityAnalytics(
      seedActivities.find((a) => a.id === checkActivity)!,
      ksas,
      situated,
      evaluations,
    )
    const cell = analytics.perKsa.find((k) => k.ksa_code === 'CHECK')!
    expect(cell.stats.min).toBe(0)
    expect(analytics.flagged.some((f) => f.participant_name === AMOS)).toBe(true)

    // The EXEG 0 belongs to a DIFFERENT activity and must not leak into this one.
    const otherActivities = seedActivities.filter((a) => a.id !== checkActivity)
    for (const a of otherActivities) {
      const other = activityAnalytics(a, ksas, situated, evaluations)
      expect(other.perKsa.find((k) => k.ksa_code === 'CHECK')!.stats.n).toBe(0)
    }
  })

  it("Amos's heatmap row is the weakest, and column means agree with ksaAnalytics", () => {
    const { reports, ksas, situated } = pipeline()
    const matrix = buildHeatmap(reports, ksas, { sort: 'weakest' })
    expect(matrix.rows[0].name).toBe(AMOS)

    const analytics = ksaAnalytics(ksas, seedParticipants, reports, situated, seedActivities)
    matrix.cols.forEach((col, i) => {
      expect(col.ksa_code).toBe(analytics[i].ksa_code)
      expect(col.colStats.mean).toBe(analytics[i].representative.mean)
    })
  })

  it('the KSA view separates representative from observed on the conflicted CLAT', () => {
    const { reports, ksas, situated } = pipeline()
    const clat = ksaAnalytics(ksas, seedParticipants, reports, situated, seedActivities).find(
      (k) => k.ksa_code === 'CLAT',
    )!
    // representative = max(1, 3) = 3 over one participant; observed keeps both.
    expect(clat.representative.n).toBe(1)
    expect(clat.representative.max).toBe(3)
    expect(clat.observed.n).toBe(2)
    expect(clat.observed.min).toBe(1)
    expect(clat.conflictCount).toBe(1)
  })

  it('the demo facilitators who disagreed show a paired difference, suppressed for low overlap', () => {
    const { situated, verdicts, evaluations } = pipeline()
    const evaluators = evaluatorAnalytics(situated, verdicts, evaluations, seedActivities)
    expect(evaluators.length).toBeGreaterThan(1)

    // Every demo evaluator observes only a handful of cells, so the delta must be
    // suppressed rather than reported. Early in a real workshop this is the
    // normal state, which is why the empty case is the one worth pinning.
    for (const e of evaluators) {
      if (e.leniency.pairedCells < 5) {
        expect(e.leniency.delta).toBeNull()
        expect(e.leniency.suppressed).toBe('insufficient_overlap')
      }
    }

    // The CLAT pair did disagree, so the cell itself is on the record with a
    // non-zero difference even though the aggregate delta is withheld.
    const withClat = evaluators.filter((e) => e.leniency.cells.some((c) => c.ksa_code === 'CLAT'))
    expect(withClat.length).toBe(2)
    for (const e of withClat) {
      const cell = e.leniency.cells.find((c) => c.ksa_code === 'CLAT')!
      expect(Math.abs(cell.mine - cell.others)).toBe(2)
    }
  })
})
