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

import type { Ksa, Participant } from '../lib/types'

// The routing instructions. Identical for every capture; rendered verbatim into
// routing/ROUTING.md so Claude (via Max) follows the same contract every run.
export const ROUTING_RULES = `You are the routing step of an Oral Bible Translation (OBT) consultant-development workshop evaluation system.

An evaluator dictated or typed free-form observations while watching one or more participants during a workshop activity. Turn that raw text into atomic, individual-level observations.

Rules:
- Produce one observation per (participant, KSA) claim. Split compound statements.
- Attribute every observation to a single participant by the name the evaluator used. If the evaluator made a whole-group remark, emit one observation per named participant in scope, each with origin "group".
- Only use the KSA codes provided in the reference. If a statement does not map to any provided KSA, omit it (do not invent a KSA).
- Assign evidence_designation 0-3 strictly from that KSA's evidence levels. The evaluator's text is the only evidence; do not infer beyond it.
- A line like "(Evaluator quick read, prior only: 2/3)" is the evaluator's own optional read, NOT ground truth. Treat it as a weak prior: rate from the observation text, and when the text clearly disagrees with the prior, follow the text and set needs_review true so the gate can reconcile.
- Quote the relevant span of the source in source_excerpt; put your own concise English summary in text.
- sentiment_flag: "strong" for clearly strong performance, "weak" for clearly weak, else "neutral".
- confidence: "high" only when the attribution and designation are clearly supported; "low" when the participant is ambiguous, the KSA mapping is a stretch, or the evidence is too thin to rate.
- Set needs_review true when confidence is "low", when the participant cannot be matched to the roster, or when you had to guess the designation. Never guess silently.
- Return only observations grounded in the text. An empty list is a valid answer.`

/** The activity-specific reference: KSA rubric + participant roster, as markdown. */
export function buildReferenceBlock(ksas: Ksa[], participants: Participant[]): string {
  const ksaLines = ksas
    .map((k) => {
      const levels = k.evidence_levels ?? {}
      const levelText = (['0', '1', '2', '3'] as const)
        .map((n) => `    ${n}: ${levels[n] ?? '(unspecified)'}`)
        .join('\n')
      return `- ${k.code} — ${k.area}\n  Prompt: ${k.evaluator_facing_prompt}\n  Rubric: ${k.ai_facing_rubric ?? ''}\n  Evidence levels (0-3):\n${levelText}`
    })
    .join('\n\n')

  const roster = participants
    .map((p) => `- ${p.name} (id: ${p.id}, team: ${p.team_id ?? 'n/a'})`)
    .join('\n')

  return `KSAs in scope (use only these codes):\n\n${ksaLines}\n\nParticipant roster (match names to these; use the id in participant_id when matched):\n${roster}`
}

// JSON schema each routed output file must match. 0-3 is an integer enum;
// confidence/sentiment/origin are string enums. Kept as a plain object so it can
// be serialized to routing/reference/schema.json for Claude to read.
export const OBSERVATIONS_SCHEMA = {
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
          evidence_designation: { type: 'integer', enum: [0, 1, 2, 3] },
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
  evidence_designation: 0 | 1 | 2 | 3
  sentiment_flag: 'strong' | 'weak' | 'neutral'
  confidence: 'low' | 'medium' | 'high'
  needs_review: boolean
  origin: 'individual' | 'group'
}

/**
 * Runtime validation of one observation produced by Claude (the output is
 * Claude-authored markdown/JSON in a repo, so the app cannot trust it blindly).
 * Returns the typed observation or a human-readable reason it was rejected.
 */
export function validateObservation(o: unknown): { ok: true; value: RoutedObservation } | { ok: false; reason: string } {
  if (typeof o !== 'object' || o === null) return { ok: false, reason: 'not an object' }
  const r = o as Record<string, unknown>
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
  for (const k of ['participant_name', 'ksa_code', 'text', 'source_excerpt']) {
    if (!str(k)) return { ok: false, reason: `missing/invalid ${k}` }
  }
  if (![0, 1, 2, 3].includes(r.evidence_designation as number))
    return { ok: false, reason: 'evidence_designation not 0-3' }
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
