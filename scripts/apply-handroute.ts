// Turn hand-authored routing judgments into observation files, resolving
// participant ids and running the same gates every other router's output faces.
//
//   npx tsx scripts/apply-handroute.ts .routing-workspace/handroute.json
//
// The judgment lives in the JSON as compact tuples; ids, schema and validation
// live here, so a person writing a routing decision never transcribes a UUID and
// never gets a free pass on the contract. Every row is checked with
// `validateObservation`, `isOnScale` and `excerptIsGrounded` before it is written,
// and a failure stops the run rather than writing a file that would fail at import.
//
// Names are resolved against the capture's own `participant_scope` first, then the
// workshop roster, because three of these captures have an EMPTY scope: the
// evaluator tagged nobody and the only names are the ones they typed.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'

import { validateObservation, isOnScale } from '../src/ai/contract'
import { excerptIsGrounded } from '../src/ai/provenance'
import type { CaptureFile } from '../src/ai/workspace'
import type { Scale } from '../src/lib/scale'

/** [name, ksa, designation, sentiment, confidence, origin, needs_review, excerpt, text] */
type Tuple = [string, string, number, string, string, string, boolean, string, string]

const ROOT = '.routing-workspace'

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

/** `| Name | Team | `id` |` rows out of the generated roster doc. */
function rosterIds(dir: string): Map<string, string> {
  const md = readFileSync(`${dir}/reference/roster.md`, 'utf8')
  const map = new Map<string, string>()
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*.*?\s*\|\s*`(.+?)`\s*\|/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

function main() {
  const data = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<
    string,
    { obs?: Tuple[]; _note?: string }
  >
  // Find each capture id's workshop directory once.
  const dirs = readdirSync(ROOT).filter((d) => existsSync(`${ROOT}/${d}/inbox`))
  const locate = (prefix: string) => {
    for (const d of dirs) {
      const hit = readdirSync(`${ROOT}/${d}/inbox`).find((n) => n.startsWith(prefix))
      if (hit) return { dir: `${ROOT}/${d}`, name: hit }
    }
    return null
  }

  let written = 0
  let rows = 0
  const failures: string[] = []

  for (const [prefix, entry] of Object.entries(data)) {
    if (prefix.startsWith('_')) continue
    const found = locate(prefix)
    if (!found) {
      failures.push(`${prefix}: no capture found`)
      continue
    }
    const file = JSON.parse(readFileSync(`${found.dir}/inbox/${found.name}`, 'utf8')) as CaptureFile
    const scale = scaleOf(file)
    const codes = new Set(file.ksas_in_scope.map((k) => k.code))
    const byName = new Map(file.participant_scope.filter((p) => p.participant_id).map((p) => [p.name, p.participant_id!]))
    const roster = rosterIds(found.dir)

    const observations = (entry.obs ?? []).map((t, i) => {
      const [name, ksa, designation, sentiment, confidence, origin, needsReview, excerpt, text] = t
      const id = byName.get(name) ?? roster.get(name) ?? null
      if (!id) failures.push(`${prefix}[${i}]: "${name}" is in neither the capture scope nor the roster`)
      if (!codes.has(ksa)) failures.push(`${prefix}[${i}]: ${ksa} is not a question on this capture`)
      if (!excerptIsGrounded(excerpt, file.source_text)) {
        failures.push(`${prefix}[${i}]: excerpt is not in the capture — "${excerpt.slice(0, 50)}"`)
      }
      const o = {
        participant_name: name,
        participant_id: id,
        ksa_code: ksa,
        text,
        source_excerpt: excerpt,
        evidence_designation: designation,
        sentiment_flag: sentiment,
        confidence,
        origin,
        needs_review: needsReview,
      }
      const v = validateObservation(o)
      if (!v.ok) failures.push(`${prefix}[${i}]: ${v.reason}`)
      else if (!isOnScale(v.value, scale)) failures.push(`${prefix}[${i}]: ${designation} is off this workshop's scale`)
      return o
    })

    writeFileSync(
      `${found.dir}/outbox-haiku/${found.name}`,
      JSON.stringify(
        {
          schema: 'cairn.observations/v1',
          capture_client_id: file.capture_client_id,
          routed_at: '2026-08-26T00:00:00Z',
          observations,
        },
        null,
        2,
      ) + '\n',
    )
    written++
    rows += observations.length
    console.log(`  ${prefix}  ${observations.length} observations`)
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problems — files were written but WILL NOT import cleanly:`)
    for (const f of failures) console.error(`  x ${f}`)
    process.exit(1)
  }
  console.log(`\n${written} captures rewritten, ${rows} observations, all gates passed.`)
}

main()
