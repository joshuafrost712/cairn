// Check a routed outbox against its inbox, with the same validators the app
// applies on import. Router-agnostic: point it at whatever produced the files.
//
//   npx tsx scripts/routing-check.ts --dir .routing-workspace/probe --outbox outbox-haiku
//   npx tsx scripts/routing-check.ts --dir .routing-workspace/<id> --outbox outbox --strict
//
// `--strict` additionally fails a quote that starts with a question header
// (`[CODE]`) or contains an ellipsis. Neither is caught by `excerptIsGrounded`,
// whose LCS ratio is 0.6 and so accepts a span the evaluator never wrote as long
// as most of it appears somewhere. A routed file is evidence a person will read
// next to a colleague's name; an edited quote is worse there than a missing one.

import { readFileSync, readdirSync, existsSync } from 'node:fs'

import { validateObservation, isOnScale, type RoutedObservation } from '../src/ai/contract'
import { excerptIsGrounded } from '../src/ai/provenance'
import type { CaptureFile } from '../src/ai/workspace'
import type { Scale } from '../src/lib/scale'

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

const strict = process.argv.includes('--strict')

/** Quote hygiene the grounding check is too lenient to catch. */
function quoteProblem(excerpt: string): string | null {
  if (/^\s*\[[A-Z0-9-]+\]/.test(excerpt)) return 'quote begins with a question header'
  if (/\.\.\.|…/.test(excerpt)) return 'quote contains an ellipsis'
  return null
}

function main() {
  const dir = arg('dir')
  const outbox = `${dir}/${arg('outbox', 'outbox')}`
  const inbox = `${dir}/inbox`

  const captures = readdirSync(inbox).filter((n) => n.endsWith('.json'))
  let kept = 0
  let rejected = 0
  let missing = 0
  let empty = 0
  const offRoster: string[] = []
  const perPerson = new Map<string, number>()

  for (const name of captures) {
    const file = JSON.parse(readFileSync(`${inbox}/${name}`, 'utf8')) as CaptureFile
    const path = `${outbox}/${name}`
    if (!existsSync(path)) {
      missing++
      console.log(`  MISSING  ${file.capture_client_id.slice(0, 8)}`)
      continue
    }
    const routed = JSON.parse(readFileSync(path, 'utf8')) as { observations?: unknown[] }
    const items = routed.observations ?? []
    if (items.length === 0) {
      empty++
      // Not an error on its own: the contract calls an empty result valid. It is
      // still printed, because a router that returns nothing for a capture full of
      // names has failed silently and that is the shape of this whole incident.
      console.log(`  EMPTY    ${file.capture_client_id.slice(0, 8)}  (${file.source_text.length} chars, ${file.participant_scope.length} in scope)`)
      continue
    }

    const scale = scaleOf(file)
    const known = new Set(file.participant_scope.map((p) => p.name))
    const codes = new Set(file.ksas_in_scope.map((k) => k.code))
    const problems: string[] = []
    let ok = 0
    for (const item of items) {
      const v = validateObservation(item)
      if (!v.ok) {
        problems.push(`shape: ${v.reason}`)
        continue
      }
      const o: RoutedObservation = v.value
      if (!isOnScale(o, scale)) {
        problems.push(`off scale: ${o.evidence_designation}`)
        continue
      }
      if (!codes.has(o.ksa_code)) {
        problems.push(`unknown question: ${o.ksa_code}`)
        continue
      }
      if (!excerptIsGrounded(o.source_excerpt, file.source_text)) {
        problems.push(`ungrounded: "${o.source_excerpt.slice(0, 45)}"`)
        continue
      }
      const hygiene = strict ? quoteProblem(o.source_excerpt) : null
      if (hygiene) {
        problems.push(`${hygiene}: "${o.source_excerpt.slice(0, 45)}"`)
        continue
      }
      if (!known.has(o.participant_name)) offRoster.push(`${o.participant_name} (${file.capture_client_id.slice(0, 8)})`)
      perPerson.set(o.participant_name, (perPerson.get(o.participant_name) ?? 0) + 1)
      ok++
    }
    kept += ok
    rejected += problems.length
    console.log(`  ${file.capture_client_id.slice(0, 8)}  ${ok} ok, ${problems.length} rejected`)
    for (const p of problems) console.log(`    x ${p}`)
  }

  console.log(`\n${captures.length} captures: ${kept} observations kept, ${rejected} rejected, ${empty} returned empty, ${missing} never routed`)
  if (offRoster.length > 0) {
    console.log(`\n! ${offRoster.length} observations name somebody outside that capture's scope:`)
    for (const n of [...new Set(offRoster)]) console.log(`    ${n}`)
  }
  console.log(`\n${perPerson.size} people have evidence. Attribution is judged by hand; nothing above checks it.`)
  process.exitCode = rejected > 0 || missing > 0 ? 1 : 0
}

main()
