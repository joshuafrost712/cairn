// The safety net for the segment refactor.
//
// Two jobs. The snapshots freeze the rendered markdown byte for byte across five
// fixtures, which is what proved the refactor changed nothing: the same fixtures
// were rendered by the pre-refactor line-pushing code and matched exactly. The
// structural tests below cover what a snapshot cannot see, which is whether the
// ids are stable and whether each line carries the right evidence.

import { describe, it, expect } from 'vitest'
import { buildAllReports } from '../src/reports/build'
import { buildDayEmailSegments, renderDayEmailMarkdown } from '../src/reports/dayEmail'
import { buildParticipantReportSegments, renderParticipantReportMarkdown } from '../src/reports/markdown'
import { segmentsToMarkdown } from '../src/reports/segments'
import { annotateObservations, participantGate, type Gate } from '../src/reports/verification'
import { fixtures } from './fixtures/documents'
import { ksa, obs, participant, team } from './factories'

function pipeline(f: (typeof fixtures)[number]) {
  const annotated = annotateObservations(f.observations, f.verdicts)
  const reports = buildAllReports(f.participants, f.ksas, annotated, f.teams)
  const gates = new Map<string, Gate>(
    f.participants.map((p) => [p.id, participantGate(annotated.filter((o) => o.participant_id === p.id))]),
  )
  return { annotated, reports, gates }
}

describe('rendered output is frozen', () => {
  for (const f of fixtures) {
    it(`day email: ${f.name}`, () => {
      const { reports, gates } = pipeline(f)
      expect(renderDayEmailMarkdown(reports, gates, 'Psalms Workshop', '2026-06-29', f.dayOpts)).toMatchSnapshot()
    })

    it(`participant report: ${f.name}`, () => {
      const { reports, gates } = pipeline(f)
      const out = reports.map((r) =>
        renderParticipantReportMarkdown(
          r,
          'Psalms Workshop',
          '2026-06-29',
          f.withGate ? gates.get(r.participant_id) : undefined,
        ),
      )
      expect(out).toMatchSnapshot()
    })
  }
})

describe('segments and markdown are the same document', () => {
  for (const f of fixtures) {
    it(`round-trips: ${f.name}`, () => {
      const { reports, gates } = pipeline(f)
      expect(segmentsToMarkdown(buildDayEmailSegments(reports, gates, 'W', 'D', f.dayOpts))).toBe(
        renderDayEmailMarkdown(reports, gates, 'W', 'D', f.dayOpts),
      )
      for (const r of reports) {
        expect(segmentsToMarkdown(buildParticipantReportSegments(r, 'W', 'D'))).toBe(
          renderParticipantReportMarkdown(r, 'W', 'D'),
        )
      }
    })
  }
})

describe('segment ids', () => {
  it('are unique within a document, including when a KSA is both a highlight and a conflict', () => {
    const f = fixtures.find((x) => x.name === 'conflict in both sections')!
    const { reports, gates } = pipeline(f)
    const segs = buildDayEmailSegments(reports, gates, 'W', 'D')
    const ids = segs.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)

    // The specific collision this guards: GENRE for p-1 has representative 3 and
    // conflict true, so its strongest observation is rendered twice.
    const genreEvidence = segs.filter((s) => s.ksaCode === 'GENRE' && s.evidence.includes('o-2'))
    expect(genreEvidence.length).toBeGreaterThan(1)
    expect(new Set(genreEvidence.map((s) => s.id)).size).toBe(genreEvidence.length)
  })

  it('are unaffected when an unrelated participant gains an observation', () => {
    const ksas = [ksa('GENRE', { area: 'Genre Theory' })]
    const people = [participant({ id: 'p-1', name: 'One' }), participant({ id: 'p-2', name: 'Two' })]
    const teams = [team()]
    const base = [obs({ id: 'a', participant_id: 'p-1', evidence_designation: 3 })]
    const added = [...base, obs({ id: 'b', participant_id: 'p-2', evidence_designation: 2 })]

    const idsFor = (observations: typeof base) => {
      const annotated = annotateObservations(observations, [])
      const reports = buildAllReports(people, ksas, annotated, teams)
      const gates = new Map<string, Gate>()
      return buildDayEmailSegments(reports, gates, 'W', 'D')
        .filter((s) => s.participantId === 'p-1')
        .map((s) => s.id)
    }

    // Participant One's ids must be identical before and after. With
    // index-derived ids they would all shift by the number of rows Two added.
    expect(idsFor(added)).toEqual(idsFor(base))
  })

  it('all carry the version prefix', () => {
    const f = fixtures.find((x) => x.name === 'one highlight')!
    const { reports, gates } = pipeline(f)
    for (const s of buildDayEmailSegments(reports, gates, 'W', 'D')) {
      expect(s.id.startsWith('v1/')).toBe(true)
    }
  })
})

describe('evidence attribution', () => {
  it('a claim carries every counting observation, because it asserts the max over all of them', () => {
    const f = fixtures.find((x) => x.name === 'conflict in both sections')!
    const { reports, gates } = pipeline(f)
    const segs = buildDayEmailSegments(reports, gates, 'W', 'D')
    const claim = segs.find((s) => s.id.endsWith('/hl/k:GENRE/claim'))!
    expect(claim.evidence.sort()).toEqual(['o-2', 'o-3'])
  })

  it('an evidence bullet carries exactly its own observation', () => {
    const f = fixtures.find((x) => x.name === 'conflict in both sections')!
    const { reports, gates } = pipeline(f)
    for (const s of buildDayEmailSegments(reports, gates, 'W', 'D')) {
      if (s.kind === 'evidence') expect(s.evidence.length).toBe(1)
    }
  })

  it('headings and boilerplate carry none', () => {
    const f = fixtures.find((x) => x.name === 'one highlight')!
    const { reports, gates } = pipeline(f)
    for (const s of buildDayEmailSegments(reports, gates, 'W', 'D')) {
      if (s.kind === 'heading') expect(s.evidence).toEqual([])
    }
  })

  it('the follow-up line carries precisely the observations at or below the threshold', () => {
    const f = fixtures.find((x) => x.name === 'gate locked')!
    const { reports, gates } = pipeline(f)
    const segs = buildDayEmailSegments(reports, gates, 'W', 'D')
    const fu = segs.find((s) => s.id.endsWith('/fu'))!
    // o-5 is a 1 (at the threshold), o-6 is a 2 (above it).
    expect(fu.evidence).toEqual(['o-5'])
    expect(fu.note).toContain('at or below 1/3')
  })

  it('a CBC bullet carries the evidence for every KSA on the line', () => {
    const f = fixtures.find((x) => x.name === 'gate locked')!
    const { reports } = pipeline(f)
    const segs = buildParticipantReportSegments(reports[0], 'W', 'D')
    // CHECK (o-5) and FACIL (o-6) both feed sub-points; the Exegesis line names CHECK.
    const exegesis = segs.find((s) => s.id.includes('/cbc/s:1.2 Exegesis'))!
    expect(exegesis.evidence).toContain('o-5')
  })
})

describe('editability', () => {
  it('leaves the verification line and the headings alone', () => {
    const f = fixtures.find((x) => x.name === 'gate locked')!
    const { reports, gates } = pipeline(f)
    const segs = buildDayEmailSegments(reports, gates, 'W', 'D')
    const gate = segs.find((s) => s.kind === 'meta')!
    // Typing "verified" over a locked gate would make the gate decorative, which
    // is the one thing the approval flow must not allow.
    expect(gate.editable).toBe(false)
    expect(segs.filter((s) => s.kind === 'heading').every((s) => !s.editable)).toBe(true)
    expect(segs.filter((s) => s.kind === 'evidence').every((s) => s.editable)).toBe(true)
  })
})
