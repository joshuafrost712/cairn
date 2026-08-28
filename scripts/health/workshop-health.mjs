#!/usr/bin/env node
/**
 * Workshop-health report for Honest Eval — read-only, admin-side.
 *
 * Prints a markdown health report for one workshop: volume, routing queue,
 * verification progress, sync anomalies, and coverage gaps (per KSA area and
 * per participant, counting both routed observations and pending mentions in
 * not-yet-routed captures, so a routing backlog is not misread as a person
 * nobody watched).
 *
 * Usage:
 *   node scripts/health/workshop-health.mjs               # workshop whose dates contain today
 *   node scripts/health/workshop-health.mjs <workshop-id> # explicit
 *
 * Auth: SUPABASE_ACCESS_TOKEN from the environment, falling back to
 * ~/.claude/secrets/supabase.env. Uses the Supabase management API (plain
 * fetch — urllib-style clients are blocked by the API's WAF), so it needs a
 * personal access token, not the anon key. Never prints the token.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const PROJECT_REF = 'vdbirmjvjzfdgajwgowj'

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN
  const env = readFileSync(`${homedir()}/.claude/secrets/supabase.env`, 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='))
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found')
  return line.slice(line.indexOf('=') + 1).trim()
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`query failed: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

const today = new Date().toISOString().slice(0, 10)

async function pickWorkshop(arg) {
  const rows = await sql(`select id, name, start_date, end_date from workshop order by start_date`)
  if (arg) {
    const w = rows.find((r) => r.id === arg || r.name.toLowerCase().includes(arg.toLowerCase()))
    if (!w) throw new Error(`no workshop matches ${arg}`)
    return w
  }
  const live = rows.filter((r) => r.start_date && r.start_date <= today && (!r.end_date || r.end_date >= today))
  if (live.length === 1) return live[0]
  if (live.length === 0) throw new Error(`no workshop is running today (${today}); pass a workshop id or name fragment`)
  throw new Error(`multiple workshops running today: ${live.map((w) => w.name).join(' | ')} — pass one`)
}

const W = await pickWorkshop(process.argv[2])
const esc = (s) => s.replace(/'/g, "''")
const wid = `'${esc(W.id)}'`

const [d] = await sql(`select json_build_object(
  'roster', (select json_agg(json_build_object('id',p.id,'name',p.name,'team',t.name)) from participant p left join team t on t.id=p.team_id where p.workshop_id=${wid}),
  'ksa', (select json_agg(json_build_object('code',code,'area',area)) from ksa where workshop_id=${wid} or workshop_id is null),
  'activities', (select json_agg(json_build_object('title',title,'day',day)) from activity a where a.workshop_id=${wid}),
  'captures', (select json_agg(json_build_object('client_id',client_id,'evaluator',evaluator_email,'created_at',created_at,'attested',attestation,
      'has_content', length(btrim(source_text))>0 or exists (select 1 from jsonb_each_text(answers) je(k,v) where length(btrim(v))>0),
      'has_qr', coalesce(quick_ratings::text,'{}') not in ('{}','null'),
      'scope',(select json_agg(s->>'name') from jsonb_array_elements(participant_scope) s))) from evaluation where workshop_id=${wid}),
  'observations', (select json_agg(json_build_object('capture',capture_client_id,'participant_id',participant_id,'participant_name',participant_name,
      'ksa_code',ksa_code,'evidence',evidence_designation,'sentiment',sentiment_flag)) from observation where workshop_id=${wid}),
  'verdicts', (select count(*) from verification_verdict where workshop_id=${wid})
) as data`).then((r) => [r.data ?? r[0]?.data ?? r])

const roster = d.roster ?? []
const caps = d.captures ?? []
const obs = d.observations ?? []
const areaOf = Object.fromEntries((d.ksa ?? []).map((k) => [k.code, k.area ?? k.code]))
const byId = Object.fromEntries(roster.map((p) => [p.id, p]))
const routedCaptures = new Set(obs.map((o) => o.capture))

const nameOf = (o) => byId[o.participant_id]?.name ?? o.participant_name ?? 'UNATTRIBUTED'
const count = (xs, key) => xs.reduce((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {})
const sorted = (m, asc = false) => Object.entries(m).sort((a, b) => (asc ? a[1] - b[1] : b[1] - a[1]))

// Sync anomalies
const routable = caps.filter((c) => c.attested && c.has_content)
const queue = routable.filter((c) => !routedCaptures.has(c.client_id))
// Ratings-only drafts count here (an evaluator entered something), but not in
// the routing queue: routing reads source_text, which only answer text feeds.
const draftsWithContent = caps.filter((c) => !c.attested && (c.has_content || c.has_qr))
const emptyShells = caps.filter((c) => !c.attested && !c.has_content && !c.has_qr)
const lastByEvaluator = {}
for (const c of caps) {
  const e = c.evaluator ?? '?'
  if (!lastByEvaluator[e] || c.created_at > lastByEvaluator[e]) lastByEvaluator[e] = c.created_at
}
const staleMs = 24 * 3600 * 1000
const staleDevices = Object.entries(lastByEvaluator).filter(([, at]) => Date.now() - Date.parse(at) > staleMs)

// Coverage
const routedPer = count(obs, nameOf)
const pendingPer = {}
for (const c of queue) for (const n of c.scope ?? []) pendingPer[n] = (pendingPer[n] ?? 0) + 1
const perArea = count(obs, (o) => areaOf[o.ksa_code] ?? o.ksa_code)
const evd = obs.filter((o) => o.evidence != null).map((o) => o.evidence)
const meanEv = evd.length ? (evd.reduce((a, b) => a + b, 0) / evd.length).toFixed(2) : 'n/a'
const sentiment = count(obs, (o) => o.sentiment)
const perDay = count(caps, (c) => c.created_at.slice(0, 10))

const L = []
L.push(`# Workshop health — ${W.name}`)
L.push(``, `Generated ${new Date().toISOString().slice(0, 16)}Z. Workshop ${W.start_date} to ${W.end_date ?? '?'}.`)
L.push(``, `## Volume`)
L.push(``, `${caps.length} captures from ${Object.keys(lastByEvaluator).length} evaluators; ${obs.length} routed observations across ${Object.keys(routedPer).length} people. Mean evidence ${meanEv} (sentiment: ${sorted(sentiment).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).`)
L.push(``, `Captures per day: ${Object.entries(perDay).sort().map(([d2, n]) => `${d2.slice(5)}: ${n}`).join(' · ')}`)
L.push(``, `## Pipeline`)
L.push(``, `- Routing queue (attested, has content, no observations yet): **${queue.length}**${queue.length ? ` — oldest ${queue.map((c) => c.created_at).sort()[0].slice(0, 10)}; by evaluator: ${sorted(count(queue, (c) => c.evaluator ?? '?')).map(([k, v]) => `${k.split('@')[0]} ${v}`).join(', ')}` : ''}`)
L.push(`- Verification verdicts recorded: **${d.verdicts}** on ${obs.length} observations.`)
L.push(`- Unsubmitted drafts that contain content (invisible to routing until submitted): **${draftsWithContent.length}**${draftsWithContent.length ? ` — ${draftsWithContent.map((c) => `${(c.evaluator ?? '?').split('@')[0]} (${c.created_at.slice(5, 10)})`).join(', ')}` : ''}`)
L.push(`- Abandoned empty capture shells: ${emptyShells.length} (benign).`)
if (staleDevices.length)
  L.push(`- Evaluator devices silent >24h (last delivery): ${staleDevices.map(([e, at]) => `${e.split('@')[0]} ${at.slice(0, 16)}`).join(', ')}`)
L.push(``, `## Coverage by KSA area (routed only)`)
L.push(``, ...sorted(perArea, true).map(([k, v]) => `- ${v} — ${k}`))
L.push(``, `## Coverage by participant (routed + pending-in-queue)`)
L.push(``, `| Participant | Team | Routed | Pending | Total |`, `|---|---|---|---|---|`)
const rows = roster
  .map((p) => ({ p, r: routedPer[p.name] ?? 0, q: pendingPer[p.name] ?? 0 }))
  .sort((a, b) => a.r + a.q - (b.r + b.q))
for (const { p, r, q } of rows) L.push(`| ${p.name} | ${p.team ?? ''} | ${r} | ${q} | **${r + q}** |`)
const zero = rows.filter((x) => x.r + x.q === 0).map((x) => x.p.name)
if (zero.length) L.push(``, `**No evidence at all (routed or pending): ${zero.join(', ')}.**`)
const unattributed = obs.filter((o) => !byId[o.participant_id]).length
if (unattributed) L.push(``, `${unattributed} observations are attributed to names not on the roster — check for name-variant mismatches.`)

console.log(L.join('\n'))
