// The routing contract — runtime-agnostic, no SDK, no API.
//
// Cairn does NOT call a metered Claude API. Routing is done by Claude through
// Joshua's Claude Max subscription, operating on a GitHub repo (see routing/).
// This module is the single source of truth for *what* that routing must do:
//
//  - ROUTING_RULES  — the instructions Claude follows (rendered into routing/ROUTING.md)
//  - buildReferenceBlock — the KSA rubric + roster Claude reads (rendered into reference files)
//  - OBSERVATIONS_SCHEMA — the JSON shape each routed output file must match
//  - RoutedObservation / validateObservation — the parsed result + a runtime check
//
// Both the workspace generator (src/ai/workspace.ts) and the in-app importer
// (src/routing/) consume this, so the spec the app validates against is exactly
// the spec Claude was given.

import type { ResolvedKsa } from '../lib/goals'
import { defaultBody } from '../templates/defaults'
import { fillTemplateTokens } from '../templates/interpolate'
import { bodyFor, getActiveTemplates } from '../templates/resolve'
import { DEFAULT_SCALE, isValidDesignation, maxValue, minValue, scaleValues, type Scale } from '../lib/scale'
import type { Participant } from '../lib/types'

/**
 * The routing instructions.
 *
 * SCALE-PARAMETERIZED SINCE tl-09, and it had to be. This text told the router
 * "assign evidence_designation 0-3", and a router given a 1-5 workshop's rubric
 * alongside an instruction to answer 0-3 will do one of two things, both bad: it
 * will answer 0-3 and every observation will be rejected at import, or it will
 * answer 1-5 and the instruction will have been a lie the whole time. The
 * default is the app's original scale, so a caller that has not been updated
 * produces exactly the text it produced before.
 *
 * AUTHORABLE SINCE tl-16, and the body is now a parameter for one reason the scale
 * is not: it has to be resolvable in two runtimes. In the browser it defaults to the
 * ACTIVE workshop's override, on the same rule `getActiveScale()` carries — anything
 * generating this for a workshop the operator is not in passes it explicitly. In the
 * Edge Function (via the generated bundle) `getActiveTemplates()` is the empty set, so
 * this returns the shipped text and `route-captures` passes the workshop's override
 * that it read from Postgres itself. A server that trusted the client for its prompt
 * would be a different and worse design.
 *
 * `{{range}}` is the same hole this template has had since tl-09, lowercased in tl-16
 * to match every other token in the library and now filled by the shared scanner
 * rather than by a `replace()` of its own. The validator REQUIRES it, so an authored
 * body cannot drop it.
 */
export function routingRules(scale: Scale = DEFAULT_SCALE, body?: string): string {
  const text = body ?? bodyFor(getActiveTemplates(), 'instructions.observation_routing')
  return fillTemplateTokens(text, { range: `${minValue(scale)}-${maxValue(scale)}` })
}

/**
 * The shipped routing rules, as tl-16's library holds them.
 *
 * Re-exported rather than declared here: this text was a literal in this file until
 * tl-16 moved it into `src/templates/defaults.ts`, which is now its one home. Keeping a
 * copy would be keeping the thing the whole spec exists to prevent.
 */
export const ROUTING_RULES_TEMPLATE = defaultBody('instructions.observation_routing')

/**
 * The activity-specific reference: KSA rubric + participant roster, as markdown.
 *
 * The evidence levels listed are the WORKSHOP's points, in its own numbers, with
 * each point's label beside its descriptor. A router that is shown four levels
 * and asked for one of six has been given a contradiction.
 */
export function buildReferenceBlock(
  ksas: ResolvedKsa[],
  participants: Participant[],
  scale: Scale = DEFAULT_SCALE,
): string {
  const range = `${minValue(scale)}-${maxValue(scale)}`
  const ksaLines = ksas
    .map((k) => {
      const levels = k.evidence_levels ?? {}
      const levelText = scale.points
        .map((p) => `    ${p.value} (${p.label}): ${levels[String(p.value)] ?? '(unspecified)'}`)
        .join('\n')
      return `- ${k.code} — ${k.goal_title}\n  Prompt: ${k.evaluator_facing_prompt}\n  Rubric: ${k.ai_facing_rubric ?? ''}\n  Evidence levels (${range}):\n${levelText}`
    })
    .join('\n\n')

  const roster = participants
    .map((p) => `- ${p.name} (id: ${p.id}, team: ${p.team_id ?? 'n/a'})`)
    .join('\n')

  return `KSAs in scope (use only these codes):\n\n${ksaLines}\n\nParticipant roster (match names to these; use the id in participant_id when matched):\n${roster}`
}

/**
 * The JSON schema each routed output file must match, for one workshop's scale.
 *
 * `evidence_designation` is an integer enum of the workshop's OWN values, so a
 * 1-5 workshop's schema refuses a 0. Kept as a plain object so it can be
 * serialized to routing/reference/schema.json for Claude to read, and built by a
 * function because the enum is no longer a constant.
 */
export function observationsSchema(scale: Scale = DEFAULT_SCALE) {
  return {
    ...OBSERVATIONS_SCHEMA_SHAPE,
    properties: {
      observations: {
        ...OBSERVATIONS_SCHEMA_SHAPE.properties.observations,
        items: {
          ...OBSERVATIONS_SCHEMA_SHAPE.properties.observations.items,
          properties: {
            ...OBSERVATIONS_SCHEMA_SHAPE.properties.observations.items.properties,
            evidence_designation: { type: 'integer', enum: scaleValues(scale) },
          },
        },
      },
    },
  }
}

const OBSERVATIONS_SCHEMA_SHAPE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          participant_name: { type: 'string', description: 'Name exactly as the evaluator wrote it' },
          participant_id: {
            type: ['string', 'null'],
            description: 'Roster id if the name matches a participant, else null',
          },
          ksa_code: { type: 'string', description: 'One of the in-scope KSA codes' },
          text: { type: 'string', description: 'Concise English summary of the observation' },
          source_excerpt: { type: 'string', description: 'Verbatim span from the source text' },
          evidence_designation: { type: 'integer', enum: [0, 1, 2, 3] as number[] },
          sentiment_flag: { type: 'string', enum: ['strong', 'weak', 'neutral'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          needs_review: { type: 'boolean' },
          origin: { type: 'string', enum: ['individual', 'group'] },
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
          'needs_review',
          'origin',
        ],
      },
    },
  },
  required: ['observations'],
} as const

export interface RoutedObservation {
  participant_name: string
  participant_id: string | null
  ksa_code: string
  text: string
  source_excerpt: string
  /** A point on the workshop's scale. Checked by `isOnScale`, not by the type. */
  evidence_designation: number
  sentiment_flag: 'strong' | 'weak' | 'neutral'
  confidence: 'low' | 'medium' | 'high'
  needs_review: boolean
  origin: 'individual' | 'group'
}

/**
 * Runtime validation of one observation produced by Claude (the output is
 * Claude-authored markdown/JSON in a repo, so the app cannot trust it blindly).
 * Returns the typed observation or a human-readable reason it was rejected.
 *
 * SHAPE ONLY, on purpose. The designation is checked to be an integer here and
 * checked against the workshop's SCALE by `isOnScale`, in a second pass, because
 * which workshop a routed file belongs to is resolved from the participants it
 * names — which cannot be read until the file has been shape-validated. Two
 * passes, in that order, rather than one pass that guesses the workshop.
 */
export function validateObservation(o: unknown): { ok: true; value: RoutedObservation } | { ok: false; reason: string } {
  if (typeof o !== 'object' || o === null) return { ok: false, reason: 'not an object' }
  const r = o as Record<string, unknown>
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
  for (const k of ['participant_name', 'ksa_code', 'text', 'source_excerpt']) {
    if (!str(k)) return { ok: false, reason: `missing/invalid ${k}` }
  }
  if (typeof r.evidence_designation !== 'number' || !Number.isInteger(r.evidence_designation))
    return { ok: false, reason: 'evidence_designation is not an integer' }
  if (!['strong', 'weak', 'neutral'].includes(r.sentiment_flag as string))
    return { ok: false, reason: 'bad sentiment_flag' }
  if (!['low', 'medium', 'high'].includes(r.confidence as string))
    return { ok: false, reason: 'bad confidence' }
  if (!['individual', 'group'].includes(r.origin as string))
    return { ok: false, reason: 'bad origin' }
  if (typeof r.needs_review !== 'boolean') return { ok: false, reason: 'needs_review not boolean' }
  const pid = r.participant_id
  if (pid !== null && typeof pid !== 'string') return { ok: false, reason: 'participant_id not string|null' }
  return { ok: true, value: r as unknown as RoutedObservation }
}

/**
 * The second half of the check: is this designation a point on the workshop's
 * scale? Separate from `validateObservation` because the workshop is only known
 * after the file's participants have been resolved.
 */
export function isOnScale(o: RoutedObservation, scale: Scale): boolean {
  return isValidDesignation(o.evidence_designation, scale)
}
