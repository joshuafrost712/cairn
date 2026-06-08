// Calibration harness (brief step 6, start of). Runs synthetic field-like
// evaluations through the routing layer and prints the structured observations,
// so prompts + the input ruleset can be tuned against expert judgment before
// any live use. Per-call cost is logged to calibration-log.jsonl and a spend cap
// is enforced.
//
// Run:  ANTHROPIC_API_KEY=sk-... npx tsx scripts/calibrate.ts
// Cap:  CLAUDE_SPEND_CAP_USD=2 (default 5)

import Anthropic from '@anthropic-ai/sdk'
import { appendFileSync } from 'node:fs'
import { seedParticipants } from '../src/data/seed'
import { routeEvaluation } from '../src/ai/route'
import { CostGuard, type CallLogEntry } from '../src/ai/cost'
import { SYNTHETIC_EVALUATIONS, ksasForActivitySortOrder } from '../src/ai/synthetic'

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Set ANTHROPIC_API_KEY to run the calibration harness.\n' +
        'Everything else (prompt, schema, cost guard, synthetic data) is wired and type-checks;\n' +
        'this script only needs a key to make live routing calls.',
    )
    process.exit(1)
  }

  const client = new Anthropic()
  const capUSD = Number(process.env.CLAUDE_SPEND_CAP_USD ?? '5')
  const logPath = 'calibration-log.jsonl'
  const guard = new CostGuard(capUSD, (e: CallLogEntry) => {
    appendFileSync(logPath, JSON.stringify(e) + '\n')
    console.log(`  [cost] $${e.costUSD.toFixed(4)} (cumulative $${guard.spentUSD.toFixed(4)} / $${capUSD})`)
  })

  for (const ev of SYNTHETIC_EVALUATIONS) {
    const ksas = ksasForActivitySortOrder(ev.activitySortOrder)
    console.log('\n' + '='.repeat(72))
    console.log(`Activity #${ev.activitySortOrder} · KSAs: ${ksas.map((k) => k.code).join(', ')}`)
    console.log(`Scope: ${ev.participantScopeNames.join(', ')}`)
    console.log(`Expectation: ${ev.note}`)
    console.log(`Input: ${ev.text}`)

    const { observations } = await routeEvaluation(
      client,
      { evaluationText: ev.text, participantScopeNames: ev.participantScopeNames, ksas, participants: seedParticipants },
      guard,
      `activity-${ev.activitySortOrder}`,
    )

    console.log(`\nRouted ${observations.length} observation(s):`)
    for (const o of observations) {
      const flag = o.needs_review ? ' ⚠ needs_review' : ''
      console.log(
        `  • ${o.participant_name} [${o.ksa_code}] = ${o.evidence_designation} ` +
          `(${o.sentiment_flag}, ${o.confidence}, ${o.origin})${flag}\n    ${o.text}`,
      )
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log(`Done. Total spend: $${guard.spentUSD.toFixed(4)}. Per-call log: ${logPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
