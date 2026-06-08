// Demonstrate the multi-evaluator verification gate headlessly: load the routed
// observations, fabricate evaluator verdicts, and show the gate moving from locked
// to ready (and how a reject keeps it locked). Mirrors the route/report previews.
//
//   npx tsx scripts/gate-preview.ts

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { seedKsas, seedParticipants, seedTeams, seedWorkshops } from '../src/data/seed'
import type { ObservationsFile } from '../src/ai/workspace'
import { validateObservation } from '../src/ai/contract'
import { buildParticipantReport } from '../src/reports/build'
import { renderParticipantReportMarkdown } from '../src/reports/markdown'
import { annotateObservations, participantGate, REQUIRED_CONFIRMATIONS } from '../src/reports/verification'
import type { ObservationRecord, VerificationVerdict } from '../src/lib/types'

const dir = 'routing/outbox'
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
const observations: ObservationRecord[] = []
for (const name of files) {
  const out = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as ObservationsFile
  out.observations.forEach((raw, i) => {
    const v = validateObservation(raw)
    if (v.ok) observations.push({ id: `${out.capture_client_id}::${i}`, capture_client_id: out.capture_client_id, imported_at: 'preview', ...v.value })
  })
}

const ksas = [...seedKsas].sort((a, b) => a.code.localeCompare(b.code))
const citOne = seedParticipants.find((p) => p.name === 'CIT One')!
const citOneObs = observations.filter((o) => o.participant_id === citOne.id)
console.log(`Gate requires ${REQUIRED_CONFIRMATIONS} confirmations per observation.`)
console.log(`CIT One has ${citOneObs.length} observations: ${citOneObs.map((o) => `${o.ksa_code} ${o.evidence_designation}/3${o.needs_review ? '*' : ''}`).join(', ')}\n`)

const v = (obsId: string, email: string, decision: VerificationVerdict['decision'], adj?: 0 | 1 | 2 | 3): VerificationVerdict => ({
  id: `${obsId}::${email}`,
  observation_id: obsId,
  capture_client_id: obsId.split('::')[0],
  evaluator_email: email,
  decision,
  adjusted_designation: decision === 'adjust' ? (adj ?? null) : null,
  note: null,
  at: '2026-06-08T21:00:00.000Z',
})

const ids = { genre: 'synthetic-a1-1::0', aesth: 'synthetic-a1-1::1', check: 'synthetic-a6-3::0' }

function show(label: string, verdicts: VerificationVerdict[]) {
  const annotated = annotateObservations(citOneObs, verdicts)
  const g = participantGate(annotated)
  const detail = annotated.map((o) => `${o.ksa_code}=${o.vstatus}(${o.effective_designation}/3)`).join(', ')
  console.log(`${label}\n  gate: ${g.status.toUpperCase()} — ${g.verified}/${g.total} verified, ${g.pending} pending, ${g.disputed} disputed\n  obs: ${detail}\n`)
  return annotated
}

show('1) No verdicts:', [])
show('2) Only evaluator A confirms all three:', [v(ids.genre, 'a', 'confirm'), v(ids.check, 'a', 'confirm'), v(ids.aesth, 'a', 'confirm')])
show('3) Evaluator B rejects the AESTH stretch:', [
  v(ids.genre, 'a', 'confirm'), v(ids.genre, 'b', 'confirm'),
  v(ids.check, 'a', 'confirm'), v(ids.check, 'b', 'confirm'),
  v(ids.aesth, 'a', 'confirm'), v(ids.aesth, 'b', 'reject'),
])
const ready = [
  v(ids.genre, 'a', 'confirm'), v(ids.genre, 'b', 'confirm'),
  v(ids.check, 'a', 'confirm'), v(ids.check, 'b', 'confirm'),
  v(ids.aesth, 'a', 'adjust', 1), v(ids.aesth, 'b', 'adjust', 1),
]
show('4) Both evaluators confirm GENRE+CHECK and agree to adjust AESTH to 1:', ready)

console.log('='.repeat(78))
console.log('Finalized report markdown for scenario 4 (gate ready):\n')
const annotated = annotateObservations(observations, ready)
const report = buildParticipantReport(citOne, ksas, annotated, seedTeams)
const gate = participantGate(annotated.filter((o) => o.participant_id === citOne.id))
console.log(renderParticipantReportMarkdown(report, seedWorkshops[0].name, '2026-06-08', gate))
