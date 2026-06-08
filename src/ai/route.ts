// Node routing function: free-form evaluation text -> structured per-participant
// observations. Uses the Anthropic SDK (Node); the Deno Edge Function mirrors this
// using the same prompt module. Both share src/ai/prompt.ts so the model contract
// is identical.

import Anthropic from '@anthropic-ai/sdk'
import type { Ksa, Participant } from '../lib/types'
import {
  ROUTING_MODEL,
  OBSERVATIONS_SCHEMA,
  buildSystemBlocks,
  buildUserContent,
  type RoutedObservation,
} from './prompt'
import { CostGuard, type Usage } from './cost'

export interface RouteInput {
  evaluationText: string
  participantScopeNames: string[]
  ksas: Ksa[]
  participants: Participant[]
}

export interface RouteResult {
  observations: RoutedObservation[]
  usage: Usage
}

function firstTextBlock(content: Anthropic.ContentBlock[]): string {
  const block = content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('No text block in response')
  return block.text
}

/** Resolve participant_id from the roster by name, and harden needs_review. */
function reconcile(obs: RoutedObservation[], participants: Participant[]): RoutedObservation[] {
  const byName = new Map(participants.map((p) => [p.name.trim().toLowerCase(), p.id]))
  return obs.map((o) => {
    const resolvedId = o.participant_id ?? byName.get(o.participant_name.trim().toLowerCase()) ?? null
    const needs_review = o.needs_review || o.confidence === 'low' || resolvedId === null
    return { ...o, participant_id: resolvedId, needs_review }
  })
}

/**
 * Route one evaluation. The static KSA rubric + roster go in cached system blocks;
 * the evaluation text is the volatile user content. Structured output guarantees
 * the shape. `costGuard` enforces the spend cap and logs the call.
 */
export async function routeEvaluation(
  client: Anthropic,
  input: RouteInput,
  costGuard: CostGuard,
  label = 'route',
): Promise<RouteResult> {
  costGuard.precheck()

  // `output_config` (structured output + effort) and adaptive thinking are current
  // API params that may outpace the installed SDK types — build loosely and cast.
  const params = {
    model: ROUTING_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: OBSERVATIONS_SCHEMA },
    },
    system: buildSystemBlocks(input.ksas, input.participants),
    messages: [
      { role: 'user', content: buildUserContent(input.evaluationText, input.participantScopeNames) },
    ],
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = (await client.messages.create(params as any)) as Anthropic.Message

  const usage = response.usage as unknown as Usage
  costGuard.record(label, usage)

  const parsed = JSON.parse(firstTextBlock(response.content)) as { observations: RoutedObservation[] }
  const observations = reconcile(parsed.observations ?? [], input.participants)
  return { observations, usage }
}
