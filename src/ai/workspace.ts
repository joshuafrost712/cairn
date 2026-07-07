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

import type { Activity, Ksa, Participant, Workshop } from '../lib/types'
import { ROUTING_RULES, OBSERVATIONS_SCHEMA, type RoutedObservation } from './contract'

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
    area: string
    evaluator_facing_prompt: string
    ai_facing_rubric: string | null
    evidence_levels: Record<string, string | undefined> | null
  }[]
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
  ksasInScope: Ksa[]
  participantScope: { name: string; participant_id?: string }[]
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
      area: k.area,
      evaluator_facing_prompt: k.evaluator_facing_prompt,
      ai_facing_rubric: k.ai_facing_rubric,
      evidence_levels: k.evidence_levels ?? null,
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
export function renderRoutingDoc(): string {
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

${ROUTING_RULES}

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

/** routing/reference/rubric.md — the full KSA rubric. */
export function renderRubricDoc(ksas: Ksa[]): string {
  const body = ksas
    .map((k) => {
      const levels = k.evidence_levels ?? {}
      const levelText = (['0', '1', '2', '3'] as const)
        .map((n) => `- **${n}** — ${levels[n] ?? '(unspecified)'}`)
        .join('\n')
      return `## ${k.code} — ${k.area}

**Evaluator prompt:** ${k.evaluator_facing_prompt}

**Rubric:** ${k.ai_facing_rubric ?? ''}

**Evidence levels (0–3, DRAFT placeholders):**
${levelText}

**CBC sub-points:** ${k.cbc_subpoint_refs.join('; ')}`
    })
    .join('\n\n')
  return `# KSA rubric (reference)

The KSA areas for the Psalms Workshop (OBT CDT Workshop 3, Bali 2026), including the
interpersonal-interaction competency observed in the teaching sessions. Evidence
levels are draft placeholders pending facilitator authoring.

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
export function renderSchemaJson(): string {
  return JSON.stringify(OBSERVATIONS_SCHEMA, null, 2) + '\n'
}
