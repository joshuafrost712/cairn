// The scenario-authoring contract — the single source of truth for what the AI
// draft-fill must produce, mirroring the discipline of src/ai/contract.ts.
//
// A facilitator uploads a curriculum / competency document; an LLM turns it into a
// draft scenario (events + questions + wiring) that the Scenario Builder lands as
// EDITABLE rows. The output is never trusted blindly or auto-committed: it is
// validated here, then reviewed and corrected by a human in the Builder before it
// persists (same human-ratification philosophy as docs/ai-transparency.md).
//
// Transport is provider-agnostic. The primary path posts the document to the
// Supabase Edge Function `draft-scenario` (which holds the Gemini key server-side);
// a token-free copy/paste path lets the author run it in their own LLM. Both use
// the SAME prompt + schema defined here, so what we validate is what the model was
// asked for.
//
// tl-16 MOVED THE PROSE OUT AND LEFT THE SHAPE. The rules paragraph is now one entry in
// src/templates/defaults.ts, so an administrator can reword it; `renderScenarioSchema`
// and the validators below stayed exactly where they were, because an editable schema is
// an app that can be edited into accepting invalid data. That line runs through this
// whole spec and this file is where it is sharpest: guidance is authored, contract is
// compiled.

import { defaultBody } from '../templates/defaults'
import { fillTemplateTokens } from '../templates/interpolate'
import { bodyFor, getActiveTemplates } from '../templates/resolve'

/**
 * One point of the scale the drafter must write descriptors for.
 *
 * Not the full `ScalePoint`: a prompt needs the number and the word, and nothing
 * about Dexie keys or trigger flags belongs in a model's input.
 */
export interface DraftScalePoint {
  value: number
  label: string
}

/** The app's original 0-3 scale, for a workshop that has authored none. */
export const DEFAULT_DRAFT_SCALE: DraftScalePoint[] = [
  { value: 0, label: 'not yet demonstrated' },
  { value: 1, label: 'emerging' },
  { value: 2, label: 'competent' },
  { value: 3, label: 'strong' },
]

const scaleSentence = (points: DraftScalePoint[]): string => {
  const list = points.map((p) => `"${p.value}" (${p.label})`).join(', ')
  const lowest = points[0]
  const highest = points[points.length - 1]
  return `an object with EXACTLY these keys, one per point on this workshop's grading scale: ${list}. Each value describes what observed evidence earns that rating; ${lowest.value} is the bottom of the scale ("${lowest.label}") and ${highest.value} is the top ("${highest.label}"). Do not invent extra keys and do not omit any.`
}

/**
 * The drafting rules, written against the workshop's OWN scale (tl-13, closing D2).
 *
 * This used to hardcode `"0","1","2","3"`, which was correct until tl-09 made the
 * scale configurable from two to six points and shipped. After that a workshop
 * running five points and drafting from a document got four descriptors, silently,
 * with no error anywhere — descriptors that contradicted its own grading scale.
 *
 * So the scale is a parameter, and `SCENARIO_RULES` below is what this function
 * returns for a workshop that has authored no scale: identical to the old text in
 * substance, so the regression case is the unchanged one.
 *
 * AUTHORABLE SINCE tl-16. The body is a second parameter for the reason `routingRules`
 * states: in the browser it defaults to the active workshop's override, and in the Edge
 * Function it is passed in from what the function read server-side. `{{scaleSentence}}`
 * is required by the validator, because a body that dropped it would ask a drafter to
 * invent its own descriptor keys — the exact defect tl-13 closed as D2.
 */
export function scenarioRules(points: DraftScalePoint[] = DEFAULT_DRAFT_SCALE, body?: string): string {
  const scale = points.length >= 2 ? points : DEFAULT_DRAFT_SCALE
  const text = body ?? bodyFor(getActiveTemplates(), 'instructions.scenario_draft')
  return fillTemplateTokens(text, { scaleSentence: scaleSentence(scale) })
}

/**
 * The rules for a workshop with no authored scale: the app's pre-tl-09 behaviour.
 *
 * Built from the SHIPPED body explicitly (tl-16), not from `scenarioRules()`'s default,
 * because this is a module-level constant: evaluating it at import time would freeze
 * whatever the template mirror happened to hold on the first import, which is nothing,
 * and would then keep returning that after the mirror was filled. Anything wanting the
 * workshop's authored rules calls `scenarioRules()`.
 */
export const SCENARIO_RULES = scenarioRules(DEFAULT_DRAFT_SCALE, defaultBody('instructions.scenario_draft'))

/**
 * JSON schema the drafted output must match, for the workshop's own scale.
 *
 * Built rather than declared for the same reason the rules are: `evidence_levels`
 * has one property per scale point, and a schema pinned to four of them tells a
 * five-point workshop's model to produce the wrong shape twice over — once in the
 * prose and once in the schema it is also handed.
 */
export function scenarioSchema(points: DraftScalePoint[] = DEFAULT_DRAFT_SCALE) {
  const scale = points.length >= 2 ? points : DEFAULT_DRAFT_SCALE
  const schema = structuredClone(SCENARIO_SCHEMA) as unknown as {
    properties: {
      ksas: { items: { properties: { evidence_levels: { properties: Record<string, unknown> } } } }
    }
  }
  schema.properties.ksas.items.properties.evidence_levels.properties = Object.fromEntries(
    scale.map((p) => [String(p.value), { type: 'string', description: p.label }]),
  )
  return schema
}

// JSON schema the drafted output must match (kept as a plain object so it can be
// handed to the model and serialized for the copy/paste prompt). The 0-3 shape is
// the default-scale case; `scenarioSchema()` rewrites `evidence_levels` for a
// workshop that has authored its own.
export const SCENARIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workshop: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        location: { type: ['string', 'null'] },
        start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
        end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
        languages: { type: 'array', items: { type: 'string' } },
      },
    },
    activities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          genre_group: { type: ['string', 'null'] },
          sort_order: { type: 'integer' },
        },
        required: ['title'],
      },
    },
    ksas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          area: { type: 'string' },
          short_label: { type: 'string' },
          description: { type: 'string' },
          evaluator_facing_prompt: { type: 'string' },
          evidence_levels: {
            type: 'object',
            properties: {
              '0': { type: 'string' },
              '1': { type: 'string' },
              '2': { type: 'string' },
              '3': { type: 'string' },
            },
          },
          guiding_questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['code', 'short_label', 'evaluator_facing_prompt'],
      },
    },
    wiring: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activity_title: { type: 'string' },
          ksa_codes: { type: 'array', items: { type: 'string' } },
        },
        required: ['activity_title', 'ksa_codes'],
      },
    },
  },
  required: ['activities', 'ksas', 'wiring'],
} as const

export interface DraftActivity {
  title: string
  genre_group?: string | null
  sort_order?: number
}

export interface DraftKsa {
  code: string
  area?: string
  short_label: string
  description?: string
  evaluator_facing_prompt: string
  /**
   * Descriptor per scale point, keyed by the point's own number as a string.
   *
   * Widened from `'0' | '1' | '2' | '3'` by tl-13, because tl-09 made the scale the
   * workshop's own: a five-point workshop's keys are whatever its points are. The
   * compile-time guarantee that went with the narrow type is replaced by
   * `evidenceLevelsForScale()`, which is called at the one boundary where a draft
   * becomes a stored question.
   */
  evidence_levels?: Record<string, string>
  guiding_questions?: string[]
}

export interface DraftWiring {
  activity_title: string
  ksa_codes: string[]
}

export interface ScenarioDraft {
  workshop?: {
    name?: string
    location?: string | null
    start_date?: string | null
    end_date?: string | null
    languages?: string[]
  }
  activities: DraftActivity[]
  ksas: DraftKsa[]
  wiring: DraftWiring[]
}

/**
 * A drafted question's descriptors, reshaped onto the workshop's actual scale.
 *
 * THE SECOND HALF OF D2, and the half a prompt cannot provide. Asking for the right
 * keys makes the right keys likely; it does not make them certain, and a model that
 * returns 0-3 for a five-point workshop must not be able to store descriptors for
 * points that workshop does not have. So every point on the scale gets an entry
 * (empty where the draft said nothing) and anything the scale does not define is
 * dropped.
 *
 * Dropped rather than remapped by position, deliberately. A 0-3 descriptor set
 * stretched onto 1-5 would put words the model wrote about "emerging" under a point
 * called something else, and an administrator reviewing the draft would have no way
 * to see that had happened. An empty box is obviously empty.
 */
export function evidenceLevelsForScale(
  levels: Record<string, string> | undefined,
  points: DraftScalePoint[],
): Record<string, string> {
  const scale = points.length >= 2 ? points : DEFAULT_DRAFT_SCALE
  const out: Record<string, string> = {}
  for (const p of scale) {
    const key = String(p.value)
    const value = levels?.[key]
    out[key] = typeof value === 'string' ? value : ''
  }
  return out
}

/**
 * Validate a drafted scenario before it seeds the editable Builder rows. Lenient
 * about optional fields, strict about the shape and the wiring referencing only
 * things that exist — a bad draft must never silently create broken content.
 */
export function validateScenarioDraft(
  o: unknown,
): { ok: true; value: ScenarioDraft } | { ok: false; reason: string } {
  if (typeof o !== 'object' || o === null) return { ok: false, reason: 'not an object' }
  const r = o as Record<string, unknown>
  if (!Array.isArray(r.activities)) return { ok: false, reason: 'activities is not an array' }
  if (!Array.isArray(r.ksas)) return { ok: false, reason: 'ksas is not an array' }
  const wiring = Array.isArray(r.wiring) ? r.wiring : []

  const titles = new Set<string>()
  for (const a of r.activities as unknown[]) {
    if (typeof a !== 'object' || a === null) return { ok: false, reason: 'an activity is not an object' }
    const title = (a as Record<string, unknown>).title
    if (typeof title !== 'string' || !title.trim()) return { ok: false, reason: 'an activity is missing a title' }
    titles.add(title)
  }

  const codes = new Set<string>()
  for (const k of r.ksas as unknown[]) {
    if (typeof k !== 'object' || k === null) return { ok: false, reason: 'a ksa is not an object' }
    const kk = k as Record<string, unknown>
    if (typeof kk.code !== 'string' || !kk.code.trim()) return { ok: false, reason: 'a ksa is missing a code' }
    if (typeof kk.short_label !== 'string' || !kk.short_label.trim())
      return { ok: false, reason: `ksa ${kk.code} is missing short_label` }
    if (typeof kk.evaluator_facing_prompt !== 'string')
      return { ok: false, reason: `ksa ${kk.code} is missing evaluator_facing_prompt` }
    codes.add(kk.code)
  }

  for (const w of wiring as unknown[]) {
    if (typeof w !== 'object' || w === null) return { ok: false, reason: 'a wiring entry is not an object' }
    const ww = w as Record<string, unknown>
    if (typeof ww.activity_title !== 'string' || !titles.has(ww.activity_title))
      return { ok: false, reason: `wiring references unknown activity "${String(ww.activity_title)}"` }
    if (!Array.isArray(ww.ksa_codes)) return { ok: false, reason: 'a wiring entry has no ksa_codes array' }
    for (const c of ww.ksa_codes) {
      if (typeof c !== 'string' || !codes.has(c))
        return { ok: false, reason: `wiring references unknown ksa code "${String(c)}"` }
    }
  }

  return { ok: true, value: o as ScenarioDraft }
}
