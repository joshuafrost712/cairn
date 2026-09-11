// Insert a validated outbox into Postgres, as the app's importer would.
//
//   npx tsx scripts/routing-import-b2.ts --dir .routing-workspace/<id> --outbox outbox-haiku --dry-run
//   npx tsx scripts/routing-import-b2.ts --dir .routing-workspace/<id> --outbox outbox-haiku
//
// `src/routing/operations.ts` is the normal path and stays the documented one:
// the app resolves the workshop, the roster and `subject_kind`, writes Dexie, and
// pushes. This exists because that path needs the administrator's own browser, and
// 83 captures had been stuck unrouted for three days while a live workshop ran.
//
// EVERY FIELD `observationRow()` SENDS IS SET HERE, deliberately and explicitly:
//   id                  minted with the batch prefix, so the whole insert is reversible
//   capture_client_id   from the capture file
//   workshop_id         the capture's workshop, not the "active" one
//   participant_id      resolved by the router against scope or roster; may be null
//   participant_name    as the roster spells it
//   ksa_code/text/source_excerpt/evidence_designation/sentiment_flag/confidence/origin
//   needs_review        FORCED TRUE, see below
//   imported_at         now
//   evaluator_email     the capture's author, so the evidence keeps its attribution
//   subject_kind        from the capture, never left to the column default
//
// WHY `needs_review` IS FORCED TRUE FOR THE WHOLE BATCH.
// `isSetAside` puts a needs_review row in `toVerify`, where it cannot move any
// designation until a person confirms it. These observations were produced by a
// model reading candid assessments of named colleagues, and `analytics.ts` turns a
// low designation into a "needs a mentoring conversation" flag. Nothing here counts
// toward anybody's assessment until a human has looked at it. The router's own
// judgment is not lost: it survives in `confidence`, so the review queue can be
// worked lowest-confidence first.
//
// ROLLBACK, printed before anything is written:
//   delete from verification_verdict where observation_id like '<prefix>%';
//   delete from observation where id like '<prefix>%';
// In that order. `verification_verdict.observation_id` is text with NO foreign key,
// so verdicts made against a deleted observation are orphaned rather than cascaded.

import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { validateObservation, isOnScale } from '../src/ai/contract'
import { excerptIsGrounded } from '../src/ai/provenance'
import type { CaptureFile, ObservationsFile } from '../src/ai/workspace'
import type { Scale } from '../src/lib/scale'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PREFIX = 'bali-b2-'

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`sql failed: ${res.status} ${JSON.stringify(body).slice(0, 500)}`)
  return body as T[]
}

const lit = (v: string | null) => (v == null ? 'null' : `'${v.replace(/'/g, "''")}'`)

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v == null && fallback == null) throw new Error(`missing --${name}`)
  return v ?? fallback!
}

function scaleOf(file: CaptureFile): Scale {
  return {
    workshop_id: file.workshop.id,
    points: file.scale.map((p, i) => ({
      pk: `${file.workshop.id}:${p.value}`,
      workshop_id: file.workshop.id ?? '',
      value: p.value,
      label: p.label,
      description: null,
      is_low_trigger: p.is_low_trigger,
      sort_order: i,
    })),
  }
}

async function main() {
  const dir = arg('dir')
  const outbox = arg('outbox', 'outbox-haiku')
  const dryRun = process.argv.includes('--dry-run')
  const now = new Date().toISOString()

  // The capture's own author and subject_kind, which the observation inherits.
  const captureMeta = new Map<string, { email: string | null; kind: string }>()
  const ids = readdirSync(`${dir}/inbox`)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(`${dir}/inbox/${n}`, 'utf8')).capture_client_id as string)
  const rows = await sql<{ client_id: string; evaluator_email: string | null; subject_kind: string }>(
    `select client_id, evaluator_email, subject_kind from evaluation where client_id in (${ids.map((i) => lit(i)).join(',')})`,
  )
  for (const r of rows) captureMeta.set(r.client_id, { email: r.evaluator_email, kind: r.subject_kind })

  const values: string[] = []
  let n = 0
  for (const name of readdirSync(`${dir}/${outbox}`).filter((f) => f.endsWith('.json'))) {
    const file = JSON.parse(readFileSync(`${dir}/inbox/${name}`, 'utf8')) as CaptureFile
    const routed = JSON.parse(readFileSync(`${dir}/${outbox}/${name}`, 'utf8')) as ObservationsFile
    const scale = scaleOf(file)
    const meta = captureMeta.get(file.capture_client_id)
    if (!meta) throw new Error(`${file.capture_client_id} is not an evaluation on the server`)

    for (const o of routed.observations) {
      const v = validateObservation(o)
      if (!v.ok) throw new Error(`${name}: ${v.reason}`)
      if (!isOnScale(v.value, scale)) throw new Error(`${name}: ${v.value.evidence_designation} off scale`)
      if (!excerptIsGrounded(v.value.source_excerpt, file.source_text)) {
        throw new Error(`${name}: ungrounded excerpt "${v.value.source_excerpt.slice(0, 40)}"`)
      }
      n++
      values.push(
        `(${[
          // The workshop's short id rides in the key: both Bali workshops import
          // from their own directory, and a bare counter would mint `bali-b1-0001`
          // twice and collide on the primary key. `bali-b1-%` still matches both,
          // so the rollback stays one statement.
          lit(`${PREFIX}${(file.workshop.id ?? 'none').slice(0, 8)}-${String(n).padStart(4, '0')}`),
          lit(file.capture_client_id),
          lit(file.workshop.id),
          v.value.participant_id ? lit(v.value.participant_id) : 'null',
          lit(v.value.participant_name),
          lit(v.value.ksa_code),
          lit(v.value.text),
          lit(v.value.source_excerpt),
          String(v.value.evidence_designation),
          lit(v.value.sentiment_flag),
          lit(v.value.confidence),
          'true', // needs_review: forced, see the header
          lit(v.value.origin),
          lit(now),
          lit(meta.email),
          lit(meta.kind),
        ].join(', ')})`,
      )
    }
  }

  console.log(`ROLLBACK for this batch:`)
  console.log(`  delete from verification_verdict where observation_id like '${PREFIX}%';`)
  console.log(`  delete from observation where id like '${PREFIX}%';\n`)

  if (values.length === 0) {
    console.log('nothing to insert')
    return
  }
  const stmt =
    `insert into observation (id, capture_client_id, workshop_id, participant_id, participant_name,` +
    ` ksa_code, text, source_excerpt, evidence_designation, sentiment_flag, confidence, needs_review,` +
    ` origin, imported_at, evaluator_email, subject_kind) values\n${values.join(',\n')};`

  if (dryRun) {
    console.log(`DRY RUN: ${values.length} rows ready, nothing written.`)
    console.log(stmt.slice(0, 600) + '\n...')
    return
  }
  await sql(stmt)
  const [count] = await sql<{ n: number }>(
    `select count(*)::int as n from observation where id like '${PREFIX}%'`,
  )
  console.log(`inserted ${values.length} rows; ${count.n} now carry the ${PREFIX} prefix.`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
