/**
 * tl-24: read the authored course back the way an evaluator will read it.
 *
 *   npx tsx scripts/tl24-evaluator-read.ts [--day 2026-08-18]
 *
 * What this is, and what it is NOT. It pulls the real rows from the live project
 * and pushes them through the app's OWN resolution site — `withGoalTitles()` and
 * `resolveForActivity()` in src/lib/goals.ts, the single place tl-08 insists the
 * per-event override is applied — so what prints is what the capture screen, the
 * Setup preview and the routing capture file would each show. A wiring row whose
 * override never resolves, or a question whose group heading is missing, fails here.
 *
 * It is NOT the browser check the spec also asks for. It cannot be: reading the
 * Crash Course in the running app requires signing in as a member of it, and the
 * only member is Joshua. This verifies the content and the resolution; that the
 * page renders is his to confirm on his phone, which is what he asked for.
 */
import { execFileSync } from 'node:child_process'
import { resolveForActivity, withGoalTitles } from '../src/lib/goals'
import type { Activity, ActivityKsa, Goal, Ksa } from '../src/lib/types'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WORKSHOP = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
const dayArg = process.argv.indexOf('--day')
const DAY = dayArg === -1 ? null : process.argv[dayArg + 1]

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function sql<T>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`query failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T[]>
}

const [goals, ksas, activities, links, scale] = await Promise.all([
  sql<Goal>(`select * from goal where workshop_id = '${WORKSHOP}' order by sort_order`),
  sql<Ksa>(`select * from ksa where workshop_id = '${WORKSHOP}'`),
  sql<Activity>(
    `select * from activity where workshop_id = '${WORKSHOP}'` +
      (DAY ? ` and day = '${DAY}'` : '') +
      ` order by sort_order`,
  ),
  sql<ActivityKsa & { workshop_id: string }>(
    `select ak.* from activity_ksa ak join activity a on a.id = ak.activity_id
     where a.workshop_id = '${WORKSHOP}' order by ak.sort_order`,
  ),
  sql<{ value: number; label: string; description: string }>(
    `select value, label, description from scale_point where workshop_id = '${WORKSHOP}' order by value`,
  ),
])

console.log(`\nTHE SCALE an evaluator is rating against\n`)
for (const p of scale) console.log(`  ${p.value}  ${p.label} — ${p.description}`)

let overrides = 0
let cards = 0

for (const activity of activities) {
  const mine = links.filter((l) => l.activity_id === activity.id)
  console.log(`\n${'='.repeat(78)}\n${activity.day}  ${activity.title}  [${activity.genre_group}]`)
  if (!mine.length) {
    console.log(`  (no question — this session carries no gradable evaluation line)`)
    continue
  }
  const resolvedKsas = withGoalTitles(
    mine.map((l) => ksas.find((k) => k.id === l.ksa_id)!),
    goals,
  )
  for (const [i, link] of mine.entries()) {
    const q = resolveForActivity(resolvedKsas[i], link)
    cards++
    if (q.overridden) overrides++
    console.log(`\n  ── ${q.code} · ${q.short_label} · ${q.goal_title}${q.overridden ? '  (event wording)' : ''}`)
    console.log(`  ${q.evaluator_facing_prompt}`)
    for (const g of q.guiding_questions ?? []) console.log(`    · ${g}`)
    for (const p of scale) {
      const d = (q.evidence_levels as Record<string, string> | null)?.[String(p.value)]
      console.log(`    ${p.value} ${p.label}: ${d ?? '*** MISSING ***'}`)
    }
  }
}

console.log(
  `\n${'='.repeat(78)}\n${activities.length} sessions, ${cards} capture cards, ` +
    `${overrides} of them carrying this event's own wording.`,
)
const broken = links.filter((l) => !ksas.find((k) => k.id === l.ksa_id))
console.log(broken.length ? `DANGLING wiring rows: ${broken.length}` : `No dangling wiring rows.`)
