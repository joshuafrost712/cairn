/**
 * tl-36: does a brain dump actually reach the questions it touches?
 *
 * The spec's Verification 1 to 4, run through the real code and the real model.
 * Nothing here is a fixture: the questions, the wiring, the roster and the scale
 * are read live from the project (SELECT only, no writes anywhere), the capture
 * file is built by the app's own `buildCaptureFile` over the app's own
 * `participantFacingQuestions`, the prompt is the shipping `relayRoutingSystem` /
 * `relayRoutingPrompt` pair, the model is the real `claude` CLI through tl-21's
 * own `runClaudeJob`, and every returned observation is validated by the app's
 * `validateObservation`.
 *
 *   node --import tsx scripts/tl36-free-write-routing.ts --workshop psalms \
 *     --text .pilot-archive/tl36-dictation.txt
 *
 * NO NAMES IN THIS FILE, deliberately. `cairn` is public and code-searchable, so
 * the roster arrives from the database at run time and the dictated text arrives
 * from a path under `.pilot-archive/`, which `.gitignore` already holds. A harness
 * that had the names inlined would be the third roster script in this repo's
 * history to leak them.
 *
 * WHAT THIS CANNOT SHOW. Verification 6 is a person: the evaluator the spec
 * names filing a capture without being walked through it. No harness substitutes
 * for that, and the spec names the owner and the evening on purpose.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { buildCaptureFile, CAPTURE_SCHEMA_ID } from '../src/ai/workspace'
import { validateObservation } from '../src/ai/contract'
// The GENERATED bundle rather than `src/ai/relayPrompts.ts`, and for the reason
// that file exists: `relayPrompts` value-imports one constant from
// `routing/operations.ts`, whose module graph reaches Dexie and `lib/supabase.ts`,
// and the latter reads `import.meta.env` at load time. Under plain node that
// throws. `test/hostedRouting.test.ts` rebuilds this bundle and diffs it against
// the committed file on every run, so it cannot drift from the prompt the app and
// the Edge Function use.
// @ts-expect-error - generated .mjs bundle, no declaration file
import { relayRoutingPrompt, relayRoutingSystem } from '../supabase/functions/_shared/relayPrompts.gen.mjs'
import { participantFacingQuestions } from '../src/lib/instructors'
import { buildScale } from '../src/lib/scale'
import { withGoalTitles } from '../src/lib/goals'
// @ts-expect-error - plain .mjs, no declaration file
import { runClaudeJob } from '../relay/runner-claude.mjs'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WORKSHOPS: Record<string, string> = {
  psalms: '11111111-1111-1111-1111-111111111111',
  crash: '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
}

const arg = (flag: string, fallback = '') => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? (process.argv[i + 1] ?? fallback) : fallback
}
const workshopId = WORKSHOPS[arg('--workshop', 'psalms')] ?? arg('--workshop')
const textPath = arg('--text', '.pilot-archive/tl36-dictation.txt')

const results: { ok: boolean; label: string }[] = []
const check = (ok: boolean, label: string, detail: unknown = '') => {
  results.push({ ok, label })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 88)}`)
}
const note = (label: string, detail: unknown = '') =>
  console.log(`   . | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 88)}`)

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
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T[]
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

// ---- the live shape, read rather than recalled --------------------------------

const [workshop] = await sql<{ id: string; name: string }>(
  `select id, name from workshop where id = ${q(workshopId)}`,
)
if (!workshop) throw new Error(`no workshop ${workshopId}`)
note('workshop', workshop.name)

const ksaRows = await sql<Record<string, never>>(
  `select * from ksa where workshop_id = ${q(workshopId)} order by code`,
)
const goalRows = await sql<Record<string, never>>(`select * from goal where workshop_id = ${q(workshopId)}`)
const activityRows = await sql<{ id: string; audience: string | null }>(
  `select id, title, audience from activity where workshop_id = ${q(workshopId)}`,
)
const linkRows = await sql<{ ksa_id: string; activity_id: string }>(
  `select ak.ksa_id, ak.activity_id from activity_ksa ak
     join activity a on a.id = ak.activity_id where a.workshop_id = ${q(workshopId)}`,
)
const scaleRows = await sql<Record<string, never>>(
  `select * from scale_point where workshop_id = ${q(workshopId)} order by value`,
)
const participants = await sql<{ id: string; name: string; category: string | null }>(
  `select id, name, category from participant where workshop_id = ${q(workshopId)} order by name`,
)

// ---- the scope decision, through the app's own function -----------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const resolved = withGoalTitles(ksaRows as any, goalRows as any)
const inScope = participantFacingQuestions(resolved, linkRows, activityRows as any)
const scale = buildScale(workshopId, scaleRows as any)
/* eslint-enable @typescript-eslint/no-explicit-any */

const instructorOnly = resolved.filter((k) => !inScope.some((s) => s.id === k.id))
note('questions in the workshop', resolved.length)
note('participant-facing, so free-write scope', `${inScope.length}: ${inScope.map((k) => k.code).join(', ')}`)
note('excluded as instructor-only', instructorOnly.map((k) => k.code).join(', ') || 'none')

const maxWired = Math.max(
  0,
  ...activityRows
    .filter((a) => (a.audience ?? 'participant') !== 'instructor')
    .map((a) => linkRows.filter((l) => l.activity_id === a.id).length),
)
note('most questions any single session reaches', maxWired)

check(
  inScope.length > maxWired,
  'free-write reaches more questions than any one session does',
  `${inScope.length} > ${maxWired}`,
)
check(
  instructorOnly.length > 0 && instructorOnly.every((k) => !inScope.some((s) => s.code === k.code)),
  'no instructor-only question is in free-write scope',
  instructorOnly.map((k) => k.code).join(', '),
)

/**
 * THE SAME DECISION AS AN ORDINARY EVALUATOR'S DEVICE SEES IT.
 *
 * This harness reads through the management API as `postgres`, so RLS is bypassed
 * and every activity is visible. A plain evaluator's device is not in that
 * position: `activity_select` hides an instructor-audience activity from anybody
 * holding neither an `instructor_reviewer` pair nor `admin`, while `ksa_select`
 * and `activity_ksa_select` are plain `is_workshop_member`. So that device caches
 * the instructor questions AND their wiring rows and NOT the event they point at.
 *
 * Five of Psalms' seven members are in that state. Everything above would have
 * passed while the screen they actually open offered all three. Found by this
 * spec's stage-6 review, and this is the check that would have found it: the
 * privileged read minus the rows RLS removes.
 */
const asPlainEvaluator = participantFacingQuestions(
  resolved,
  linkRows,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activityRows.filter((a) => (a.audience ?? 'participant') !== 'instructor') as any,
)
check(
  asPlainEvaluator.length === inScope.length &&
    asPlainEvaluator.every((k) => !instructorOnly.some((i) => i.code === k.code)),
  'and none is in scope on a device that cannot even SEE the instructor event',
  `${asPlainEvaluator.length} in scope: ${asPlainEvaluator.map((k) => k.code).join(', ')}`,
)

// ---- the capture file, built by the shipping builder --------------------------

const dictation = readFileSync(textPath, 'utf8').trim()
const words = dictation.split(/\s+/).length
note('dictated text', `${words} words, ${dictation.length} chars, from ${textPath}`)

// Whoever the dictation names, matched against the live roster. Nothing is
// invented here: a name in the text that is not on the roster is left for the
// router to flag, which is check 3 below.
const trainees = participants.filter((p) => (p.category ?? 'participant') !== 'instructor')
const named = trainees.filter((p) => {
  const first = p.name.split(/\s+/)[0]
  return first.length > 2 && new RegExp(`\\b${first}\\b`, 'i').test(dictation)
})
note('roster names appearing in the text', named.length)

const captureFile = buildCaptureFile(
  {
    client_id: 'tl36-free-write-probe',
    evaluator_email: 'tl36-probe@example.org',
    source_language: 'English',
    source_text: dictation,
    ruleset_version: null,
    created_at: new Date().toISOString(),
  },
  {
    workshop: { id: workshop.id, name: workshop.name },
    // A free-write capture has no activity. This is Verification 2: the question
    // set must still be the workshop's whole participant-facing set.
    activity: null,
    ksasInScope: inScope,
    participantScope: named.map((p) => ({ name: p.name, participant_id: p.id })),
    scale,
  },
)

check(captureFile.schema === CAPTURE_SCHEMA_ID, 'capture file is the real schema', captureFile.schema)
check(
  captureFile.activity.id === null && captureFile.ksas_in_scope.length === inScope.length,
  'with NO activity in context the file still inlines every question',
  `activity=null, ksas_in_scope=${captureFile.ksas_in_scope.length}`,
)
check(
  captureFile.ksas_in_scope.every((k) => !instructorOnly.some((i) => i.code === k.code)),
  'the routed file carries no instructor-only question',
  captureFile.ksas_in_scope.map((k) => k.code).join(', '),
)

// ---- route it, for real ------------------------------------------------------

const bundle = {
  schema: 'cairn.capture-bundle/v1',
  generated_at: new Date().toISOString(),
  captures: [captureFile],
}
const started = Date.now()
const run = await runClaudeJob({
  payload: {
    system: relayRoutingSystem(scale),
    prompt: relayRoutingPrompt(JSON.stringify(bundle, null, 2)),
    model: null,
  },
})
const wall = ((Date.now() - started) / 1000).toFixed(1)

if (!run.ok) {
  check(false, 'the real claude CLI routed the capture', run.reason)
  process.exit(1)
}
note('routed', `${wall}s, ${run.result.tokens_in} in / ${run.result.tokens_out} out, model ${run.result.model}`)

/**
 * `runClaudeJob` returns the JSON as TEXT in `result.text`, not as a parsed value.
 *
 * The first version of this harness read `run.value`, got undefined, and reported
 * "0 observations" over a reply that had them. That is this wave's own rule about
 * an unparsed answer not being a wrong answer, hit again on the same day the tl-22
 * review restated it, so the raw reply is printed whenever parsing fails.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let value: any = null
try {
  value = JSON.parse(run.result.text)
} catch (e) {
  console.log('--- RAW REPLY, unparsed ---')
  console.log(String(run.result.text).slice(0, 2000))
  check(false, 'the reply parsed as JSON', String(e))
}
const files: any[] = value?.results ?? (Array.isArray(value) ? value : value ? [value] : [])
const observations: any[] = files.flatMap((f: any) => f?.observations ?? [])
/* eslint-enable @typescript-eslint/no-explicit-any */

check(observations.length > 0, 'the capture produced observations', observations.length)
if (observations.length === 0 && value) {
  console.log('--- PARSED BUT EMPTY, top-level keys ---', Object.keys(value))
}

const valid = observations.filter((o) => validateObservation(o).ok)
const invalid = observations.length - valid.length
check(invalid === 0, 'every observation is contract-valid', `${valid.length} valid, ${invalid} rejected`)

const codes = [...new Set(valid.map((o) => o.ksa_code))]
const codesInScope = codes.filter((code) => inScope.some((k) => k.code === code))
const codesOutOfScope = codes.filter((code) => !inScope.some((k) => k.code === code))
note('question codes returned', codes.join(', '))

check(
  codesInScope.length >= 5,
  'the dump reached FIVE or more different questions',
  `${codesInScope.length}: ${codesInScope.join(', ')}`,
)
check(codesOutOfScope.length === 0, 'no observation invented a code', codesOutOfScope.join(', ') || 'none')
check(
  !codes.some((code) => instructorOnly.some((i) => i.code === code)),
  'no observation routed into an instructor question',
  instructorOnly.map((k) => k.code).join(', '),
)

const people = [...new Set(valid.map((o) => o.participant_name))]
note('people named in the observations', people.join(', '))
check(
  people.filter(Boolean).length >= 4,
  'the dump reached FOUR or more different people',
  people.filter(Boolean).length,
)

const flagged = valid.filter((o) => o.needs_review)
note('flagged for a human', `${flagged.length} of ${valid.length}`)

// Printed, not summarised. A count cannot tell a router that flags an unmatchable
// name from one that flags everything, and the difference is the whole claim.
console.log('\n--- observations, as routed ---')
for (const o of valid) {
  const known = trainees.some((p) => p.name.toLowerCase().includes(String(o.participant_name).toLowerCase()))
  console.log(
    `  ${o.ksa_code.padEnd(7)} ${String(o.participant_name).padEnd(12)} ` +
      `d=${o.evidence_designation} review=${o.needs_review ? 'YES' : 'no '} on-roster=${known ? 'yes' : 'NO '}`,
  )
  console.log(`          ${String(o.text).slice(0, 150)}`)
}
console.log('')

// Verification 3, in the form this roster can actually express it: a name that is
// on nobody's row must be flagged rather than attached to somebody.
const offRoster = valid.filter(
  (o) => !trainees.some((p) => p.name.toLowerCase().includes(String(o.participant_name).toLowerCase())),
)
if (offRoster.length > 0) {
  check(
    offRoster.every((o) => o.needs_review),
    'a name that is on nobody\'s row is flagged, never guessed',
    offRoster.map((o) => `${o.participant_name}:${o.needs_review}`).join(', '),
  )
} else {
  note('the dictation named nobody off-roster, so the guess check is not assertable', '')
}

// Verification 3: an ambiguous first name is flagged, not guessed. Only assertable
// when the live roster actually holds two people sharing one, so it reports rather
// than fails when it does not.
const firstNames = trainees.map((p) => p.name.split(/\s+/)[0].toLowerCase())
const shared = [...new Set(firstNames.filter((n, i) => firstNames.indexOf(n) !== i))]
if (shared.length === 0) note('no two roster first names collide, so check 3 is not assertable here', '')
else note('roster first names shared by two people', shared.join(', '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:')
  for (const f of failed) console.log(`  - ${f.label}`)
}
process.exit(failed.length ? 1 : 0)
