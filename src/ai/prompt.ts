// Routing prompt construction — runtime-agnostic (no SDK import), so the same
// logic is shared by the Node calibration harness (src/ai/route.ts) and the
// Supabase Edge Function (supabase/functions/route-evaluation). It builds:
//  - the system blocks (frozen instructions + the activity's KSA rubric + roster),
//    with prompt-cache breakpoints on the static content
//  - the JSON-schema for structured output (one object per atomic observation)
//  - the user content (the evaluation's free-form text)
//
// Model + pricing live here too so both runtimes agree.

import type { Ksa, Participant } from '../lib/types'

export const ROUTING_MODEL = 'claude-opus-4-8'

// USD per 1M tokens for ROUTING_MODEL (claude-opus-4-8).
export const PRICING = {
  inputPerM: 5.0,
  outputPerM: 25.0,
  cacheWritePerM: 6.25, // 1.25x input
  cacheReadPerM: 0.5, //   0.1x input
}

// Frozen instruction block — identical for every routing call, so it caches.
const SYSTEM_PREAMBLE = `You are the routing layer of an Oral Bible Translation (OBT) consultant-development workshop evaluation system.

An evaluator has dictated or typed free-form observations while watching one or more participants during a workshop activity. Your job is to turn that raw text into atomic, individual-level observations.

Rules:
- Produce one observation per (participant, KSA) claim. Split compound statements.
- Attribute every observation to a single participant by the name the evaluator used. If the evaluator made a whole-group remark, emit one observation per named participant in scope, each with origin "group".
- Only use the KSA codes provided below. If a statement does not map to any provided KSA, omit it (do not invent a KSA).
- Assign evidence_designation 0-3 strictly from that KSA's evidence_levels. The evaluator's text is the only evidence; do not infer beyond it.
- Quote the relevant span of the source in source_excerpt; put your own concise English summary in text.
- sentiment_flag: "strong" for clearly strong performance, "weak" for clearly weak, else "neutral".
- confidence: "high" only when the attribution and designation are clearly supported; "low" when the participant is ambiguous, the KSA mapping is a stretch, or the evidence is too thin to rate.
- Set needs_review true when confidence is "low", when the participant cannot be matched to the roster, or when you had to guess the designation. Never guess silently.
- Return only observations grounded in the text. An empty list is a valid answer.`

/** Build the activity-specific reference block: KSA rubric + participant roster. */
function buildReferenceBlock(ksas: Ksa[], participants: Participant[]): string {
  const ksaLines = ksas
    .map((k) => {
      const levels = k.evidence_levels ?? {}
      const levelText = (['0', '1', '2', '3'] as const)
        .map((n) => `    ${n}: ${levels[n] ?? '(unspecified)'}`)
        .join('\n')
      return `- ${k.code} — ${k.area}\n  Prompt: ${k.evaluator_facing_prompt}\n  Rubric: ${k.ai_facing_rubric ?? ''}\n  Evidence levels (0-3):\n${levelText}`
    })
    .join('\n\n')

  const roster = participants.map((p) => `- ${p.name} (id: ${p.id}, team: ${p.team_id ?? 'n/a'})`).join('\n')

  return `KSAs in scope for this activity (use only these codes):\n\n${ksaLines}\n\nParticipant roster (match names to these; use the id in participant_id when matched):\n${roster}`
}

/**
 * System content as cacheable text blocks. The frozen preamble and the
 * activity reference block are stable across every evaluation in the same
 * activity, so we mark the last block for caching — repeated routing calls
 * for one activity read the rubric+roster from cache.
 */
export function buildSystemBlocks(ksas: Ksa[], participants: Participant[]) {
  return [
    { type: 'text' as const, text: SYSTEM_PREAMBLE },
    {
      type: 'text' as const,
      text: buildReferenceBlock(ksas, participants),
      cache_control: { type: 'ephemeral' as const },
    },
  ]
}

/** The volatile per-call input: the evaluation text to route. */
export function buildUserContent(evaluationText: string, participantScopeNames: string[]): string {
  const scope = participantScopeNames.length
    ? `Participants the evaluator indicated they were watching: ${participantScopeNames.join(', ')}.\n\n`
    : ''
  return `${scope}Evaluator's observations to route:\n\n${evaluationText}`
}

// JSON schema for structured output. Structured outputs don't support numeric
// min/max, so 0-3 is expressed as an integer enum and confidence as a string enum.
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
