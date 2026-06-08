// Generate the GitHub routing workspace (routing/) from the contract + seed, so
// Claude (via Max) can route captures on the repo with no metered API.
//
//   npx tsx scripts/routing-prepare.ts             # (re)generate ROUTING.md + reference/
//   npx tsx scripts/routing-prepare.ts --synthetic # also seed inbox/ with synthetic captures
//
// After running with --synthetic: open Claude on this repo and say
// "route the inbox per routing/ROUTING.md", then inspect routing/outbox/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { seedKsas, seedParticipants, seedTeams, seedWorkshops, seedActivities } from '../src/data/seed'
import {
  renderRoutingDoc,
  renderRubricDoc,
  renderRosterDoc,
  renderSchemaJson,
  buildCaptureFile,
  inboxPath,
} from '../src/ai/workspace'
import { SYNTHETIC_EVALUATIONS, ksasForActivitySortOrder } from '../src/ai/synthetic'

const teamName = (id: string | null) => seedTeams.find((t) => t.id === id)?.name ?? 'n/a'

function write(path: string, contents: string) {
  const dir = path.split('/').slice(0, -1).join('/')
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(path, contents)
  console.log('  wrote', path)
}

console.log('Generating routing workspace...')
write('routing/ROUTING.md', renderRoutingDoc())
write('routing/reference/rubric.md', renderRubricDoc(seedKsas))
write('routing/reference/roster.md', renderRosterDoc(seedParticipants, teamName))
write('routing/reference/schema.json', renderSchemaJson())
write('routing/inbox/.gitkeep', '')
write('routing/outbox/.gitkeep', '')
write('routing/verdicts/.gitkeep', '') // app-managed: evaluators' verdicts, synced between devices

if (process.argv.includes('--synthetic')) {
  console.log('Seeding inbox with synthetic captures...')
  const workshop = seedWorkshops[0]
  SYNTHETIC_EVALUATIONS.forEach((ev, i) => {
    const activity = seedActivities.find((a) => a.sort_order === ev.activitySortOrder) ?? null
    const ksasInScope = ksasForActivitySortOrder(ev.activitySortOrder)
    const participantScope = ev.participantScopeNames.map((name) => {
      const p = seedParticipants.find((sp) => sp.name === name)
      return { name, participant_id: p?.id }
    })
    const clientId = `synthetic-a${ev.activitySortOrder}-${i + 1}`
    const file = buildCaptureFile(
      {
        client_id: clientId,
        evaluator_email: 'evaluator@example.org',
        source_language: 'English',
        source_text: ev.text,
        ruleset_version: 'synthetic',
        created_at: new Date().toISOString(),
      },
      {
        workshop: { id: workshop.id, name: workshop.name },
        activity: activity ? { id: activity.id, title: activity.title, day: activity.day } : null,
        ksasInScope,
        participantScope,
      },
    )
    write(inboxPath(clientId), JSON.stringify(file, null, 2) + '\n')
  })
  console.log(`\nExpectations (for eyeballing outbox/):`)
  SYNTHETIC_EVALUATIONS.forEach((ev, i) => console.log(`  synthetic-a${ev.activitySortOrder}-${i + 1}: ${ev.note}`))
}

console.log('\nDone. Commit routing/, then route inbox/ with Claude (Max) on the repo.')
