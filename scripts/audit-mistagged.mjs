/**
 * Has a submitted evaluation ended up filed under the wrong person?
 *
 * Read-only. SELECT only, no writes, no DDL. Every hit is a candidate for a human
 * to read, not a row to correct automatically.
 *
 *   node scripts/audit-mistagged.mjs
 *   node scripts/audit-mistagged.mjs --workshop <uuid>
 *
 * WHY THIS EXISTS. Until the read-only lock landed, a submitted capture stayed
 * fully editable with its roster grid live. An evaluator who finished one CIT,
 * submitted, and then reopened that capture to "start the next person" could tap a
 * second name and re-point the whole record: the text stayed as it was, and the
 * coverage row moved. The result leaves no duplicate to count, because it is one
 * row that changed hands. So the signal has to be textual.
 *
 * WHAT IT LOOKS FOR. The input rules tell evaluators to name who they mean
 * ("Name who you mean, describe what you observed"), and in practice they do. So a
 * submitted capture whose text names a roster participant who is NOT in its
 * participant_scope is worth a human look. Two other shapes are reported for the
 * same reason: a submitted capture tagged to nobody at all, and one whose text
 * names nobody on the roster.
 *
 * WHAT IT CANNOT TELL YOU. This is a heuristic on prose, so both error directions
 * are real and neither is rare:
 *
 *   - False positives are expected and are not bugs. Comparisons are normal in an
 *     evaluation ("clearer than Alice was on Tuesday"), a group activity puts three
 *     names in one capture, and a whole-group remark names whoever spoke. tl-12's
 *     tag-help explicitly allows whole-group remarks.
 *   - False negatives are equally possible. An evaluator who wrote "he explained
 *     the genre well" and never used a name leaves no trace at all, and this finds
 *     nothing. A clean report is therefore NOT proof that no record was mis-filed.
 *
 * Read the flagged text. The question to ask of each is whether the person the
 * evaluation is now filed under is the person it describes.
 */
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const args = process.argv.slice(2)
const workshopArg = args.indexOf('--workshop')
const workshopId = workshopArg === -1 ? null : args[workshopArg + 1]

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()
if (!accessToken) {
  console.error('No SUPABASE_ACCESS_TOKEN. See the vault memory for where it lives.')
  process.exit(1)
}

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) {
    // Never the token, and never the whole request: just what the server said.
    console.error(`query failed ${res.status}\n${text}`)
    process.exit(1)
  }
  return JSON.parse(text)
}

const where = workshopId ? `and e.workshop_id = '${workshopId}'` : ''

// Submitted captures with their text and their tags. The name matching happens in
// JS below rather than in SQL: a participant_scope is JSONB and the roster names
// need normalizing (case, punctuation, first-name-only usage), which is clearer
// here than in a lateral join nobody will re-read.
const evaluations = await query(`
  select e.client_id, e.workshop_id, e.activity_id, e.evaluator_email, e.updated_at,
         e.source_text, e.participant_scope, e.focus_participant_id,
         a.title as activity_title
  from evaluation e
  left join activity a on a.id = e.activity_id
  where e.attestation = true ${where}
  order by e.updated_at desc
`)

const participants = await query(`
  select id, workshop_id, name from participant
  ${workshopId ? `where workshop_id = '${workshopId}'` : ''}
`)

const roster = new Map()
for (const p of participants) {
  if (!roster.has(p.workshop_id)) roster.set(p.workshop_id, [])
  roster.get(p.workshop_id).push(p)
}

/** Word-boundary match, so "Ali" does not hit inside "Alice" or "quality". */
function names(text, person) {
  const hits = []
  const whole = person.name.trim()
  const first = whole.split(/\s+/)[0]
  for (const form of new Set([whole, first])) {
    if (form.length < 3) continue
    const re = new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    const found = text.match(re)
    if (found) hits.push({ form, count: found.length })
  }
  return hits
}

const findings = []
for (const e of evaluations) {
  const text = e.source_text ?? ''
  const scope = Array.isArray(e.participant_scope) ? e.participant_scope : []
  const taggedIds = new Set(scope.map((s) => s.participant_id).filter(Boolean))
  if (e.focus_participant_id) taggedIds.add(e.focus_participant_id)
  const tagged = scope.map((s) => s.name).filter(Boolean)

  if (taggedIds.size === 0) {
    findings.push({ kind: 'tagged to nobody', e, tagged, others: [] })
    continue
  }
  if (!text.trim()) continue

  const others = []
  for (const p of roster.get(e.workshop_id) ?? []) {
    if (taggedIds.has(p.id)) continue
    const hits = names(text, p)
    if (hits.length > 0) others.push({ name: p.name, count: Math.max(...hits.map((h) => h.count)) })
  }
  const namesTagged = (roster.get(e.workshop_id) ?? [])
    .filter((p) => taggedIds.has(p.id))
    .some((p) => names(text, p).length > 0)

  if (others.length > 0) findings.push({ kind: 'names somebody else', e, tagged, others, namesTagged })
  else if (!namesTagged) findings.push({ kind: 'names nobody on the roster', e, tagged, others: [] })
}

console.log(`${evaluations.length} submitted captures examined.`)
if (findings.length === 0) {
  console.log('\nNothing flagged. Note that a capture naming nobody cannot be checked this way.')
  process.exit(0)
}

const order = ['names somebody else', 'tagged to nobody', 'names nobody on the roster']
for (const kind of order) {
  const group = findings.filter((f) => f.kind === kind)
  if (group.length === 0) continue
  console.log(`\n=== ${group.length} ${kind} ===`)
  for (const f of group) {
    const { e } = f
    console.log(`\n  ${e.client_id}`)
    console.log(`    tagged:      ${f.tagged.join(', ') || '(nobody)'}`)
    if (f.others.length > 0) {
      console.log(
        `    text names:  ${f.others.map((o) => `${o.name} (${o.count}x)`).join(', ')}` +
          (f.namesTagged ? '  [also names the tagged person]' : '  [does NOT name the tagged person]'),
      )
    }
    console.log(`    session:     ${e.activity_title ?? '(none)'}`)
    console.log(`    evaluator:   ${e.evaluator_email ?? '(none)'}  ${e.updated_at}`)
    console.log(`    text:        ${(e.source_text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
  }
}

console.log(
  '\nNothing was changed. Read each flagged text and ask whether the person it is' +
    '\nfiled under is the person it describes. Comparisons and group captures are' +
    '\nnormal and will show up here; a "does NOT name the tagged person" line is the' +
    '\nstrongest signal. A clean line does not prove a record is right.',
)
