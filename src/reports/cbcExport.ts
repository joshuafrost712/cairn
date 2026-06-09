// CBC competency-platform export (Phase 2). This is the *interchange* layer: it
// turns verified participant reports into a stable, documented shape (JSON + flat
// CSV) that the platform-specific submission adapter can consume. The adapter to the
// actual CBC platform is deferred until its import format is known — this side does
// not need it. Only verified/adjusted evidence drives designations (the report
// rollups are already verification-aware); each participant carries a `finalized`
// flag (gate ready) so the adapter can submit only cleared reports.

import type { ParticipantReport } from './build'
import type { AnnotatedObservation, Gate } from './verification'
import { toCsv } from './csv'

export interface CbcEvidence {
  ksa_code: string
  designation: number
  origin: 'individual' | 'group'
  text: string
  source_excerpt: string
}
export interface CbcKsaEntry {
  ksa_code: string
  area: string
  designation: number | null
  evidence: CbcEvidence[]
}
export interface CbcCompetency {
  subpoint: string
  designation: number | null // suggested rollup: max of the feeding KSAs' verified designations
  ksa_codes: string[]
  ksasWithEvidence: number
  ksasTotal: number
}
export interface CbcParticipant {
  participant_id: string
  participant_name: string
  team_name: string | null
  finalized: boolean
  gate: { verified: number; total: number; pending: number; disputed: number }
  ksas: CbcKsaEntry[]
  competencies: CbcCompetency[]
}
export interface CbcExport {
  schema: 'cairn.cbc-export/v1'
  workshop: { id: string | null; name: string | null }
  generated_at: string
  required_confirmations: number
  participants: CbcParticipant[]
}

const maxOrNull = (xs: (number | null)[]): number | null => {
  const present = xs.filter((x): x is number => x !== null)
  return present.length ? Math.max(...present) : null
}

export function buildCbcExport(
  reports: ParticipantReport<AnnotatedObservation>[],
  gateOf: (participantId: string) => Gate,
  opts: { workshop: { id: string | null; name: string | null }; generatedOn: string; requiredConfirmations: number; onlyFinalized?: boolean },
): CbcExport {
  const participants: CbcParticipant[] = []
  for (const r of reports) {
    const gate = gateOf(r.participant_id)
    const finalized = gate.status === 'ready'
    if (opts.onlyFinalized && !finalized) continue
    if (gate.total === 0) continue // no evidence at all

    const ksas: CbcKsaEntry[] = r.ksaRollups.map((k) => ({
      ksa_code: k.ksa_code,
      area: k.area,
      designation: k.representative,
      evidence: k.contributing.map((o) => ({
        ksa_code: k.ksa_code,
        designation: o.effective_designation,
        origin: o.origin,
        text: o.text,
        source_excerpt: o.source_excerpt,
      })),
    }))

    const competencies: CbcCompetency[] = r.cbc.map((c) => ({
      subpoint: c.subpoint,
      designation: maxOrNull(c.entries.map((e) => e.representative)),
      ksa_codes: c.entries.map((e) => e.ksa_code),
      ksasWithEvidence: c.entries.filter((e) => e.representative !== null).length,
      ksasTotal: c.entries.length,
    }))

    participants.push({
      participant_id: r.participant_id,
      participant_name: r.participant_name,
      team_name: r.team_name,
      finalized,
      gate: { verified: gate.verified, total: gate.total, pending: gate.pending, disputed: gate.disputed },
      ksas,
      competencies,
    })
  }

  return {
    schema: 'cairn.cbc-export/v1',
    workshop: opts.workshop,
    generated_at: opts.generatedOn,
    required_confirmations: opts.requiredConfirmations,
    participants,
  }
}

/** Flat one-row-per-(participant, KSA) CSV — easy to pivot or import. */
export function cbcKsaCsv(x: CbcExport): string {
  const rows = x.participants.flatMap((p) =>
    p.ksas.map((k) => [p.participant_name, p.team_name ?? '', p.finalized, k.ksa_code, k.area, k.designation, k.evidence.length]),
  )
  return toCsv(['participant', 'team', 'finalized', 'ksa_code', 'area', 'designation', 'evidence_count'], rows)
}

/** Flat one-row-per-(participant, CBC sub-point) CSV. */
export function cbcSubpointCsv(x: CbcExport): string {
  const rows = x.participants.flatMap((p) =>
    p.competencies.map((c) => [p.participant_name, p.team_name ?? '', p.finalized, c.subpoint, c.designation, `${c.ksasWithEvidence}/${c.ksasTotal}`]),
  )
  return toCsv(['participant', 'team', 'finalized', 'cbc_subpoint', 'designation', 'ksas_with_evidence'], rows)
}
