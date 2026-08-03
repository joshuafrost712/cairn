#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI, for the harnesses (tl-21).
 *
 * WHY A STUB AT ALL, when the real thing works and is free on a subscription: because the
 * cases worth testing are the ones a real model will not produce on demand. "The reply is
 * not JSON", "the subscription is throttled", "the CLI is not signed in", "the worker
 * hangs past its timeout" and "the reply is 10MB" are all states the relay must handle
 * correctly and none of them can be summoned reliably from a working model. The real CLI
 * is exercised separately, on the real path, and its numbers are in the review record.
 *
 * Behaviour is chosen by HONEST_EVAL_FAKE_MODE. It reads the prompt from stdin exactly as
 * the real one does, so a harness that passes here has also proved the payload never went
 * near a command line.
 */

const mode = process.env.HONEST_EVAL_FAKE_MODE || 'ok'

if (process.argv.includes('--version')) {
  if (mode === 'no-runner') {
    process.stderr.write('command not found\n')
    process.exit(1)
  }
  process.stdout.write('2.1.0 (fake)\n')
  process.exit(0)
}

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')

/** The capture ids the prompt carried, so a fake answer can match a real bundle. */
const captureIds = [...prompt.matchAll(/"capture_client_id":\s*"([^"]+)"/g)].map((m) => m[1])

/**
 * Read the participant, question and scale out of the bundle it was actually given.
 *
 * A stub that answered with invented names would pass the relay's tests and fail the
 * app's, which is the wrong way round: the interesting assertion is that a real routed
 * answer reaches the store through the real validation, and that needs the answer to be
 * about somebody who exists. Env overrides stay, because the negative tests need to name
 * a participant and a designation that are deliberately wrong.
 */
const firstMatch = (re) => prompt.match(re)?.[1] ?? null
const bundleParticipant = firstMatch(/"participant_scope":\s*\[\s*\{\s*"name":\s*"([^"]+)"/)
const bundleParticipantId = firstMatch(/"participant_scope":\s*\[\s*\{[^}]*"participant_id":\s*"([^"]+)"/)
const bundleKsa = firstMatch(/"ksas_in_scope":\s*\[\s*\{\s*"code":\s*"([^"]+)"/)
const bundleDesignation = firstMatch(/"scale":\s*\[[^\]]*?"value":\s*(\d+)/)

const envelope = (over = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  duration_ms: 42,
  num_turns: 1,
  stop_reason: 'end_turn',
  total_cost_usd: 0.004267,
  /**
   * INVENTED NUMBERS. Not a measurement, and specifically not the per-call cost.
   *
   * 3,496 is pinned in six places as fixture data, which is the only reason it is still
   * this figure. It happens to equal the spec's original (wrong) claim about real per-call
   * input, and tl-21's own record then cited "3,496 in and 71 out from the browser
   * walkthrough" as evidence that the trace carries REAL token counts for a subscription.
   * It is this file's fiction. The real figure, measured through the real CLI on
   * 2026-08-03, is 228 with `--tools ''` and 14,136 without; only `tl21-relay-checks.mjs
   * --real` can produce it, and only that check should ever be read as a cost measurement.
   */
  usage: {
    input_tokens: 3496,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 71,
  },
  modelUsage: { 'claude-haiku-4-5': { inputTokens: 3496, outputTokens: 71 } },
  permission_denials: [],
  ...over,
})

const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

switch (mode) {
  case 'ok': {
    // A valid observations bundle, fenced, because the real CLI fences every time.
    const results = (captureIds.length ? captureIds : ['unknown']).map((id) => ({
      schema: 'cairn.observations/v1',
      capture_client_id: id,
      routed_at: '2026-08-04T10:00:00.000Z',
      observations: [
        {
          participant_name: process.env.HONEST_EVAL_FAKE_PARTICIPANT || bundleParticipant || 'Fixture Participant',
          participant_id: process.env.HONEST_EVAL_FAKE_PARTICIPANT_ID || bundleParticipantId || null,
          ksa_code: process.env.HONEST_EVAL_FAKE_KSA || bundleKsa || 'K1',
          evidence_designation: Number(process.env.HONEST_EVAL_FAKE_DESIGNATION ?? bundleDesignation ?? 2),
          text: 'Explained the passage clearly to the group.',
          source_excerpt: 'explained it clearly',
          origin: 'individual',
          sentiment_flag: 'strong',
          confidence: 'high',
          needs_review: false,
        },
      ],
    }))
    const body = JSON.stringify({ schema: 'cairn.observations-bundle/v1', results })
    say(envelope({ result: '```json\n' + body + '\n```' }))
    break
  }

  case 'prose':
    say(envelope({ result: '```\nOpen by naming what you saw, not who they are.\n```' }))
    break

  case 'notjson':
    say(envelope({ result: 'I am not going to answer in JSON today.' }))
    break

  case 'throttle':
    say(
      envelope({
        is_error: true,
        api_error_status: 429,
        result: 'Claude usage limit reached. Your limit will reset at 3pm.',
      }),
    )
    break

  case 'auth':
    process.stderr.write('Invalid API key · Please run /login\n')
    process.exit(1)
    break

  case 'apierror':
    say(envelope({ is_error: true, api_error_status: 400, result: 'That request was rejected.' }))
    break

  case 'hang':
    // Never answers, and holds a timer so Node does not exit. `await new Promise(() => {})`
    // looks like the same thing and is not: with nothing keeping the loop alive Node exits
    // 13 with "unsettled top-level await", which the relay correctly reports as a crashed
    // worker rather than as the timeout the test was trying to provoke.
    await new Promise((resolve) => setTimeout(resolve, 10 * 60_000))
    break

  case 'huge': {
    const big = 'x'.repeat(10 * 1024 * 1024)
    say(envelope({ result: '```json\n' + JSON.stringify({ schema: 'cairn.observations-bundle/v1', results: [], filler: big }) + '\n```' }))
    break
  }

  case 'injected':
    // What a prompt-injected capture would have to achieve to matter: a tool call. The
    // real CLI cannot make one (every tool is disallowed), and this stub proves the app
    // side rejects the shape even if one somehow arrived.
    say(envelope({ result: '```json\n{"tool_use":{"name":"Bash","input":"cat ~/.ssh/id_rsa"}}\n```' }))
    break

  default:
    process.stderr.write(`unknown fake mode: ${mode}\n`)
    process.exit(2)
}
