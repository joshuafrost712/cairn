// Supabase Edge Function (Deno): route one evaluation into individual-level
// observations and persist them. DEFERRED-DEPLOY — this is the production wrapper
// around the same routing contract the Node harness uses (src/ai/prompt.ts).
//
// Deploy:  supabase functions deploy route-evaluation
// Secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          CLAUDE_MONTHLY_SPEND_CAP_USD (optional, default 50)
//
// POST { "evaluation_id": "<uuid>" }
//
// Note: imports the shared prompt module by relative path so the model contract
// stays in one place. If your bundler can't resolve the cross-dir import at deploy,
// copy src/ai/prompt.ts beside this file — do not fork the logic.

import Anthropic from 'npm:@anthropic-ai/sdk@^0.69'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  ROUTING_MODEL,
  OBSERVATIONS_SCHEMA,
  buildSystemBlocks,
  buildUserContent,
  type RoutedObservation,
} from '../../../src/ai/prompt.ts'
import { costOf, type Usage } from '../../../src/ai/cost.ts'

const env = (k: string) => Deno.env.get(k) ?? ''
const CAP_USD = Number(env('CLAUDE_MONTHLY_SPEND_CAP_USD') || '50')

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') })

async function monthSpendUSD(): Promise<number> {
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('claude_call_log')
    .select('cost_usd')
    .gte('created_at', since.toISOString())
  if (error) throw error
  return (data ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
}

Deno.serve(async (req) => {
  try {
    const { evaluation_id } = await req.json()
    if (!evaluation_id) return json({ error: 'evaluation_id required' }, 400)

    if ((await monthSpendUSD()) >= CAP_USD) return json({ error: 'monthly spend cap reached' }, 429)

    // Fetch the evaluation, its activity's KSAs, and the workshop roster.
    const { data: evalRow, error: e1 } = await supabase
      .from('evaluation')
      .select('id, activity_id, workshop_id, source_text, participant_scope')
      .eq('id', evaluation_id)
      .single()
    if (e1 || !evalRow) return json({ error: 'evaluation not found' }, 404)

    const { data: links } = await supabase
      .from('activity_ksa')
      .select('ksa_id, sort_order')
      .eq('activity_id', evalRow.activity_id)
      .order('sort_order')
    const ksaIds = (links ?? []).map((l) => l.ksa_id)
    const { data: ksas } = await supabase.from('ksa').select('*').in('id', ksaIds)
    const { data: participants } = await supabase
      .from('participant')
      .select('*')
      .eq('workshop_id', evalRow.workshop_id)

    const scopeNames = Array.isArray(evalRow.participant_scope)
      ? evalRow.participant_scope.map((s: { name: string }) => s.name)
      : []

    const response = await anthropic.messages.create({
      model: ROUTING_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: OBSERVATIONS_SCHEMA } },
      system: buildSystemBlocks(ksas ?? [], participants ?? []),
      messages: [{ role: 'user', content: buildUserContent(evalRow.source_text ?? '', scopeNames) }],
    } as Anthropic.MessageCreateParamsNonStreaming)

    const usage = response.usage as unknown as Usage
    await supabase.from('claude_call_log').insert({
      label: 'route-evaluation',
      evaluation_id,
      model: ROUTING_MODEL,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costOf(usage),
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    const parsed = JSON.parse(textBlock && textBlock.type === 'text' ? textBlock.text : '{"observations":[]}')
    const byName = new Map((participants ?? []).map((p) => [p.name.trim().toLowerCase(), p.id]))

    const rows = (parsed.observations as RoutedObservation[]).map((o) => {
      const participant_id =
        o.participant_id ?? byName.get(o.participant_name.trim().toLowerCase()) ?? null
      const ksa = (ksas ?? []).find((k) => k.code === o.ksa_code)
      return {
        evaluation_id,
        participant_id,
        ksa_id: ksa?.id ?? null,
        activity_id: evalRow.activity_id,
        text: o.text,
        source_excerpt: o.source_excerpt,
        sentiment_flag: o.sentiment_flag,
        evidence_designation: o.evidence_designation,
        ai_confidence: o.confidence === 'high' ? 0.9 : o.confidence === 'medium' ? 0.6 : 0.3,
        routing_status: o.needs_review || participant_id === null ? 'needs_review' : 'auto',
        reporting_locked_until_verified: true,
        origin: o.origin,
      }
    })

    if (rows.length) {
      const { error: e2 } = await supabase.from('observation').insert(rows)
      if (e2) return json({ error: e2.message }, 500)
    }

    return json({ inserted: rows.length, needs_review: rows.filter((r) => r.routing_status === 'needs_review').length })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
