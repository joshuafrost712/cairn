// Report rollup — pure functions, no Dexie/IO, so they are easy to test and reuse.
// Turns the flat per-individual observations into a per-participant evidence report:
// one rollup per KSA (representative 0–3 + the evidence behind it + conflict/verify
// flags), plus a CBC sub-point view (the bridge to the eventual CBC export).
//
// Aggregation rules (deliberately conservative and human-checkable):
//  - Only observations with needs_review === false COUNT toward a designation; the
//    flagged ones are surfaced separately "to verify" and never silently move a score.
//  - The representative designation is the MAX of the counting designations, because
//    a KSA is demonstrated by the best evidence of it; every report shows the quotes
//    behind the number so it can be audited.
//  - A spread of 2+ across counting designations is flagged as conflicting evidence
//    for a human to resolve (e.g. strong personal skill but weak facilitation).

import type { Ksa, ObservationRecord, Participant, Team } from '../lib/types'

// The rollup reads two optional fields that the verification layer attaches
// (src/reports/verification.ts → AnnotatedObservation). When absent (the draft,
// pre-verification view) behavior is unchanged: needs_review items are set aside
// and the original designation is used. When present, a verified/adjusted item
// counts (at its effective designation) even if routing flagged it, and a disputed
// item is set aside.
type MaybeAnnotated = ObservationRecord & { vstatus?: string; effective_designation?: number }

function isSetAside(o: ObservationRecord): boolean {
  const a = o as MaybeAnnotated
  if (a.vstatus === 'disputed') return true
  if (a.vstatus === 'verified' || a.vstatus === 'adjusted') return false
  return o.needs_review
}

function designationOf(o: ObservationRecord): number {
  const a = o as MaybeAnnotated
  return a.effective_designation ?? o.evidence_designation
}

export interface KsaRollup<T extends ObservationRecord = ObservationRecord> {
  ksa_code: string
  area: string
  representative: number | null // null = no counting evidence yet
  designations: number[] // counting designations, ascending
  conflict: boolean
  cbc_subpoint_refs: string[]
  contributing: T[] // counting evidence (needs_review === false)
  toVerify: T[] // needs_review === true
}

export interface CbcRollup {
  subpoint: string
  entries: { ksa_code: string; representative: number | null }[]
}

export interface ParticipantReport<T extends ObservationRecord = ObservationRecord> {
  participant_id: string
  participant_name: string
  team_name: string | null
  ksaRollups: KsaRollup<T>[]
  cbc: CbcRollup[]
  totals: { evidencedKsas: number; totalKsas: number; needsReviewCount: number }
}

/** Build one participant's report across all workshop KSAs. */
export function buildParticipantReport<T extends ObservationRecord>(
  participant: Participant,
  ksas: Ksa[],
  observations: T[],
  teams: Team[],
): ParticipantReport<T> {
  const mine = observations.filter((o) => o.participant_id === participant.id)
  const byCode = new Map<string, T[]>()
  for (const o of mine) {
    const list = byCode.get(o.ksa_code) ?? []
    list.push(o)
    byCode.set(o.ksa_code, list)
  }

  const ksaRollups: KsaRollup<T>[] = ksas.map((k) => {
    const obs = byCode.get(k.code) ?? []
    const contributing = obs.filter((o) => !isSetAside(o))
    const toVerify = obs.filter((o) => isSetAside(o))
    const designations = contributing.map((o) => designationOf(o)).sort((a, b) => a - b)
    const representative = designations.length ? Math.max(...designations) : null
    const conflict = designations.length > 1 && designations[designations.length - 1] - designations[0] >= 2
    return {
      ksa_code: k.code,
      area: k.area,
      representative,
      designations,
      conflict,
      cbc_subpoint_refs: k.cbc_subpoint_refs,
      contributing,
      toVerify,
    }
  })

  // CBC sub-point view: gather KSA representatives under each referenced sub-point.
  const cbcMap = new Map<string, { ksa_code: string; representative: number | null }[]>()
  for (const r of ksaRollups) {
    for (const sub of r.cbc_subpoint_refs) {
      const list = cbcMap.get(sub) ?? []
      list.push({ ksa_code: r.ksa_code, representative: r.representative })
      cbcMap.set(sub, list)
    }
  }
  const cbc: CbcRollup[] = [...cbcMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([subpoint, entries]) => ({ subpoint, entries }))

  const teamName = teams.find((t) => t.id === participant.team_id)?.name ?? null
  return {
    participant_id: participant.id,
    participant_name: participant.name,
    team_name: teamName,
    ksaRollups,
    cbc,
    totals: {
      evidencedKsas: ksaRollups.filter((r) => r.representative !== null).length,
      totalKsas: ksas.length,
      needsReviewCount: ksaRollups.reduce((n, r) => n + r.toVerify.length, 0),
    },
  }
}

/** Reports for every participant who has at least one observation, plus the roster order. */
export function buildAllReports<T extends ObservationRecord>(
  participants: Participant[],
  ksas: Ksa[],
  observations: T[],
  teams: Team[],
): ParticipantReport<T>[] {
  return participants.map((p) => buildParticipantReport(p, ksas, observations, teams))
}

/** Observations whose participant could not be resolved — need human attribution. */
export function unattributedObservations(observations: ObservationRecord[]): ObservationRecord[] {
  return observations.filter((o) => o.participant_id === null)
}
