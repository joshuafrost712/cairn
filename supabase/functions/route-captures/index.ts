// route-captures — route ONE capture into per-individual observations, server-side,
// on the deployment's own Anthropic key (tl-23).
//
// draft-scenario's shape, copied exactly, departing in three named places:
//
//   1. THE SYSTEM PROMPT IS BUILT SERVER-SIDE, from the same `relayRoutingSystem()`
//      the relay uses — imported as the generated bundle in _shared/ so the runbook
//      and the unattended prompt stay one text (see scripts/bundle-relay-prompts.mjs
//      for why a bundle rather than a direct import). The scale is read from
//      `scale_point` with the service-role client, exactly as draft-scenario
//      re-reads it and for the same reason: an administrator's device whose cached
//      scale predates another administrator's switch to five points would otherwise
//      route against four, and the import boundary would then reject every
//      observation with no explanation anyone could act on. The capture arrives
//      from the client because it is participant evidence the caller is already
//      authorized to route; the instructions do not, because they are the part
//      that has to be right.
//
//   2. THE MODEL IS READ FROM THE DATABASE, not the request. A model id arriving
//      in a request body is a caller choosing what to spend, which is the one
//      thing the authorization check exists to decide.
//
//   3. THIS FUNCTION IS THE ONLY WRITER OF THE TOKEN COUNTS. It inserts its own
//      ai_call_log row with the real usage, because the server is where the spend
//      is known and a client that closes its tab mid-fan-out would otherwise
//      leave the money unrecorded and the ceiling under-counting. The client
//      provider returns null token counts on this path so no number appears twice.
//
// TWO GATES BEFORE THE MODEL, in order: ai_call_permitted (may this caller spend
// this workshop's budget on this function — tl-13) and ai_spend_permitted (may the
// deployment spend money at all: hosted AI switched on, daily ceiling not reached —
// this spec). Both are RPCs asked with the service-role key, so neither answer can
// depend on what the client sent.
//
// ONE CAPTURE PER INVOCATION, fanned out by the client. Each capture file is
// self-contained (rubric + roster ride along), so batching N captures multiplies
// the dominant input by N and buys only fewer invocations — at the cost of one
// wall-clock ceiling for a whole day's work and a retry that re-sends what already
// succeeded. Per-capture calls give bounded time, isolated failures, and a natural
// retry: a capture whose observations imported is no longer pending.
//
// Config: supabase secrets set ANTHROPIC_API_KEY=...
// Optional ANTHROPIC_ROUTING_MODEL is deliberately NOT read: the model is the
// workshop's ai_config choice or the default in _shared/anthropic.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ANTHROPIC_CALLABLE_MODELS,
  AnthropicHttpError,
  callAnthropic,
  DEFAULT_ROUTING_MODEL,
  extractJsonObject,
} from '../_shared/anthropic.ts'
// Generated JS bundle, no type declarations; its shapes are pinned by test/hostedRouting.test.ts.
import { buildScale, relayRoutingPrompt, relayRoutingSystem } from '../_shared/relayPrompts.gen.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** How large one capture file may be. Refused at the boundary, never truncated. */
const MAX_CAPTURE_CHARS = 120_000

/** The AI function this endpoint serves, as `ai_config` names it. */
const AI_FUNCTION = 'observation_routing'

/** Refusal slugs from the two RPCs and this file, as sentences a caller can act on. */
const REFUSAL_MESSAGES: Record<string, string> = {
  'tl13.not_an_admin_of_this_workshop':
    'You do not administer that workshop, so you cannot spend its AI budget.',
  'tl13.function_is_switched_off_for_this_workshop':
    'Observation routing is switched off for that workshop. An administrator can turn it on in Setup → AI.',
  'tl13.unknown_ai_function': 'That is not an AI function this deployment knows about.',
  'tl13.caller_or_workshop_missing': 'That request did not identify a caller and a workshop.',
  'tl23.hosted_ai_disabled_on_this_deployment':
    'Hosted AI is switched off for this whole deployment. Whoever runs it holds the key and the bill, so turning it on is their decision.',
  'tl23.daily_token_ceiling_reached':
    'This deployment has spent its daily AI token allowance. Routing resumes after midnight UTC, or the deployment owner can raise the ceiling.',
  'tl23.model_not_callable_here':
    'The model this workshop has chosen for routing cannot be called through this endpoint. Pick a Claude model in Setup → AI.',
  'tl23.no_model_key': 'ANTHROPIC_API_KEY is not configured on the server.',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ error: 'This deployment is not configured for authorized AI calls.' }, 500)
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Sign in to route captures.' }, 401)

    const { workshop_id: workshopId, capture } = await req.json().catch(() => ({}))
    // Required, not optional-with-a-default: a request with no workshop cannot be
    // authorized, and the safe answer to "authorize against what?" is to refuse.
    if (typeof workshopId !== 'string' || !UUID.test(workshopId)) {
      return json({ error: 'Provide the "workshop_id" these captures belong to.' }, 400)
    }
    if (
      typeof capture !== 'object' ||
      capture === null ||
      typeof (capture as { capture_client_id?: unknown }).capture_client_id !== 'string'
    ) {
      return json({ error: 'Provide one "capture" object carrying its capture_client_id.' }, 400)
    }
    const captureJson = JSON.stringify(capture)
    if (captureJson.length > MAX_CAPTURE_CHARS) {
      return json(
        {
          error: `That capture is ${captureJson.length} characters; the limit is ${MAX_CAPTURE_CHARS}.`,
        },
        413,
      )
    }

    // Who is calling, according to the auth server rather than the request body.
    const asCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userError } = await asCaller.auth.getUser()
    const authUserId = userData?.user?.id
    if (userError || !authUserId) {
      return json({ error: 'That session is not valid. Sign in again.' }, 401)
    }

    const asService = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // Gate one: may this caller spend THIS workshop's budget on THIS function?
    const { data: refusal, error: rpcError } = await asService.rpc('ai_call_permitted', {
      _auth_user_id: authUserId,
      _workshop_id: workshopId,
      _function: AI_FUNCTION,
    })
    if (rpcError) {
      return json({ error: `Could not check permissions: ${rpcError.message}` }, 500)
    }
    if (typeof refusal === 'string' && refusal) {
      // THE REFUSAL IS TRACED, because the caller this check exists to stop is the
      // one caller the client-side trace can never see: somebody invoking the
      // endpoint directly. A refusal nobody can review is only half a permission.
      await traceRow(asService, workshopId, authUserId, {
        outcome: 'refused',
        detail: refusal,
        input_chars: captureJson.length,
      })
      return json(
        { error: REFUSAL_MESSAGES[refusal] ?? 'That call is not permitted.', reason: refusal },
        403,
      )
    }

    // Gate two: may the deployment spend money at all? This is the first metered
    // path in the app, and a fan-out bug here costs dollars rather than tokens —
    // which is why the ceiling is checked server-side per call, not once client-side.
    const { data: spendRefusal, error: spendError } = await asService.rpc('ai_spend_permitted', {
      _workshop_id: workshopId,
    })
    if (spendError) {
      return json({ error: `Could not check the spend ceiling: ${spendError.message}` }, 500)
    }
    if (typeof spendRefusal === 'string' && spendRefusal) {
      await traceRow(asService, workshopId, authUserId, {
        outcome: 'refused',
        detail: spendRefusal,
        input_chars: captureJson.length,
      })
      return json(
        { error: REFUSAL_MESSAGES[spendRefusal] ?? 'That call is not permitted.', reason: spendRefusal },
        403,
      )
    }

    /**
     * THE MODEL IS READ HERE, from ai_config, never from the request. Null means
     * the default; anything this endpoint cannot call is refused rather than
     * silently replaced, because a stored id the Setup panel goes on naming while
     * the server quietly runs something else is the screen-disagrees-with-behaviour
     * failure this codebase keeps finding.
     */
    const { data: configRow } = await asService
      .from('ai_config')
      .select('functions')
      .eq('workshop_id', workshopId)
      .maybeSingle()
    const storedModel =
      (configRow?.functions as Record<string, { model?: unknown }> | null)?.[AI_FUNCTION]?.model ?? null
    const model = typeof storedModel === 'string' && storedModel ? storedModel : DEFAULT_ROUTING_MODEL
    if (!(ANTHROPIC_CALLABLE_MODELS as readonly string[]).includes(model)) {
      await traceRow(asService, workshopId, authUserId, {
        outcome: 'refused',
        detail: 'tl23.model_not_callable_here',
        input_chars: captureJson.length,
        model,
      })
      return json(
        { error: REFUSAL_MESSAGES['tl23.model_not_callable_here'], reason: 'tl23.model_not_callable_here' },
        400,
      )
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      await traceRow(asService, workshopId, authUserId, {
        outcome: 'refused',
        detail: 'tl23.no_model_key',
        input_chars: captureJson.length,
      })
      return json({ error: REFUSAL_MESSAGES['tl23.no_model_key'], reason: 'tl23.no_model_key' }, 500)
    }

    // The workshop's own scale, read authoritatively (see header note 1).
    const { data: scaleRows } = await asService
      .from('scale_point')
      .select('value, label, description, is_low_trigger, sort_order')
      .eq('workshop_id', workshopId)
      .order('sort_order')
    const scale = buildScale(
      workshopId,
      (scaleRows ?? []).map((r: Record<string, unknown>) => ({
        pk: `${workshopId}::${r.value}`,
        workshop_id: workshopId,
        value: r.value,
        label: r.label,
        description: r.description ?? null,
        is_low_trigger: Boolean(r.is_low_trigger),
        sort_order: r.sort_order,
      })),
    )

    const started = Date.now()
    let reply
    try {
      reply = await callAnthropic({
        apiKey,
        model,
        system: relayRoutingSystem(scale),
        prompt: relayRoutingPrompt(captureJson),
      })
    } catch (err) {
      const message =
        err instanceof AnthropicHttpError
          ? err.message
          : err instanceof DOMException && err.name === 'TimeoutError'
            ? 'The model did not answer in time.'
            : err instanceof Error
              ? err.message
              : 'The model call failed.'
      await traceRow(asService, workshopId, authUserId, {
        outcome: 'error',
        detail: message.slice(0, 500),
        input_chars: captureJson.length,
        model,
        latency_ms: Date.now() - started,
      })
      const status = err instanceof AnthropicHttpError ? 502 : err instanceof DOMException ? 504 : 502
      return json({ error: message }, status)
    }

    // The real spend, recorded where it is known (see header note 3). Awaited and
    // reported on failure rather than fired-and-forgotten, because this row is
    // what the ceiling counts: an unrecorded call is an uncounted one.
    const extracted = extractJsonObject(reply.text)
    await traceRow(asService, workshopId, authUserId, {
      outcome: extracted ? 'result' : 'error',
      detail: extracted ? null : 'tl23.reply_was_not_json',
      input_chars: captureJson.length,
      model: reply.model,
      tokens_in: reply.usage.tokens_in,
      tokens_out: reply.usage.tokens_out,
      cache_read_tokens: reply.usage.cache_read_tokens,
      cache_write_tokens: reply.usage.cache_write_tokens,
      latency_ms: Date.now() - started,
    })

    const meta = {
      model: reply.model,
      tokens_in: reply.usage.tokens_in,
      tokens_out: reply.usage.tokens_out,
      cache_read_tokens: reply.usage.cache_read_tokens,
      cache_write_tokens: reply.usage.cache_write_tokens,
      latency_ms: Date.now() - started,
    }

    // { observations_file } / { raw }, mirroring draft-scenario's { scenario } /
    // { raw } split so the client can still recover a reply this parse missed.
    if (extracted) {
      try {
        return json({ observations_file: JSON.parse(extracted), ...meta }, 200)
      } catch {
        /* balanced but not JSON — fall through to raw */
      }
    }
    return json({ raw: reply.text, ...meta }, 200)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error.' }, 500)
  }
})

/**
 * One ai_call_log row, written with the service-role key. Refusal rows are
 * best-effort (a log that could turn a 403 into a 500 would be worse than no
 * log); spend rows are awaited by the caller because the ceiling counts them.
 */
async function traceRow(
  service: ReturnType<typeof createClient>,
  workshopId: string,
  authUserId: string,
  row: {
    outcome: 'result' | 'refused' | 'error'
    detail: string | null
    input_chars: number
    model?: string | null
    tokens_in?: number | null
    tokens_out?: number | null
    cache_read_tokens?: number | null
    cache_write_tokens?: number | null
    latency_ms?: number | null
  },
): Promise<void> {
  try {
    const { data } = await service.auth.admin.getUserById(authUserId)
    const { error } = await service.from('ai_call_log').insert({
      workshop_id: workshopId,
      fn: AI_FUNCTION,
      mode: 'hosted-api',
      actor_email: data?.user?.email ?? null,
      ...row,
    })
    if (error) console.error('could not record the call', error.message)
  } catch (err) {
    console.error('could not record the call', err instanceof Error ? err.message : err)
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })
}
