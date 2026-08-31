/**
 * tl-38 acceptance clause 4: the briefing and the script must agree, field by field.
 *
 *   npx tsx scripts/tl38-parity.ts [workshop-id]
 *
 * Two independent implementations of one question is the whole reason to trust
 * either. `scripts/health/workshop-health.mjs` pulls whole rows through the
 * management API as `postgres` and derives everything in JavaScript. The
 * `workshop_health` RPC derives the same numbers in SQL, as the calling user,
 * and deliberately cannot see the free text the script can. If they agree, the
 * SQL is right; if they disagree, one of them is and this prints which field.
 *
 * THE SNAPSHOT PROBLEM, and why this file is not just two calls in a row.
 * The gate wants live workshop rows, and a live workshop is being written to
 * while the harness runs. The first run of this comparison found the routing
 * queue at 49 and then 50, and an unsubmitted draft that became a submitted
 * capture between the two reads. Both implementations were correct and the diff
 * was still red. So every comparison is fenced by a fingerprint taken before and
 * after both reads, and a comparison whose fingerprint moved is discarded and
 * retried rather than reported. A parity harness that cannot tell drift from
 * disagreement manufactures findings, which is the failure tl-24's blind-ordering
 * harness taught this program to design against.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  renderHealthMarkdown,
  silentDevices,
  rankCoverageGaps,
  type WorkshopHealth,
} from '../src/reports/health'

const PROJECT_REF = 'vdbirmjvjzfdgajwgowj'
const PSALMS = '11111111-1111-1111-1111-111111111111'
const workshopId = process.argv[2] ?? PSALMS
/** Joshua's auth user id: chief_admin on both live workshops. */
const AS_CHIEF = '3aea7d0d-133b-43ee-b5d0-a7a80374a87f'

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN
  const env = readFileSync(`${homedir()}/.claude/secrets/supabase.env`, 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='))
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found')
  return line.slice(line.indexOf('=') + 1).trim()
}

async function sql(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`query failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>[]
}

/** Everything that could move under the comparison, in one cheap row. */
async function fingerprint(): Promise<string> {
  const [row] = await sql(`select json_build_object(
    'e', (select count(*) from evaluation where workshop_id='${workshopId}'),
    'ea', (select count(*) from evaluation where workshop_id='${workshopId}' and attestation),
    'eu', (select max(updated_at) from evaluation where workshop_id='${workshopId}'),
    'o', (select count(*) from observation where workshop_id='${workshopId}'),
    -- Counts alone do not fence an in-place edit. Re-attributing an observation or
    -- correcting its designation moves mean_evidence, by_goal and the coverage
    -- split while leaving every count identical, so the comparison would be graded
    -- across two different datasets and read as a disagreement.
    'ock', (select md5(string_agg(coalesce(participant_id,'') || ':' || coalesce(ksa_code,'') || ':' ||
              coalesce(evidence_designation::text,'') || ':' || coalesce(sentiment_flag,''), '|' order by id))
            from observation where workshop_id='${workshopId}'),
    'pck', (select md5(string_agg(coalesce(name,'') || ':' || coalesce(team_id::text,''), '|' order by id))
            from participant where workshop_id='${workshopId}'),
    'v', (select count(*) from verification_verdict where workshop_id='${workshopId}'),
    'p', (select count(*) from participant where workshop_id='${workshopId}')
  ) as fp`)
  return JSON.stringify(row.fp)
}

async function callRpc(): Promise<WorkshopHealth> {
  const [row] = await sql(`
    select set_config('role','authenticated', true),
           set_config('request.jwt.claims',
             json_build_object('sub','${AS_CHIEF}','role','authenticated')::text, true);
    select workshop_health('${workshopId}'::uuid) as h;
  `)
  return row.h as WorkshopHealth
}

function runScript(): string {
  return execFileSync('node', ['scripts/health/workshop-health.mjs', workshopId], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
}

type Shape = Record<string, unknown>

/** The script's markdown, read back into the numbers it asserts. */
function parseScript(md: string): Shape {
  const line = (re: RegExp): string => md.match(re)?.[1]?.trim() ?? ''

  const volume = md.match(
    /^(\d+) captures from (\d+) evaluators; (\d+) routed observations across (\d+) people\. Mean evidence ([\d.]+|n\/a)(?: \(sentiment: ([^)]*)\))?/m,
  )
  const sentiment: Record<string, number> = {}
  for (const part of (volume?.[6] ?? '').split(',')) {
    const m = part.trim().match(/^(\d+) (.+)$/)
    if (m) sentiment[m[2]] = Number(m[1])
  }

  const perDay: Record<string, number> = {}
  for (const part of line(/^Captures per day: (.*)$/m).split('·')) {
    const m = part.trim().match(/^([\d-]+): (\d+)$/)
    if (m) perDay[m[1]] = Number(m[2])
  }

  const queueLine = md.match(
    /^- Routing queue \(attested, has content, no observations yet\): \*\*(\d+)\*\*(?:.*?oldest ([\d-]+); by evaluator: (.*))?$/m,
  )
  const byEvaluator: Record<string, number> = {}
  for (const part of (queueLine?.[3] ?? '').split(',')) {
    const m = part.trim().match(/^(\S+) (\d+)$/)
    if (m) byEvaluator[m[1]] = Number(m[2])
  }

  const draftsLine = md.match(/^- Unsubmitted drafts that contain content[^:]*: \*\*(\d+)\*\*(?:.*?— (.*))?$/m)
  const drafts = (draftsLine?.[2] ?? '')
    .split(/, (?=\S+ \()/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, ' '))
    .sort()

  const silent: Record<string, string> = {}
  for (const part of line(/^- Evaluator devices silent >\d+h \(last delivery\): (.*)$/m).split(',')) {
    const m = part.trim().match(/^(\S+) (\S+)$/)
    if (m) silent[m[1]] = m[2]
  }

  const areas: Record<string, number> = {}
  for (const m of md.matchAll(/^- (\d+) — (.+)$/gm)) areas[m[2].trim()] = Number(m[1])

  const participants: Record<string, string> = {}
  for (const m of md.matchAll(/^\| (.+?) \| (.*?) \| (\d+) \| (\d+) \| \*\*(\d+)\*\* \|$/gm)) {
    participants[m[1].trim()] = `${m[2].trim()}/${m[3]}/${m[4]}`
  }

  const unseen = line(/^\*\*No evidence at all \(routed or pending\): (.+)\.\*\*$/m)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()

  return {
    captures: Number(volume?.[1] ?? -1),
    evaluators: Number(volume?.[2] ?? -1),
    observations: Number(volume?.[3] ?? -1),
    peopleWithRouted: Number(volume?.[4] ?? -1),
    meanEvidence: volume?.[5] ?? 'n/a',
    sentiment,
    perDay,
    queueCount: Number(queueLine?.[1] ?? -1),
    queueOldestDay: queueLine?.[2] ?? '',
    byEvaluator,
    verdicts: Number(line(/^- Verification verdicts recorded: \*\*(\d+)\*\*/m) || -1),
    draftsCount: Number(draftsLine?.[1] ?? -1),
    drafts,
    emptyShells: Number(line(/^- Abandoned empty capture shells: (\d+)/m) || -1),
    silent,
    areas,
    participants,
    unseen,
    unattributed: Number(line(/^(\d+) observations are attributed to names not on the roster/m) || 0),
  }
}

/** The same numbers, taken from the RPC payload through the app's own module. */
function fromRpc(h: WorkshopHealth, nowMs: number): Shape {
  const sentiment: Record<string, number> = {}
  for (const s of h.volume.sentiment) sentiment[s.flag ?? 'null'] = s.n

  const perDay: Record<string, number> = {}
  for (const d of h.volume.per_day) perDay[d.day.slice(5)] = d.n

  const byEvaluator: Record<string, number> = {}
  for (const e of h.pipeline.queue.by_evaluator) byEvaluator[e.evaluator_email.split('@')[0]] = e.n

  const silent: Record<string, string> = {}
  for (const row of silentDevices(h.pipeline.last_delivery, nowMs, h.stale_hours)) {
    silent[row.evaluator_email.split('@')[0]] = row.last_at.slice(0, 16)
  }

  // The script groups by the legacy `ksa.area`; the RPC groups by goal, because
  // tl-08 replaced that column and `oneResolutionSite.test.ts` forbids reading it.
  // On this workshop every question's goal title equals its area string, so the
  // two agree today. They will not agree the first time an INSTRUCTOR observation
  // is routed: those questions have a null area, so the script falls back to the
  // code (`INSTR1`) where the goal layer says "Instructor Practice". If this field
  // ever fails, read that sentence before assuming the RPC is wrong.
  const areas: Record<string, number> = {}
  for (const g of h.by_goal) areas[g.goal] = g.n

  const participants: Record<string, string> = {}
  for (const p of h.coverage.participants) {
    participants[p.name] = `${p.team ?? ''}/${p.routed}/${p.pending}`
  }

  return {
    captures: h.volume.captures,
    evaluators: h.volume.evaluators,
    observations: h.volume.observations,
    peopleWithRouted: h.volume.people_with_routed,
    meanEvidence:
      h.volume.mean_evidence === null || h.volume.mean_evidence === undefined
        ? 'n/a'
        : Number(h.volume.mean_evidence).toFixed(2),
    sentiment,
    perDay,
    queueCount: h.pipeline.queue.count,
    queueOldestDay: h.pipeline.queue.oldest_created_at?.slice(0, 10) ?? '',
    byEvaluator,
    verdicts: h.volume.verdicts,
    draftsCount: h.pipeline.drafts_with_content.length,
    drafts: h.pipeline.drafts_with_content
      .map((d) => `${d.evaluator_email.split('@')[0]} (${d.created_at.slice(5, 10)})`)
      .sort(),
    emptyShells: h.pipeline.empty_shells,
    silent,
    areas,
    participants,
    unseen: rankCoverageGaps(h.coverage.participants)
      .filter((g) => g.unseen)
      .map((g) => g.row.name)
      .sort(),
    unattributed: h.coverage.unattributed_observations,
  }
}

const MAX_TRIES = 6
let scriptShape: Shape | null = null
let rpcShape: Shape | null = null
let health: WorkshopHealth | null = null
let tries = 0

while (tries < MAX_TRIES) {
  tries += 1
  const before = await fingerprint()
  const md = runScript()
  const h = await callRpc()
  const after = await fingerprint()
  if (before !== after) {
    console.log(`attempt ${tries}: the workshop was written to mid-read, retrying`)
    continue
  }
  health = h
  scriptShape = parseScript(md)
  rpcShape = fromRpc(h, Date.now())
  break
}

if (!scriptShape || !rpcShape || !health) {
  console.error(`FAILED: ${MAX_TRIES} attempts and the data never held still. Try again when the room is quiet.`)
  process.exit(1)
}

/**
 * Key order is not a finding. The two implementations break ties differently on
 * equal counts, and comparing raw JSON.stringify scored three identical maps as
 * mismatches on the first run. Sorting keys compares what the field says rather
 * than the order it happened to be built in.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]))
  }
  return JSON.stringify(value)
}

let failures = 0
const width = Math.max(...Object.keys(scriptShape).map((k) => k.length))
console.log(`tl-38 parity, workshop ${workshopId}, stable after ${tries} attempt(s)\n`)
for (const key of Object.keys(scriptShape)) {
  const a = canonical(scriptShape[key])
  const b = canonical(rpcShape[key])
  const ok = a === b
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(width)}  ${ok ? a : `script=${a}\n${' '.repeat(width + 8)}rpc=   ${b}`}`)
}

console.log(`\n${failures === 0 ? 'PARITY MET' : `PARITY FAILED on ${failures} field(s)`}`)

// The prose guarantee (clause 3), asserted rather than claimed: no evidence text
// may appear anywhere in the raw payload. Checked against real strings pulled
// from the rows the RPC read, so a payload that leaked would fail here loudly.
const raw = JSON.stringify(health)
// Probed against ANY capture, not only an unsubmitted one. The guarantee is that
// no evidence prose reaches the payload, and scoping the probe to drafts made it
// skip the moment the workshop's only long draft was submitted mid-run.
const [samples] = await sql(`select json_build_object(
  'draft_source_text', (select btrim(substring(source_text from 1 for 40)) from evaluation
            where workshop_id='${workshopId}' and not attestation
              and length(btrim(coalesce(source_text,''))) > 20 limit 1),
  'draft_answer', (select btrim(substring(v from 1 for 40)) from evaluation e,
             lateral jsonb_each_text(e.answers) je(k,v)
             where e.workshop_id='${workshopId}' and not e.attestation and length(btrim(v)) > 20 limit 1),
  'any_source_text', (select btrim(substring(source_text from 1 for 40)) from evaluation
            where workshop_id='${workshopId}' and length(btrim(coalesce(source_text,''))) > 20 limit 1),
  'any_answer', (select btrim(substring(v from 1 for 40)) from evaluation e,
             lateral jsonb_each_text(e.answers) je(k,v)
             where e.workshop_id='${workshopId}' and length(btrim(v)) > 20 limit 1),
  'obs', (select btrim(substring(text from 1 for 40)) from observation
          where workshop_id='${workshopId}' and length(btrim(text)) > 20 limit 1),
  'excerpt', (select btrim(substring(source_excerpt from 1 for 40)) from observation
              where workshop_id='${workshopId}' and length(btrim(source_excerpt)) > 20 limit 1)
) as s`)
const probes = samples.s as Record<string, string | null>
let leaks = 0
console.log('\nprose containment (clause 3):')
for (const [label, sample] of Object.entries(probes)) {
  if (!sample) {
    console.log(`SKIP  ${label}: no row long enough to probe with`)
    continue
  }
  const leaked = raw.includes(sample)
  if (leaked) leaks += 1
  console.log(`${leaked ? 'LEAK' : 'PASS'}  ${label}: ${JSON.stringify(sample.slice(0, 32))}`)
}
console.log(leaks === 0 ? 'NO PROSE IN THE PAYLOAD' : `PROSE LEAKED in ${leaks} probe(s)`)

// Rendered once so a broken renderer fails here rather than in a browser.
const markdown = renderHealthMarkdown(health, Date.now())
const hrs = markdown.split('\n').filter((l) => l.trim() === '---').length
// The workshop's own name is quoted verbatim and this one carries an em dash.
// The vault's rule exempts a verbatim quotation of an existing string, so the
// check is against the prose the renderer authors, not the data it repeats.
const authored = health.workshop?.name ? markdown.split(health.workshop.name).join('') : markdown
const emDashes = (authored.match(/—/g) ?? []).length
console.log(`\nmarkdown: ${markdown.split('\n').length} lines, ${hrs} horizontal rules, ${emDashes} authored em dashes`)
if (hrs > 0 || emDashes > 0) {
  console.log('FAIL clause 8: the copied markdown must carry neither')
}

process.exit(failures === 0 && leaks === 0 && hrs === 0 && emDashes === 0 ? 0 : 1)
