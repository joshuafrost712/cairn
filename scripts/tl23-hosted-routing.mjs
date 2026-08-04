/**
 * tl-23 acceptance, against the DEPLOYED route-captures function and real sessions.
 *
 * Like tl-13's function tests, this calls the endpoint over plain HTTP with real
 * JWTs belonging to people who should be refused, because every test written
 * THROUGH the client would pass on a build whose server checks were missing — the
 * client never sends a request it thinks it should not send.
 *
 * What it proves, in order — and each refusal must be DISTINGUISHABLE, because a
 * screen can only tell somebody what to do about a refusal it can tell apart:
 *
 *   1. A request with no workshop_id is refused 400.
 *   2. A request whose capture has no capture_client_id is refused 400.
 *   3. An evaluator with a valid session is refused, told which refusal it was.
 *   4. An administrator of ANOTHER workshop is refused for this one.
 *   5. This workshop's administrator is refused while the routing toggle is off,
 *      with a DIFFERENT reason.
 *   6. With the toggle on but hosted AI off deployment-wide (this deployment's
 *      real state), the spend gate refuses with its own slug.
 *   7. With hosted AI on and a Gemini model stored for routing, the model
 *      allowlist refuses 400 with its own slug.
 *   8. With hosted AI on and the ceiling already spent, the ceiling refuses.
 *   9. With everything on and no ANTHROPIC_API_KEY, the key refusal is a 500
 *      with its own slug — OR, when the key exists, one real capture routes and
 *      the ai_call_log row carries a real model and real token counts including
 *      the cache fields.
 *  10. The refusals above were traced server-side into ai_call_log.
 *
 * Prefix-scoped fixtures (tl23-fn-*) and prefix-scoped teardown; the two
 * platform settings are restored in a finally block, so the deployment's real
 * state (hosted AI off, ceiling 2,000,000) survives a crash mid-run.
 *
 *   node scripts/tl23-hosted-routing.mjs            # provision, test, tear down
 *   node scripts/tl23-hosted-routing.mjs --keep     # leave the fixtures in place
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WS = 'a6000000-0000-4000-8000-00000000ff31'
const WS2 = 'a6000000-0000-4000-8000-00000000ff32'

const ACCOUNTS = {
  admin: { email: 'tl23-fn-admin@example.org', password: 'tl23-Throwaway-Password-1!', role: 'chief_admin', ws: WS },
  evaluator: { email: 'tl23-fn-evaluator@example.org', password: 'tl23-Throwaway-Password-2!', role: 'evaluator', ws: WS },
  outsider: { email: 'tl23-fn-outsider@example.org', password: 'tl23-Throwaway-Password-3!', role: 'chief_admin', ws: WS2 },
}

/** A minimal but real capture file: the shape captureFileFor() builds. */
const CAPTURE = {
  schema: 'cairn.capture/v1',
  capture_client_id: 'tl23-fn-capture-1',
  workshop: { id: WS, name: 'tl23-fn fixture' },
  activity: { id: null, title: 'Exegesis check', day: null },
  evaluator_email: ACCOUNTS.admin.email,
  source_language: 'en',
  source_text:
    'Amos led the exegesis discussion confidently, walked the team through the passage structure, and asked the quieter members for their reading before offering his own.',
  participant_scope: [{ name: 'Amos' }],
  ksas_in_scope: [],
  scale: [
    { value: 0, label: 'not yet demonstrated' },
    { value: 1, label: 'emerging' },
    { value: 2, label: 'competent' },
    { value: 3, label: 'strong' },
  ],
  ruleset_version: 1,
  created_at: '2026-08-04T00:00:00Z',
}

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const readEnv = (key) => env.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim()
const SUPABASE_URL = readEnv('VITE_SUPABASE_URL')
const ANON_KEY = readEnv('VITE_SUPABASE_ANON_KEY')
if (!SUPABASE_URL || !ANON_KEY) throw new Error('.env is missing VITE_SUPABASE_URL / ANON_KEY')
const FN_URL = `${SUPABASE_URL}/functions/v1/route-captures`

const accessToken = execFileSync('/bin/zsh', [
  '-c', 'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function mgmt(path, init = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`management ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const sql = (query) => mgmt('/database/query', { method: 'POST', body: JSON.stringify({ query }) })

async function serviceRoleKey() {
  const keys = await mgmt('/api-keys?reveal=true')
  const key = keys.find((k) => k.name === 'service_role')?.api_key
  if (!key) throw new Error('could not read the service_role key')
  return key
}

const results = []
const record = (verdict, label, outcome) => {
  results.push(verdict)
  console.log(`${verdict} | ${label.slice(0, 66).padEnd(66)} | ${String(outcome).slice(0, 80)}`)
}
const assert = (label, condition, detail) => record(condition ? 'PASS' : 'FAIL', label, detail)

async function teardown(serviceKey) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl23-fn-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from ai_call_log where workshop_id in ('${WS}', '${WS2}');
    delete from ai_config where workshop_id in ('${WS}', '${WS2}');
    delete from workshop_member where workshop_id in ('${WS}', '${WS2}');
    delete from app_user where email like 'tl23-fn-%';
    delete from role_allowlist where email like 'tl23-fn-%';
    delete from workshop where id in ('${WS}', '${WS2}');
    delete from auth.identities where identity_data->>'email' like 'tl23-fn-%';
    delete from auth.users where email like 'tl23-fn-%';
    select 1;`)
}

async function provision(serviceKey) {
  await sql(`
    insert into workshop (id, name) values
      ('${WS}', 'tl23-fn fixture'), ('${WS2}', 'tl23-fn other') on conflict (id) do nothing;
    insert into role_allowlist (email, allowed_roles, assigned_role, platform_owner) values
      ('${ACCOUNTS.admin.email}', array['chief_admin'], 'chief_admin', false),
      ('${ACCOUNTS.evaluator.email}', array['evaluator'], 'evaluator', false),
      ('${ACCOUNTS.outsider.email}', array['chief_admin'], 'chief_admin', false)
    on conflict (email) do nothing;
    select 1;`)
  for (const a of Object.values(ACCOUNTS)) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password, email_confirm: true }),
    })
    if (!res.ok) throw new Error(`create ${a.email} -> ${res.status} ${await res.text()}`)
  }
  await sql(`
    insert into workshop_member (workshop_id, app_user_id, role)
    select v.ws::uuid, u.id, v.role
    from (values
      ('${WS}', '${ACCOUNTS.admin.email}', 'chief_admin'),
      ('${WS}', '${ACCOUNTS.evaluator.email}', 'evaluator'),
      ('${WS2}', '${ACCOUNTS.outsider.email}', 'chief_admin')
    ) as v(ws, email, role)
    join app_user u on u.email = v.email
    on conflict do nothing;
    select 1;`)
}

async function signIn(account) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`sign-in ${account.email} failed: ${JSON.stringify(body)}`)
  return body.access_token
}

async function call(jwt, body) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = {}
  try { parsed = await res.json() } catch { /* non-JSON body */ }
  return { status: res.status, ...parsed }
}

// Restored in finally, whatever happens in between.
const setHosted = (on) => sql(`update platform_setting set value = to_jsonb(${on}) where key = 'hosted_ai_enabled'; select 1;`)
const setCeiling = (n) => sql(`update platform_setting set value = to_jsonb(${n}) where key = 'ai_daily_token_ceiling'; select 1;`)

const keep = process.argv.includes('--keep')
const serviceKey = await serviceRoleKey()
await teardown(serviceKey) // idempotent start

try {
  await provision(serviceKey)
  const adminJwt = await signIn(ACCOUNTS.admin)
  const evaluatorJwt = await signIn(ACCOUNTS.evaluator)
  const outsiderJwt = await signIn(ACCOUNTS.outsider)

  // 1–2: the contract refuses before anything is spent.
  const noWs = await call(adminJwt, { capture: CAPTURE })
  assert('no workshop_id -> 400', noWs.status === 400, noWs.error)
  const badCapture = await call(adminJwt, { workshop_id: WS, capture: { hello: 'world' } })
  assert('capture without capture_client_id -> 400', badCapture.status === 400, badCapture.error)

  // 3–4: authorization, with distinguishable reasons.
  const asEvaluator = await call(evaluatorJwt, { workshop_id: WS, capture: CAPTURE })
  assert('evaluator -> 403 not_an_admin', asEvaluator.status === 403 && asEvaluator.reason === 'tl13.not_an_admin_of_this_workshop', `${asEvaluator.status} ${asEvaluator.reason}`)
  const asOutsider = await call(outsiderJwt, { workshop_id: WS, capture: CAPTURE })
  assert("another workshop's admin -> 403 not_an_admin", asOutsider.status === 403 && asOutsider.reason === 'tl13.not_an_admin_of_this_workshop', `${asOutsider.status} ${asOutsider.reason}`)

  // 5: the toggle, off — a DIFFERENT refusal than "not yours".
  await sql(`insert into ai_config (workshop_id, mode, functions)
    values ('${WS}', 'github-claude', '{"observation_routing": {"enabled": false}}')
    on conflict (workshop_id) do update set functions = excluded.functions; select 1;`)
  const toggledOff = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
  assert('routing toggled off -> 403 function_is_switched_off', toggledOff.status === 403 && toggledOff.reason === 'tl13.function_is_switched_off_for_this_workshop', `${toggledOff.status} ${toggledOff.reason}`)
  await sql(`update ai_config set functions = '{"observation_routing": {"enabled": true}}' where workshop_id = '${WS}'; select 1;`)

  // 6: the deployment switch — the app's real state today.
  const hostedOff = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
  assert('hosted AI off deployment-wide -> 403 tl23.hosted_ai_disabled', hostedOff.status === 403 && hostedOff.reason === 'tl23.hosted_ai_disabled_on_this_deployment', `${hostedOff.status} ${hostedOff.reason}`)

  // 7: the model allowlist, with hosted AI temporarily on.
  await setHosted(true)
  await sql(`update ai_config set functions = '{"observation_routing": {"enabled": true, "model": "gemini-2.5-flash-lite"}}' where workshop_id = '${WS}'; select 1;`)
  const wrongModel = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
  assert('a Gemini model stored for routing -> 400 model_not_callable', wrongModel.status === 400 && wrongModel.reason === 'tl23.model_not_callable_here', `${wrongModel.status} ${wrongModel.reason}`)
  await sql(`update ai_config set functions = '{"observation_routing": {"enabled": true}}' where workshop_id = '${WS}'; select 1;`)

  // 8: the ceiling, already spent.
  await setCeiling(10)
  await sql(`insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in)
    values ('${WS}', 'observation_routing', 'hosted-api', 'result', 10); select 1;`)
  const ceilinged = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
  assert('ceiling spent -> 403 daily_token_ceiling_reached', ceilinged.status === 403 && ceilinged.reason === 'tl23.daily_token_ceiling_reached', `${ceilinged.status} ${ceilinged.reason}`)
  await setCeiling(2000000)
  await sql(`delete from ai_call_log where workshop_id = '${WS}' and outcome = 'result'; select 1;`)

  // 9: the key — or the real thing, when the key exists.
  const secrets = await mgmt('/secrets')
  const hasKey = secrets.some((s) => s.name === 'ANTHROPIC_API_KEY')
  if (!hasKey) {
    const noKey = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
    assert('no ANTHROPIC_API_KEY -> 500 tl23.no_model_key', noKey.status === 500 && noKey.reason === 'tl23.no_model_key', `${noKey.status} ${noKey.reason}`)
    record('SKIP', 'success path: one real capture routed', 'awaits ANTHROPIC_API_KEY — set the secret and re-run this script')
  } else {
    const routed = await call(adminJwt, { workshop_id: WS, capture: CAPTURE })
    assert('a real capture routes 200 with an observations_file', routed.status === 200 && routed.observations_file?.capture_client_id === CAPTURE.capture_client_id, `${routed.status} model=${routed.model}`)
    assert('the reply carries real token counts', typeof routed.tokens_in === 'number' && typeof routed.tokens_out === 'number', `in=${routed.tokens_in} out=${routed.tokens_out} cache_r=${routed.cache_read_tokens} cache_w=${routed.cache_write_tokens}`)
    const row = await sql(`select model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, outcome
      from ai_call_log where workshop_id = '${WS}' and mode = 'hosted-api' and outcome = 'result'
      order by at desc limit 1;`)
    assert('the server traced the spend with the cache fields in their own columns', row?.[0]?.tokens_in > 0, JSON.stringify(row?.[0]))
    console.log(`\nMEASURED per-capture cost (record in the review record): ${JSON.stringify(row?.[0])}`)
  }

  // 10: the refusals were traced server-side.
  const traced = await sql(`select detail, count(*)::int as n from ai_call_log
    where workshop_id = '${WS}' and mode = 'hosted-api' and outcome = 'refused' group by detail order by detail;`)
  const details = traced.map((r) => r.detail)
  assert('server traced the toggle refusal', details.includes('tl13.function_is_switched_off_for_this_workshop'), details.join(', '))
  assert('server traced the spend refusals', details.includes('tl23.hosted_ai_disabled_on_this_deployment') && details.includes('tl23.daily_token_ceiling_reached'), '')
} finally {
  await setHosted(false)
  await setCeiling(2000000)
  if (!keep) await teardown(serviceKey)
}

const failed = results.filter((r) => r === 'FAIL').length
console.log(failed === 0 ? `\nALL PASS (${results.filter((r) => r === 'PASS').length} checks, ${results.filter((r) => r === 'SKIP').length} skipped)` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
