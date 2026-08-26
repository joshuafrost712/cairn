// Route capture files with a LOCAL model through Ollama, and check the result
// against the same validators the app applies on import.
//
//   npx tsx scripts/routing-qwen.ts --dir .routing-workspace/<id> --model qwen3.5:9b --limit 3
//   npx tsx scripts/routing-qwen.ts --dir .routing-workspace/<id>            # the whole inbox
//
// This exists to answer one question before a bulk run: can the cheap tier do
// this job? The global rule is to probe a small sample and judge it against the
// task's criteria rather than assume, because a wrong tier quietly mangles the
// whole batch.
//
// WHAT THE AUTOMATED GATES DO NOT CATCH, and why the probe is judged by hand.
// `validateObservation` checks shape. `isOnScale` checks the number is a point on
// this workshop's scale. `excerptIsGrounded` checks the quoted span is really in
// the capture. None of them checks that the quote was credited to the right
// person: an observation that takes Joemar's sentence and files it under Kristina
// passes all three cleanly. Attribution is the criterion that decides the tier and
// it is judged against a hand-written gold, not here.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'

import { validateObservation, isOnScale, type RoutedObservation } from '../src/ai/contract'
import { excerptIsGrounded } from '../src/ai/provenance'
import { renderRoutingDoc } from '../src/ai/workspace'
import type { CaptureFile } from '../src/ai/workspace'
import type { Scale } from '../src/lib/scale'

const OLLAMA = 'http://127.0.0.1:11434/api/chat'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v == null && fallback == null) throw new Error(`missing --${name}`)
  return v ?? fallback!
}

/** The scale as the capture file carries it, in the shape `isOnScale` wants. */
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

/**
 * The prompt. The contract text is `renderRoutingDoc`'s, so the router is told
 * exactly what the app validates against, and the capture is inlined whole because
 * that is what a capture file is for: it carries its own rubric, roster scope and
 * scale so nothing else has to be fetched.
 */
function promptFor(file: CaptureFile): string {
  return [
    renderRoutingDoc(scaleOf(file)),
    '',
    '## The capture to route',
    '',
    '```json',
    JSON.stringify(file, null, 2),
    '```',
    '',
    'Return ONLY the observations array as JSON: `[ {...}, {...} ]`. No prose, no',
    'fences, no wrapper object. An empty array is a valid answer.',
    'Attribute every observation to a name from `participant_scope`. If the text',
    'names somebody who is not in that list, or you cannot tell who is meant, set',
    '`participant_id` to null and `needs_review` to true rather than guessing.',
  ].join('\n')
}

/** Pull the first JSON array out of a reply that may still be wrapped in prose. */
function parseArray(reply: string): unknown[] | null {
  const start = reply.indexOf('[')
  if (start < 0) return null
  for (let end = reply.lastIndexOf(']'); end > start; end = reply.lastIndexOf(']', end - 1)) {
    try {
      const v = JSON.parse(reply.slice(start, end + 1))
      if (Array.isArray(v)) return v
    } catch {
      // keep walking back: a trailing example in the prose is a common tail
    }
  }
  return null
}

/**
 * The output shape, handed to Ollama as a JSON schema so the field names are
 * decoded rather than hoped for.
 *
 * The first version of this probe left the shape to the prompt and judged the
 * model on the result. That was not a fair test and it was not even the right
 * engineering: `participant_name` came back as `text`-only objects, which reads as
 * "the model cannot do the job" when the truth is "nothing made it answer in the
 * agreed shape". Constrained decoding is the standing rule for a tool contract, so
 * the probe now measures what it means to measure, which is the judgment.
 */
const OBSERVATION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      participant_name: { type: 'string' },
      participant_id: { type: ['string', 'null'] },
      ksa_code: { type: 'string' },
      text: { type: 'string' },
      source_excerpt: { type: 'string' },
      evidence_designation: { type: 'integer' },
      sentiment_flag: { type: 'string', enum: ['strong', 'weak', 'neutral'] },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      origin: { type: 'string', enum: ['individual', 'group'] },
      needs_review: { type: 'boolean' },
    },
    required: [
      'participant_name',
      'participant_id',
      'ksa_code',
      'text',
      'source_excerpt',
      'evidence_designation',
      'sentiment_flag',
      'confidence',
      'origin',
      'needs_review',
    ],
  },
} as const

async function route(model: string, file: CaptureFile): Promise<string> {
  const res = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: OBSERVATION_SCHEMA,
      // The prompt is the whole contract plus the capture, which runs past 4k
      // tokens. Ollama's default context is 4096 and it TRUNCATES SILENTLY, so
      // the first run of this probe fed the model a prompt with the rules and
      // half the roster cut off and then blamed the model for the answer.
      options: { temperature: 0, num_ctx: 16384 },
      messages: [{ role: 'user', content: promptFor(file) }],
    }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return ((await res.json()) as { message?: { content?: string } }).message?.content ?? ''
}

async function main() {
  const dir = arg('dir')
  const model = arg('model', 'qwen3.5:9b')
  const limit = Number(arg('limit', '0')) || Infinity
  const outDir = `${dir}/outbox-${model.replace(/[^a-z0-9]/gi, '-')}`
  mkdirSync(outDir, { recursive: true })

  const names = readdirSync(`${dir}/inbox`).filter((n) => n.endsWith('.json')).slice(0, limit)
  console.log(`routing ${names.length} captures on ${model}\n`)

  let totalKept = 0
  let totalRejected = 0
  for (const name of names) {
    const file = JSON.parse(readFileSync(`${dir}/inbox/${name}`, 'utf8')) as CaptureFile
    const scale = scaleOf(file)
    const known = new Set(file.participant_scope.map((p) => p.name))
    const started = Date.now()
    let raw: string
    try {
      raw = await route(model, file)
    } catch (e) {
      console.log(`  ${name}  FAILED  ${e instanceof Error ? e.message : e}`)
      continue
    }
    const parsed = parseArray(raw)
    if (!parsed) {
      console.log(`  ${name}  UNPARSEABLE  ${raw.slice(0, 120).replace(/\n/g, ' ')}`)
      totalRejected++
      continue
    }

    const kept: RoutedObservation[] = []
    const rejects: string[] = []
    for (const item of parsed) {
      const v = validateObservation(item)
      if (!v.ok) {
        rejects.push(`shape: ${v.reason}`)
        continue
      }
      if (!isOnScale(v.value, scale)) {
        rejects.push(`off scale: ${v.value.evidence_designation}`)
        continue
      }
      if (!excerptIsGrounded(v.value.source_excerpt, file.source_text)) {
        rejects.push(`ungrounded quote: "${v.value.source_excerpt.slice(0, 40)}"`)
        continue
      }
      if (!file.ksas_in_scope.some((k) => k.code === v.value.ksa_code)) {
        rejects.push(`unknown question: ${v.value.ksa_code}`)
        continue
      }
      kept.push(v.value)
    }
    totalKept += kept.length
    totalRejected += rejects.length

    writeFileSync(
      `${outDir}/${name}`,
      JSON.stringify(
        {
          schema: 'cairn.observations/v1',
          capture_client_id: file.capture_client_id,
          routed_at: new Date().toISOString(),
          observations: kept,
        },
        null,
        2,
      ) + '\n',
    )

    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  ${file.capture_client_id.slice(0, 8)}  ${kept.length} kept, ${rejects.length} rejected  (${secs}s)`)
    for (const o of kept) {
      // The off-roster marker is the attribution smell the gates cannot catch, so
      // it is printed on every line rather than counted at the end.
      const flag = known.has(o.participant_name) ? ' ' : '?'
      console.log(`    ${flag} ${o.participant_name} · ${o.ksa_code} · ${o.evidence_designation} · "${o.source_excerpt.slice(0, 55)}"`)
    }
    for (const r of rejects) console.log(`    x ${r}`)
  }

  console.log(`\n${totalKept} observations kept, ${totalRejected} rejected. Files in ${outDir}/`)
  console.log('A "?" marks a name that is not in that capture\'s participant_scope.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
