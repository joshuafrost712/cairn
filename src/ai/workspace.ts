// Renders the GitHub routing workspace (the routing/ folder) from the contract +
// seed/reference data, and defines the capture/observation file shapes exchanged
// through the repo. Runtime-agnostic (used by scripts/routing-prepare.ts and by
// the in-app exporter/importer in src/routing/).
//
// The workflow this enables (no metered API — uses Claude Max on a repo):
//   app  -> writes routing/inbox/<id>.json   (a capture, self-contained)
//   you  -> open Claude on the repo, "route the inbox per ROUTING.md"
//   Claude -> writes routing/outbox/<id>.json (observations matching schema.json)
//   app  -> imports routing/outbox/*.json back into the device store

import type { ResolvedKsa } from '../lib/goals'
import type { Activity, Participant, Workshop } from '../lib/types'
import { observationsSchema, routingRules, type RoutedObservation } from './contract'
import { DEFAULT_SCALE, maxValue, minValue, type Scale } from '../lib/scale'

export const CAPTURE_SCHEMA_ID = 'cairn.capture/v1'
export const OBSERVATIONS_FILE_SCHEMA_ID = 'cairn.observations/v1'

/** A self-contained capture written to routing/inbox/<client_id>.json. */
export interface CaptureFile {
  schema: typeof CAPTURE_SCHEMA_ID
  capture_client_id: string
  workshop: { id: string | null; name: string | null }
  activity: { id: string | null; title: string | null; day: string | null }
  evaluator_email: string | null
  source_language: string
  /** Who the evaluator was watching; Claude attributes observations to these. */
  participant_scope: { name: string; participant_id?: string }[]
  /** KSAs in scope for this activity, inlined so the file is routable on its own. */
  ksas_in_scope: {
    code: string
    goal_title: string
    evaluator_facing_prompt: string
    ai_facing_rubric: string | null
    evidence_levels: Record<string, string | undefined> | null
  }[]
  /**
   * The workshop's grading scale, inlined (tl-09).
   *
   * The file is routable on its own — that is the whole point of inlining the
   * KSAs — and a router handed evidence-level descriptors with no statement of
   * what the legal answers ARE has to infer the range from the descriptor keys.
   * It gets that right until a workshop authors descriptors for only some of its
   * points, which is the normal state of a workshop mid-setup.
   */
  scale: { value: number; label: string; is_low_trigger: boolean }[]
  source_text: string
  ruleset_version: string | null
  created_at: string
}

/** The file Claude writes to routing/outbox/<client_id>.json. */
export interface ObservationsFile {
  schema: typeof OBSERVATIONS_FILE_SCHEMA_ID
  capture_client_id: string
  routed_at: string
  observations: RoutedObservation[]
}

export interface CaptureContext {
  workshop: Pick<Workshop, 'id' | 'name'> | null
  activity: Pick<Activity, 'id' | 'title' | 'day'> | null
  ksasInScope: ResolvedKsa[]
  participantScope: { name: string; participant_id?: string }[]
  /** The capture's own workshop's scale. Defaults to the app's original 0-3. */
  scale?: Scale
}

/** Build the inbox capture file for one evaluation. */
export function buildCaptureFile(
  args: {
    client_id: string
    evaluator_email: string | null
    source_language: string
    source_text: string
    ruleset_version: string | null
    created_at: string
  },
  ctx: CaptureContext,
): CaptureFile {
  return {
    schema: CAPTURE_SCHEMA_ID,
    capture_client_id: args.client_id,
    workshop: { id: ctx.workshop?.id ?? null, name: ctx.workshop?.name ?? null },
    activity: { id: ctx.activity?.id ?? null, title: ctx.activity?.title ?? null, day: ctx.activity?.day ?? null },
    evaluator_email: args.evaluator_email,
    source_language: args.source_language,
    participant_scope: ctx.participantScope,
    ksas_in_scope: ctx.ksasInScope.map((k) => ({
      code: k.code,
      goal_title: k.goal_title,
      evaluator_facing_prompt: k.evaluator_facing_prompt,
      ai_facing_rubric: k.ai_facing_rubric,
      evidence_levels: k.evidence_levels ?? null,
    })),
    scale: (ctx.scale ?? DEFAULT_SCALE).points.map((p) => ({
      value: p.value,
      label: p.label,
      is_low_trigger: p.is_low_trigger,
    })),
    source_text: args.source_text,
    ruleset_version: args.ruleset_version,
    created_at: args.created_at,
  }
}

const INBOX = 'routing/inbox'
const OUTBOX = 'routing/outbox'

export const inboxPath = (clientId: string) => `${INBOX}/${clientId}.json`
export const outboxPath = (clientId: string) => `${OUTBOX}/${clientId}.json`

// ---- generated workspace docs --------------------------------------------

/** routing/ROUTING.md — the runbook Claude (via Max) follows on the repo. */
export function renderRoutingDoc(scale: Scale = DEFAULT_SCALE): string {
  return `# Routing runbook (for Claude)

This repo is the routing substrate for the Cairn participant-evaluation app. **No
metered API is used** — routing is done by Claude operating directly on this repo
(via a Claude Max subscription, on phone or desktop). You are that Claude.

## Your job

For every file in \`inbox/\` that does **not** already have a matching file in
\`outbox/\` (same filename), read the capture and produce its observations.

Each \`inbox/<id>.json\` is a self-contained capture: it inlines the KSAs in scope
(with draft evidence levels) and the participant scope, so you do not need any
other file to route it. \`reference/rubric.md\` and \`reference/roster.md\` give the
full picture if you want it; \`reference/schema.json\` is the exact output shape.

## The routing contract

${routingRules(scale)}

## Output

For each \`inbox/<id>.json\` you route, write \`outbox/<id>.json\` (same \`<id>\`) as:

\`\`\`json
{
  "schema": "${OBSERVATIONS_FILE_SCHEMA_ID}",
  "capture_client_id": "<id>",
  "routed_at": "<ISO 8601 timestamp>",
  "observations": [ /* objects matching reference/schema.json */ ]
}
\`\`\`

Do not modify anything in \`inbox/\`. Commit the new \`outbox/\` files. The app then
imports \`outbox/\` and clears its sent queue. An empty \`observations\` array is a
valid result when a capture contains nothing routable.

Ignore the \`verdicts/\` folder if present: it is app-managed (evaluators' confirmations
synced between devices) and is not part of routing.

> Evidence-level descriptors are DRAFT placeholders pending facilitator authoring.
> Apply them as written; when they are too thin to rate confidently, set
> \`needs_review\` true rather than guessing.
`
}

/**
 * routing/reference/rubric.md — the full question rubric.
 *
 * PARAMETERIZED BY WORKSHOP SINCE tl-15, and it had to be. The heading and the intro
 * sentence named the Psalms Workshop in Bali outright, and the per-question heading said
 * every descriptor was a draft placeholder — both hardcoded, both written when this app had
 * one workshop. tl-08 gave questions a workshop and tl-17 gave the deployment several, so
 * this document was telling every other workshop's router that it was reading Bali's rubric
 * and that its authored descriptors were placeholders. tl-15's brief pack is what surfaced
 * it: a pack generated for the OBT Crash Course carried that sentence.
 *
 * The placeholder caveat is now per question and conditional, so it says the true thing:
 * a question with every descriptor authored no longer calls them drafts, and one with gaps
 * still warns. Defaults reproduce the old behaviour for a caller that passes nothing except
 * the name, which is what keeps `scripts/routing-prepare.ts` honest without a rewrite.
 */
export function renderRubricDoc(
  ksas: ResolvedKsa[],
  scale: Scale = DEFAULT_SCALE,
  workshop: { name?: string | null; goalLabel?: string } = {},
): string {
  const goalWord = workshop.goalLabel ?? 'question group'
  const body = ksas
    .map((k) => {
      const levels = k.evidence_levels ?? {}
      const missing = scale.points.filter((p) => !levels[String(p.value)])
      const levelText = scale.points
        .map((p) => `- **${p.value}** (${p.label}) — ${levels[String(p.value)] ?? '(unspecified)'}`)
        .join('\n')
      return `## ${k.code} — ${k.goal_title}

**Evaluator prompt:** ${k.evaluator_facing_prompt}

**Rubric:** ${k.ai_facing_rubric ?? ''}

**Evidence levels (${minValue(scale)}–${maxValue(scale)}${missing.length ? ', some still unwritten' : ''}):**
${levelText}
${missing.length ? `\n> ${missing.length} of these ${scale.points.length} points has no descriptor yet. Where a level is too thin to rate confidently, set \`needs_review\` rather than guessing.\n` : ''}
**CBC sub-points:** ${k.cbc_subpoint_refs.join('; ')}`
    })
    .join('\n\n')
  return `# Question rubric (reference)

Every question ${workshop.name ? `**${workshop.name}**` : 'this workshop'} assesses, grouped by ${goalWord.toLowerCase()}, with the wording an evaluator sees and the rubric a router works from.

${body}
`
}

/** routing/reference/roster.md — teams + participants. */
export function renderRosterDoc(participants: Participant[], teamName: (id: string | null) => string): string {
  const rows = participants
    .map((p) => `| ${p.name} | ${teamName(p.team_id)} | \`${p.id}\` |`)
    .join('\n')
  return `# Participant roster (reference)

Match the names evaluators use to these participants; put the \`id\` in
\`participant_id\` when matched, else null and set \`needs_review\`.

| Name | Team | id |
|---|---|---|
${rows}
`
}

/** routing/reference/schema.json — the output JSON schema. */
export function renderSchemaJson(scale: Scale = DEFAULT_SCALE): string {
  return JSON.stringify(observationsSchema(scale), null, 2) + '\n'
}
