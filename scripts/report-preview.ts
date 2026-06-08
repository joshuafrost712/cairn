// Preview participant reports from routing/outbox/*.json without the browser:
// loads the routed observations + the seed roster/KSAs and prints the report
// markdown. Useful for sanity-checking the route -> report pipeline headlessly.
//
//   npx tsx scripts/report-preview.ts

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { seedKsas, seedParticipants, seedTeams, seedWorkshops } from '../src/data/seed'
import type { ObservationsFile } from '../src/ai/workspace'
import { validateObservation } from '../src/ai/contract'
import { buildAllReports } from '../src/reports/build'
import { renderParticipantReportMarkdown } from '../src/reports/markdown'
import type { ObservationRecord } from '../src/lib/types'

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
const reports = buildAllReports(seedParticipants, ksas, observations, seedTeams)
const today = new Date().toISOString().slice(0, 10)

for (const r of reports.filter((x) => x.totals.evidencedKsas > 0)) {
  console.log('\n' + '='.repeat(78) + '\n')
  console.log(renderParticipantReportMarkdown(r, seedWorkshops[0].name, today))
}
console.log('\n' + '='.repeat(78))
console.log(`Built ${reports.filter((r) => r.totals.evidencedKsas > 0).length} report(s) from ${observations.length} observation(s).`)
