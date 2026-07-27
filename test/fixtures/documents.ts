// Five document fixtures that between them exercise every branch in the two
// renderers: the empty day, a clean highlight, the KSA that is a highlight AND a
// conflict at once, a gate that is not yet cleared, and a report with flagged
// items and unevidenced areas.
//
// Shared by the parity check and the frozen goldens so the two cannot disagree
// about what "the conflict fixture" means.

import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict } from '../../src/lib/types'
import type { DayEmailOptions } from '../../src/reports/dayEmail'
import { ksa, obs, participant, team, verdict } from '../factories'

export interface DocFixture {
  name: string
  participants: Participant[]
  ksas: Ksa[]
  teams: Team[]
  observations: ObservationRecord[]
  verdicts: VerificationVerdict[]
  dayOpts: DayEmailOptions
  /** Pass a gate into the participant report renderer. */
  withGate: boolean
}

const ksas = [
  ksa('GENRE', { id: 'k-genre', area: 'Genre Theory', cbc_subpoint_refs: ['1.2 Exegesis'] }),
  ksa('CHECK', { id: 'k-check', area: 'Checking', cbc_subpoint_refs: ['1.2 Exegesis', '3.1 Quality'] }),
  ksa('FACIL', { id: 'k-facil', area: 'Facilitation', cbc_subpoint_refs: ['2.4 Team'] }),
]
const p1 = participant({ id: 'p-1', name: 'CIT One', team_id: 't-1' })
const p2 = participant({ id: 'p-2', name: 'CIT Two', team_id: null })
const teams = [team({ id: 't-1', name: 'Team A' })]

export const fixtures: DocFixture[] = [
  {
    name: 'empty day',
    participants: [p1],
    ksas,
    teams,
    observations: [],
    verdicts: [],
    dayOpts: { fromName: 'Josh' },
    withGate: false,
  },
  {
    name: 'one highlight',
    participants: [p1],
    ksas,
    teams,
    observations: [
      obs({
        id: 'o-1',
        participant_id: 'p-1',
        ksa_code: 'GENRE',
        evidence_designation: 3,
        evaluator_email: 'josh@sil.org',
        sentiment_flag: 'strong',
        text: 'Named the genre and defended it',
        source_excerpt: 'This is a lament, and here is why',
      }),
    ],
    verdicts: [],
    dayOpts: { toName: 'team', fromName: 'Josh' },
    withGate: false,
  },
  {
    name: 'conflict in both sections',
    participants: [p1, p2],
    ksas,
    teams,
    // 3 and 1 on the same KSA: representative 3 (a highlight) AND conflict true
    // (reconciliation), with the same strongest observation under each. This is
    // the fixture that would have caught an id collision.
    observations: [
      obs({ id: 'o-2', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 3, evaluator_email: 'josh@sil.org' }),
      obs({ id: 'o-3', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1, evaluator_email: 'boss@sil.org' }),
      obs({
        id: 'o-4',
        participant_id: 'p-2',
        participant_name: 'CIT Two',
        ksa_code: 'CHECK',
        evidence_designation: 0,
        evaluator_email: null,
        origin: 'group',
        source_excerpt: null,
      }),
    ],
    verdicts: [],
    dayOpts: { fromName: 'Josh' },
    withGate: false,
  },
  {
    name: 'gate locked',
    participants: [p1],
    ksas,
    teams,
    observations: [
      obs({ id: 'o-5', participant_id: 'p-1', ksa_code: 'CHECK', evidence_designation: 1, evaluator_email: 'josh@sil.org' }),
      obs({ id: 'o-6', participant_id: 'p-1', ksa_code: 'FACIL', evidence_designation: 2, evaluator_email: 'ruth@sil.org' }),
    ],
    // One confirmation only, where two are required: the gate stays locked and
    // the day email prints its verification line.
    verdicts: [verdict({ observation_id: 'o-5', evaluator_email: 'ruth@sil.org', decision: 'confirm' })],
    dayOpts: { fromName: 'Josh' },
    withGate: true,
  },
  {
    name: 'flagged items and no sign-off',
    participants: [p1],
    ksas,
    teams,
    observations: [
      obs({
        id: 'o-7',
        participant_id: 'p-1',
        ksa_code: 'GENRE',
        evidence_designation: 2,
        needs_review: true,
        confidence: 'low',
        evaluator_email: 'josh@sil.org',
      }),
      obs({
        id: 'o-8',
        participant_id: 'p-1',
        ksa_code: 'CHECK',
        evidence_designation: 2,
        evaluator_email: 'josh@sil.org',
      }),
    ],
    verdicts: [
      // Both evaluators adjust to the same value, which is what it takes for the
      // observation to count at 3 rather than the recorded 2 and for the bullet
      // to print "(adjusted from 2)". An adjust plus a plain confirm would be a
      // disagreement, and observationStatus calls that disputed.
      verdict({
        observation_id: 'o-8',
        evaluator_email: 'ruth@sil.org',
        decision: 'adjust',
        adjusted_designation: 3,
      }),
      verdict({
        observation_id: 'o-8',
        evaluator_email: 'boss@sil.org',
        decision: 'adjust',
        adjusted_designation: 3,
      }),
    ],
    dayOpts: {},
    withGate: false,
  },
]
