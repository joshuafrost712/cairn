// Verify routing/outbox/*.json against the contract and their inbox captures
// before importing. Catches schema drift, out-of-scope KSA codes, and unmatched
// participant ids in Claude's routed output.
//
//   npx tsx scripts/routing-verify.ts

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { validateObservation } from '../src/ai/contract'
import { seedParticipants } from '../src/data/seed'
import type { CaptureFile, ObservationsFile } from '../src/ai/workspace'

const rosterIds = new Set(seedParticipants.map((p) => p.id))
let problems = 0
let totalObs = 0
let totalReview = 0

const dir = 'routing/outbox'
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
if (files.length === 0) console.log('No outbox files to verify.')

for (const name of files) {
  const out = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as ObservationsFile
  const inboxPath = `routing/inbox/${name}`
  if (!existsSync(inboxPath)) {
    console.log(`✗ ${name}: no matching inbox capture`)
    problems++
    continue
  }
  const capture = JSON.parse(readFileSync(inboxPath, 'utf8')) as CaptureFile
  const scopeCodes = new Set(capture.ksas_in_scope.map((k) => k.code))

  const issues: string[] = []
  out.observations.forEach((o, i) => {
    totalObs++
    const v = validateObservation(o)
    if (!v.ok) {
      issues.push(`  obs[${i}]: invalid (${v.reason})`)
      return
    }
    if (v.value.needs_review) totalReview++
    if (!scopeCodes.has(v.value.ksa_code)) issues.push(`  obs[${i}]: ksa_code ${v.value.ksa_code} not in activity scope`)
    if (v.value.participant_id && !rosterIds.has(v.value.participant_id))
      issues.push(`  obs[${i}]: participant_id not in roster`)
    if (v.value.participant_id === null && !v.value.needs_review)
      issues.push(`  obs[${i}]: unmatched participant but needs_review is false`)
  })

  if (issues.length) {
    console.log(`✗ ${name} (${out.observations.length} obs)`)
    issues.forEach((m) => console.log(m))
    problems += issues.length
  } else {
    const review = out.observations.filter((o) => o.needs_review).length
    console.log(`✓ ${name}: ${out.observations.length} obs ok${review ? `, ${review} need review` : ''}`)
  }
}

console.log(`\n${files.length} file(s), ${totalObs} observation(s), ${totalReview} flagged for review, ${problems} problem(s).`)
process.exit(problems > 0 ? 1 : 0)
