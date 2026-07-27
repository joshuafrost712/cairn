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

export const SCENARIO_RULES = `You design evaluation scenarios for an Oral Bible Translation (OBT) consultant-development workshop.

You are given a curriculum, syllabus, or competency document. Turn it into a workshop evaluation scenario as JSON with four parts:

1. "workshop" (optional): a name, and location/dates/languages if the document states them.
2. "activities": the sessions/events an evaluator would observe (teaching sessions, practicums, checking sessions). Each has a short "title", optionally a "genre_group" label, and its order in "sort_order" (0-based).
3. "ksas": the competencies being evaluated ("questions"). Each has:
   - "code": a short unique uppercase code you assign (e.g. EXEG, CHECK, DRAFT1).
   - "area": the broad competency area.
   - "short_label": a scannable heading for the capture card.
   - "description": one or two sentences on what it assesses.
   - "evaluator_facing_prompt": a neutral observation cue ("How did they…?"), NOT a yes/no question.
   - "evidence_levels": an object with keys "0","1","2","3" describing what observed evidence earns each rating, 0 = no/negative evidence, 3 = strong mastery. Ground these in the document; keep them concrete and behavioral.
   - "guiding_questions": 2-4 concrete "look/listen for" prompts.
4. "wiring": which questions appear on which event. Each entry is { "activity_title": <one of the activity titles>, "ksa_codes": [<codes from your ksas>] }.

Rules:
- Derive everything from the document. Do not invent competencies the document does not support; a smaller, faithful scenario is better than a padded one.
- Every ksa_code used in "wiring" MUST be defined in "ksas", and every activity_title MUST match an activity "title" exactly.
- Codes are unique within your output.
- Return ONLY the JSON object, no prose, no markdown fences.`

// JSON schema the drafted output must match (kept as a plain object so it can be
// handed to the model and serialized for the copy/paste prompt).
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
  evidence_levels?: Partial<Record<'0' | '1' | '2' | '3', string>>
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
