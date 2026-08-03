/**
 * tl-02 acceptance, over real authenticated sessions and real HTTP.
 *
 * The SQL harness (scripts/tl02-rls-tests.sql) proves the matrix by impersonating
 * sessions inside Postgres. It cannot prove the thing that actually breaks first
 * on a new RPC: whether a browser can call it at all. PostgREST maps JSON keys to
 * parameter names, these functions take leading-underscore parameters, and the
 * grant to `authenticated` is separate from every policy — all three are the kind
 * of thing that works in psql and 404s from the app.
 *
 * So this signs three throwaway accounts in through Supabase Auth and posts to
 * /rest/v1/rpc/... exactly as src/db/membership.ts does. It also asserts the shape
 * of a refusal, because `toResult()` in that module reads `code` and `details` off
 * the error body: if the slug ever stops arriving there, the UI silently loses its
 * ability to say which rule fired, with nothing failing.
 *
 *   node scripts/tl02-session-tests.mjs            # provision, test, tear down
 *   node scripts/tl02-session-tests.mjs --teardown # remove them
 *
 * Reads the anon key from .env and the service_role key from the Management API.
 * The service_role key creates and deletes the temporary accounts and is never
 * used for a request under test, since it bypasses RLS and would make everything
 * pass for the wrong reason.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WS = 'a2000000-0000-4000-8000-00000000cc01'

const ACCOUNTS = {
  chief: { email: 'tl02-session-chief@example.org', password: 'tl02-Throwaway-Password-1!', role: 'chief_admin' },
  admin: { email: 'tl02-session-admin@example.org', password: 'tl02-Throwaway-Password-2!', role: 'admin' },
  evaluator: { email: 'tl02-session-evaluator@example.org', password: 'tl02-Throwaway-Password-3!', role: 'evaluator' },
}

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const readEnv = (key) =>
  env.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim()

const SUPABASE_URL = readEnv('VITE_SUPABASE_URL')
const ANON_KEY = readEnv('VITE_SUPABASE_ANON_KEY')
if (!SUPABASE_URL || !ANON_KEY) throw new Error('.env is missing VITE_SUPABASE_URL / ANON_KEY')

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function mgmt(path, init = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
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
function record(verdict, expect, label, outcome) {
  results.push({ verdict, expect, label, outcome })
  console.log(`${verdict} ${expect.padEnd(9)} | ${label.slice(0, 60).padEnd(60)} | ${outcome}`)
}

async function teardown(serviceKey) {
  // The admin API first, so the auth service sees the deletion. Its result is
  // checked rather than assumed: the first version of this script ignored the
  // status, the deletes were failing, and the next run died on `email_exists`
  // with a teardown that had reported nothing wrong.
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  const stragglers = []
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl02-session-')) continue
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
    if (!res.ok) stragglers.push(`${u.email} -> ${res.status}`)
  }
  if (stragglers.length > 0) {
    console.warn(`[teardown] admin API refused ${stragglers.length} delete(s): ${stragglers.join(', ')}`)
  }

  // SQL is the authority. `auth.users` last: deleting it sets app_user.auth_user_id
  // to null rather than removing the row, so app_user has to go on its own anyway.
  await sql(`
    delete from membership_change_log where workshop_id = '${WS}';
    delete from workshop_member where workshop_id = '${WS}';
    delete from app_user where email like 'tl02-session-%';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl02-session-%';
    delete from role_allowlist where email like 'tl02-session-%';
    delete from workshop where id = '${WS}';
    delete from auth.identities where identity_data->>'email' like 'tl02-session-%';
    delete from auth.users where email like 'tl02-session-%';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)
  await sql(`
    insert into workshop (id, name, start_date, location)
    values ('${WS}', 'TL02 Session Fixture Workshop', '2027-08-01', 'Nowhere');
    select 1;`)

  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'tl-02 session test', '${WS}')
      on conflict (email) do update set assigned_role = excluded.assigned_role,
        allowed_roles = excluded.allowed_roles, default_workshop_id = excluded.default_workshop_id;
      select 1;`)

    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: a.email,
        password: a.password,
        email_confirm: true,
        user_metadata: { name: `TL02 ${a.role}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${a.email} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

async function signIn(a) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${a.email}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body.access_token
}

/** Post to an RPC the way src/db/membership.ts does, and judge the response. */
async function rpc(expect, label, token, fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* not json */ }

  const ok = res.status < 400
  const verdict = expect === 'blocked' ? (ok ? 'FAIL' : 'PASS') : ok ? 'PASS' : 'FAIL'
  const detail = ok
    ? `${res.status}`
    : `${res.status} code=${body?.code ?? '?'} details=${body?.details ?? '?'}`
  record(verdict, expect, label, detail)
  return { status: res.status, body }
}

async function get(expect, label, token, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const text = await res.text()
  let rows = null
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) rows = parsed.length
  } catch { /* not an array */ }
  const denied = res.status >= 400 || rows === 0
  const verdict = expect === 'blocked' ? (denied ? 'PASS' : 'FAIL') : (!denied ? 'PASS' : 'FAIL')
  record(verdict, expect, label, `${res.status}, ${rows ?? '?'} row(s)`)
  return { status: res.status, rows, text }
}

async function runChecks() {
  const chief = await signIn(ACCOUNTS.chief)
  const admin = await signIn(ACCOUNTS.admin)
  const evaluator = await signIn(ACCOUNTS.evaluator)
  record('PASS', 'setup', 'three temporary accounts sign in over real HTTP', 'three access tokens issued')

  const ids = await sql(`
    select u.email, u.id from app_user u where u.email like 'tl02-session-%' order by u.email;`)
  const idOf = (email) => ids.find((r) => r.email === email)?.id
  const CHIEF = idOf(ACCOUNTS.chief.email)
  const ADMIN = idOf(ACCOUNTS.admin.email)
  const EVAL = idOf(ACCOUNTS.evaluator.email)
  record(CHIEF && ADMIN && EVAL ? 'PASS' : 'FAIL', 'setup',
    'the signup trigger placed all three in the fixture workshop', `${ids.length} account(s)`)

  // --- the RPC is reachable at all, which is what psql cannot tell you ------
  await rpc('permitted', 'chief admin re-ranks the evaluator as a consultant', chief,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'consultant' })
  await rpc('permitted', 'chief admin puts them back to evaluator', chief,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'evaluator' })

  // --- the refusals, and the shape src/db/membership.ts reads ---------------
  const overreach = await rpc('blocked', 'admin promotes the evaluator to admin', admin,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'admin' })
  record(overreach.body?.code === '42501' ? 'PASS' : 'FAIL', 'contract',
    'a refusal arrives as code 42501, which isAuthorizationRefusal() keys on',
    `code = ${overreach.body?.code}`)
  record(overreach.body?.details === 'tl02.admin_may_only_grant_evaluator' ? 'PASS' : 'FAIL', 'contract',
    'and carries its slug in `details`, which toResult() keys on',
    `details = ${overreach.body?.details}`)
  record(typeof overreach.body?.message === 'string' && overreach.body.message.length > 20 ? 'PASS' : 'FAIL',
    'contract', 'and a message readable enough to surface verbatim',
    JSON.stringify(overreach.body?.message ?? null).slice(0, 80))

  await rpc('blocked', 'admin removes the chief admin', admin,
    'remove_workshop_member', { _workshop_id: WS, _target_app_user_id: CHIEF })
  await rpc('blocked', 'evaluator promotes themselves', evaluator,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'admin' })
  await rpc('blocked', 'admin transfers the chief admin role to themselves', admin,
    'transfer_chief_admin', { _workshop_id: WS, _to_app_user_id: ADMIN })
  await rpc('blocked', 'anyone grants chief_admin through the role RPC', chief,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: ADMIN, _role: 'chief_admin' })
  await rpc('blocked', 'an unauthenticated caller reaches the RPC', null,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'admin' })

  // --- the admin's one real power, over the wire ---------------------------
  await rpc('permitted', 'admin removes the evaluator', admin,
    'remove_workshop_member', { _workshop_id: WS, _target_app_user_id: EVAL })
  await rpc('permitted', 'admin adds them back as an evaluator', admin,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'evaluator' })

  // --- the transfer, and what it costs the outgoing chief admin ------------
  await rpc('permitted', 'chief admin transfers the role to the admin', chief,
    'transfer_chief_admin', { _workshop_id: WS, _to_app_user_id: ADMIN })
  await rpc('blocked', 'the former chief admin can no longer promote to admin', chief,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'admin' })
  await rpc('permitted', 'the new chief admin can', admin,
    'set_workshop_member_role',
    { _workshop_id: WS, _target_app_user_id: EVAL, _role: 'chief_evaluator' })

  // --- the audit log, as membershipHistory() reads it -----------------------
  await get('permitted', 'the new chief admin reads the membership log', admin,
    `membership_change_log?workshop_id=eq.${WS}&select=id,actor_email,target_email,from_role,to_role,operation,at&order=at.desc`)
  await get('blocked', 'the evaluator reads the membership log', evaluator,
    `membership_change_log?workshop_id=eq.${WS}&select=id`)

  // --- and the table is still closed to direct writes -----------------------
  const direct = await fetch(`${SUPABASE_URL}/rest/v1/workshop_member`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${evaluator}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workshop_id: WS, app_user_id: EVAL, role: 'chief_admin' }),
  })
  record(direct.status >= 400 ? 'PASS' : 'FAIL', 'blocked',
    'the evaluator writes workshop_member directly, bypassing the RPCs', `${direct.status}`)

  // --- state, because "the call errored" is not "nothing happened" ----------
  const [state] = await sql(`
    select (select count(*) from workshop_member where workshop_id = '${WS}' and role = 'chief_admin') as chiefs,
           (select role from workshop_member where workshop_id = '${WS}' and app_user_id = '${ADMIN}') as admin_role,
           (select role from workshop_member where workshop_id = '${WS}' and app_user_id = '${CHIEF}') as chief_role,
           (select role from workshop_member where workshop_id = '${WS}' and app_user_id = '${EVAL}') as eval_role,
           (select count(*) from membership_change_log where workshop_id = '${WS}') as log_rows;`)
  record(state.chiefs === 1 ? 'PASS' : 'FAIL', 'state', 'exactly one chief admin', `${state.chiefs}`)
  record(state.admin_role === 'chief_admin' ? 'PASS' : 'FAIL', 'state',
    'the transfer landed on the admin', `${state.admin_role}`)
  record(state.chief_role === 'admin' ? 'PASS' : 'FAIL', 'state',
    'the former chief admin is an admin, not removed', `${state.chief_role}`)
  record(state.eval_role === 'chief_evaluator' ? 'PASS' : 'FAIL', 'state',
    'the evaluator ended where the last permitted call put them', `${state.eval_role}`)
  // Seven, counted rather than guessed: consultant, back to evaluator, removed,
  // re-added, the transfer's two halves, chief_evaluator. A refused call must not
  // appear here, so an eighth row would mean the log is recording attempts.
  record(state.log_rows === 7 ? 'PASS' : 'FAIL', 'state',
    'exactly the seven permitted changes reached the log, and no refusal did',
    `${state.log_rows} row(s)`)
}

const mode = process.argv[2]
const serviceKey = await serviceRoleKey()

if (mode === '--teardown') {
  await teardown(serviceKey)
  console.log('fixtures and temporary accounts removed')
  process.exit(0)
}

await provision(serviceKey)
try {
  await runChecks()
} finally {
  await teardown(serviceKey)
}

const failed = results.filter((r) => r.verdict !== 'PASS')
console.log(`\n${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
