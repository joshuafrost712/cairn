// Build a routing workspace from a REAL workshop's data in Postgres, for captures
// that reached the server and were never routed.
//
//   npx tsx scripts/routing-batch.ts --workshop "Psalms"
//   npx tsx scripts/routing-batch.ts --workshop "Crash Course" --out .routing-workspace
//   npx tsx scripts/routing-batch.ts --list
//
// `routing-prepare.ts` is the sibling of this and stays what it is: it generates
// the workspace from `src/data/seed`, which is the demo roster, which is why
// `routing/inbox/` has only ever held synthetic captures. This one answers the
// other question — "route the work that is actually stuck" — and it is a separate
// script rather than a flag because the two have opposite safety properties.
//
// WHERE THE FILES GO, AND WHY NOT `routing/`.
// `routing/` is committed to this repo and this repo is public. A real capture is
// an evaluator's candid assessment of a named colleague, so writing one there
// would publish it. Output goes to `.routing-workspace/` instead, which is
// gitignored for the same reason `.pilot-archive/` is. Move it to the PRIVATE
// routing repo by hand if you want the automated flow to see it.
//
// The question scope is NOT decided here. `captureScopeSource` in
// lib/captureScope.ts decides it, exactly as it does for the capture screen, and
// this file only loads the tables it needs to answer. Re-implementing that
// branching is how a free-write capture gets filed against questions the
// evaluator was never shown.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
  captureScopeSource,
  resolveActivityKsas,
  resolveParticipantFacingKsas,
  resolveWorkshopKsas,
} from '../src/lib/captureScope'
import {
  buildCaptureFile,
  renderRoutingDoc,
  renderRubricDoc,
  renderRosterDoc,
  renderSchemaJson,
} from '../src/ai/workspace'
import { buildScale, type ScalePoint } from '../src/lib/scale'
import { goalLabel } from '../src/lib/goals'
import type {
  Activity,
  ActivityKsa,
  Goal,
  Ksa,
  Participant,
  ParticipantScopeEntry,
  Team,
  Workshop,
} from '../src/lib/types'

const PROJECT = 'vdbirmjvjzfdgajwgowj'

// Same source as apply-migration.mjs and tl18-sync-health.mjs: never inlined,
// never committed.
const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()
if (!accessToken) throw new Error('no SUPABASE_ACCESS_TOKEN in ~/.claude/secrets/supabase.env')

/** Run SQL as `postgres` through the management API. Reads only, in this script. */
async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`sql failed: ${res.status} ${JSON.stringify(body).slice(0, 400)}`)
  return body as T[]
}

/** Postgres literal for a string we built, not one a user typed. */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

interface CaptureRow {
  client_id: string
  evaluator_email: string | null
  activity_id: string | null
  workshop_id: string | null
  source_language: string
  source_text: string
  answers: Record<string, string> | null
  participant_scope: ParticipantScopeEntry[] | null
  ruleset_version: string | null
  created_at: string
  subject_kind: string | null
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

async function main() {
  if (process.argv.includes('--list')) {
    const rows = await sql<{ id: string; name: string; stuck: number }>(`
      select w.id, w.name,
             (select count(*) from evaluation e
               where e.workshop_id = w.id and e.attestation
                 and not exists (select 1 from observation o where o.capture_client_id = e.client_id)
             ) as stuck
        from workshop w order by w.name`)
    for (const r of rows) console.log(`${String(r.stuck).padStart(4)}  ${r.name}  ${r.id}`)
    return
  }

  const want = arg('workshop')
  if (!want) throw new Error('usage: --workshop "<name substring>" [--out <dir>] | --list')
  const outRoot = arg('out') ?? '.routing-workspace'

  const workshops = await sql<Workshop>(
    `select * from workshop where name ilike ${lit(`%${want}%`)}`,
  )
  if (workshops.length !== 1) {
    throw new Error(
      `--workshop "${want}" matched ${workshops.length} workshops; be more specific (--list to see them)`,
    )
  }
  const workshop = workshops[0]
  const wid = lit(workshop.id)

  // Reference tables. `activity_ksa` is fetched WHOLE on purpose:
  // `participantFacingQuestions` does its own scoping, and the defect it exists to
  // close came from a caller filtering it by activity first.
  const [activities, ksas, goals, allLinks, participants, teams, scaleRows] = await Promise.all([
    sql<Activity>(`select * from activity where workshop_id = ${wid} order by sort_order`),
    sql<Ksa>(`select * from ksa where workshop_id = ${wid}`),
    sql<Goal>(`select * from goal where workshop_id = ${wid} order by sort_order`),
    sql<ActivityKsa>(`select * from activity_ksa`),
    sql<Participant>(`select * from participant where workshop_id = ${wid} order by name`),
    sql<Team>(`select * from team where workshop_id = ${wid}`),
    sql<Omit<ScalePoint, 'pk'>>(`select * from scale_point where workshop_id = ${wid} order by sort_order`),
  ])

  // `buildScale` wants the app's row shape, whose `pk` is a client-side composite.
  const scale = buildScale(
    workshop.id,
    scaleRows.map((r) => ({ ...r, pk: `${r.workshop_id}:${r.value}` }) as ScalePoint),
  )
  if (scale.workshop_id === null && scaleRows.length > 0) {
    console.warn(`  ! ${scaleRows.length} scale points found but fewer than the minimum; using the default 0-3`)
  }

  const stuck = await sql<CaptureRow>(`
    select client_id, evaluator_email, activity_id, workshop_id, source_language,
           source_text, answers, participant_scope, ruleset_version,
           created_at::text as created_at, subject_kind
      from evaluation e
     where e.workshop_id = ${wid}
       and e.attestation
       and length(coalesce(e.source_text, '')) > 0
       and not exists (select 1 from observation o where o.capture_client_id = e.client_id)
     order by e.created_at`)

  const workshopKsas = resolveWorkshopKsas(ksas, goals)
  const participantFacing = resolveParticipantFacingKsas(workshopKsas, allLinks, activities)
  const activityById = new Map(activities.map((a) => [a.id, a]))
  const linksByActivity = new Map<string, ActivityKsa[]>()
  for (const l of allLinks) {
    const list = linksByActivity.get(l.activity_id) ?? []
    list.push(l)
    linksByActivity.set(l.activity_id, list)
  }
  const ksaById = new Map(ksas.map((k) => [k.id, k]))
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'n/a'

  const out = `${outRoot}/${workshop.id}`
  rmSync(`${out}/inbox`, { recursive: true, force: true })
  const write = (path: string, contents: string) => {
    mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true })
    writeFileSync(path, contents)
  }

  write(`${out}/ROUTING.md`, renderRoutingDoc(scale))
  write(
    `${out}/reference/rubric.md`,
    renderRubricDoc(workshopKsas, scale, { name: workshop.name, goalLabel: goalLabel(workshop) }),
  )
  write(`${out}/reference/roster.md`, renderRosterDoc(participants, teamName))
  write(`${out}/reference/schema.json`, renderSchemaJson(scale))

  const tally = { activity: 0, workshop: 0, none: 0 }
  for (const e of stuck) {
    const activity = e.activity_id ? activityById.get(e.activity_id) ?? null : null
    const links = (e.activity_id ? linksByActivity.get(e.activity_id) ?? [] : []).sort(
      (a, b) => a.sort_order - b.sort_order,
    )
    const fromActivity = resolveActivityKsas(
      links,
      links.map((l) => ksaById.get(l.ksa_id)),
      goals,
    )
    const source = captureScopeSource(e, { activity, activityQuestions: fromActivity.length })
    tally[source]++
    const ksasInScope =
      source === 'activity' ? fromActivity : source === 'workshop' ? participantFacing : []

    const file = buildCaptureFile(
      {
        client_id: e.client_id,
        evaluator_email: e.evaluator_email,
        source_language: e.source_language,
        source_text: e.source_text,
        ruleset_version: e.ruleset_version,
        created_at: e.created_at,
      },
      {
        workshop: { id: workshop.id, name: workshop.name },
        activity,
        ksasInScope,
        participantScope: e.participant_scope ?? [],
        scale,
      },
    )
    write(`${out}/inbox/${e.client_id}.json`, JSON.stringify(file, null, 2) + '\n')
  }

  console.log(`${workshop.name}`)
  console.log(`  ${stuck.length} stuck captures written to ${out}/inbox/`)
  console.log(`  scope: ${tally.activity} from their event, ${tally.workshop} free-write, ${tally.none} unscoped`)
  if (tally.none > 0) {
    console.log(`  ! ${tally.none} captures have no questions in scope and will route to nothing.`)
  }
  const noScope = stuck.filter((e) => (e.participant_scope ?? []).length === 0).length
  if (noScope > 0) {
    console.log(`  ! ${noScope} captures name nobody, so every observation from them needs_review.`)
  }
  console.log(`\n  ${out}/ is gitignored. Do not copy it into routing/ — that folder is public.`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
