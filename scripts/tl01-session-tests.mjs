/**
 * tl-01 acceptance, over real authenticated sessions and real HTTP.
 *
 * The SQL harness (scripts/tl01-rls-tests.sql) proves the policies by
 * impersonating a session inside Postgres. This one closes the remaining seam: it
 * signs two throwaway accounts in through Supabase Auth and talks to PostgREST
 * exactly as the browser does, so what is being checked is the response on the
 * wire — status code and body — rather than a policy expression evaluated in
 * place. The spec asked for the network response, and this is it.
 *
 * Self-provisioning and self-cleaning. It creates two temporary accounts (an
 * evaluator in the pilot workshop, an admin in a throwaway second workshop) plus a
 * fixture workshop with data in it, runs the checks, and removes all of it. It
 * never touches a real person's account.
 *
 *   node scripts/tl01-session-tests.mjs            # provision, test, tear down
 *   node scripts/tl01-session-tests.mjs --keep     # leave the accounts for the browser run
 *   node scripts/tl01-session-tests.mjs --teardown # remove them
 *
 * Credentials: reads the project's anon key from .env and fetches the
 * service_role key from the Management API using SUPABASE_ACCESS_TOKEN (see the
 * vault memory for where that lives). No secret is written to disk, and the
 * service_role key is used ONLY to create and delete the temporary accounts —
 * never to make a request under test, since it bypasses RLS and would make every
 * check pass for the wrong reason.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const BALI = '11111111-1111-1111-1111-111111111111'
const FIXTURE_WS = '22222222-2222-2222-2222-222222222222'

const ACCOUNTS = {
  evaluator: {
    email: 'tl01-session-evaluator@example.org',
    password: 'tl01-Throwaway-Password-1!',
    workshop: BALI,
    role: 'evaluator',
  },
  otherAdmin: {
    email: 'tl01-session-otheradmin@example.org',
    password: 'tl01-Throwaway-Password-2!',
    workshop: FIXTURE_WS,
    role: 'admin',
  },
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

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

/** Run SQL as `postgres`. Used only for fixtures and teardown, never under test. */
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
  console.log(`${verdict} ${expect.padEnd(9)} | ${label.slice(0, 62).padEnd(62)} | ${outcome}`)
}

// ---------------------------------------------------------------------------
// Provision / teardown
// ---------------------------------------------------------------------------

async function teardown(serviceKey) {
  // Users first: deleting an auth user sets app_user.auth_user_id to null rather
  // than removing the row, so the app_user (and its cascading memberships) has to
  // go explicitly. Captures before workshops, since evaluation.workshop_id is
  // `on delete set null` and would otherwise be orphaned rather than deleted.
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl01-session-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from evaluation where client_id like 'tl01-%';
    delete from app_user where email like 'tl01-session-%';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl01-session-%';
    delete from role_allowlist where email like 'tl01-session-%';
    delete from workshop where id = '${FIXTURE_WS}';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)

  // A second organization with data in it, so "cross-workshop" has something real
  // on the other side of it.
  await sql(`
    insert into workshop (id, name, start_date, location)
    values ('${FIXTURE_WS}', 'TL01 Session Fixture Workshop', '2027-01-01', 'Nowhere');
    insert into team (workshop_id, name) values ('${FIXTURE_WS}', 'TL01 Session Team');
    insert into participant (workshop_id, name)
    values ('${FIXTURE_WS}', 'TL01 Session Participant');
    insert into activity (workshop_id, title, sort_order)
    values ('${FIXTURE_WS}', 'TL01 Session Activity', 1);
    insert into evaluation (client_id, workshop_id, evaluator_email, source_text)
    values ('tl01-session-fixture-eval', '${FIXTURE_WS}', 'fixture@example.org', 'fixture text');
    select 1;`)

  // Allowlist first: signup is invite-only, and handle_new_user raises (rolling
  // back the auth.users insert) for an email it does not know. The
  // default_workshop_id is what places each account in its workshop.
  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'tl-01 session test', '${a.workshop}')
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
        user_metadata: { name: `TL01 ${a.role}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${a.email} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

/** Sign in for real and return the access token PostgREST will be given. */
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

// ---------------------------------------------------------------------------
// The checks, over HTTP
// ---------------------------------------------------------------------------

/**
 * One PostgREST request as a given session, judged against its expectation.
 *
 * `blocked` passes on a 4xx OR on an empty result set, because RLS denies a read
 * by filtering it rather than refusing it — a 200 with `[]` is the denial, and
 * treating it as success would be the same mistake the SQL harness made first.
 */
async function req(expect, label, token, method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let rows = null
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) rows = parsed.length
  } catch { /* not an array body */ }

  const denied = res.status >= 400 || rows === 0
  const allowed = res.status < 400 && rows !== null && rows > 0
  const verdict = expect === 'blocked' ? (denied ? 'PASS' : 'FAIL') : allowed ? 'PASS' : 'FAIL'
  const detail = res.status >= 400
    ? `${res.status} ${text.slice(0, 110).replace(/\s+/g, ' ')}`
    : `${res.status}, ${rows ?? '?'} row(s)`
  record(verdict, expect, label, detail)
  return { status: res.status, rows }
}

async function runChecks() {
  const evaluator = await signIn(ACCOUNTS.evaluator)
  const otherAdmin = await signIn(ACCOUNTS.otherAdmin)
  record('PASS', 'setup', 'both temporary accounts sign in over real HTTP', 'two access tokens issued')

  // --- device A: an evaluator in the pilot workshop -----------------------
  await req('permitted', 'A: reads its own workshop', evaluator, 'GET',
    `workshop?id=eq.${BALI}&select=id,name`)
  await req('permitted', 'A: reads that workshop\'s activities', evaluator, 'GET',
    `activity?workshop_id=eq.${BALI}&select=id`)
  await req('permitted', 'A: reads its own membership row', evaluator, 'GET',
    `workshop_member?workshop_id=eq.${BALI}&select=role`)
  await req('permitted', 'A: writes a capture into its own workshop', evaluator, 'POST',
    'evaluation', { client_id: `tl01-session-${Date.now()}`, workshop_id: BALI, source_text: 'legit' })

  // --- the cross-workshop boundary, both directions -----------------------
  await req('blocked', 'A: reads the other workshop', evaluator, 'GET',
    `workshop?id=eq.${FIXTURE_WS}&select=id`)
  await req('blocked', 'A: reads the other workshop\'s participants', evaluator, 'GET',
    `participant?workshop_id=eq.${FIXTURE_WS}&select=id`)
  await req('blocked', 'A: reads the other workshop\'s captures', evaluator, 'GET',
    `evaluation?workshop_id=eq.${FIXTURE_WS}&select=id`)
  await req('blocked', 'A: writes a capture into the other workshop', evaluator, 'POST',
    'evaluation',
    { client_id: `tl01-forged-${Date.now()}`, workshop_id: FIXTURE_WS, source_text: 'forged' })
  await req('blocked', 'A: renames the other workshop\'s participant', evaluator, 'PATCH',
    `participant?workshop_id=eq.${FIXTURE_WS}`, { name: 'hijacked' })

  await req('permitted', 'B: reads its own workshop', otherAdmin, 'GET',
    `workshop?id=eq.${FIXTURE_WS}&select=id`)
  await req('blocked', 'B (an admin elsewhere): reads the pilot workshop', otherAdmin, 'GET',
    `workshop?id=eq.${BALI}&select=id`)
  await req('blocked', 'B (an admin elsewhere): reads the pilot\'s captures', otherAdmin, 'GET',
    `evaluation?workshop_id=eq.${BALI}&select=id`)
  await req('blocked', 'B (an admin elsewhere): edits a pilot participant', otherAdmin, 'PATCH',
    `participant?workshop_id=eq.${BALI}`, { name: 'hijacked' })

  // --- self-promotion, over the wire --------------------------------------
  await req('blocked', 'A: grants itself a membership in the other workshop', evaluator, 'POST',
    'workshop_member',
    { workshop_id: FIXTURE_WS, app_user_id: '00000000-0000-0000-0000-000000000000', role: 'chief_admin' })
  await req('blocked', 'A: raises its own role in its own workshop', evaluator, 'PATCH',
    `workshop_member?workshop_id=eq.${BALI}`, { role: 'chief_admin' })
  await req('blocked', 'A: grants itself the platform tier', evaluator, 'PATCH',
    'app_user?email=eq.' + encodeURIComponent(ACCOUNTS.evaluator.email), { role: 'platform_owner' })
  await req('blocked', 'A: creates a workshop without the platform tier', evaluator, 'POST',
    'workshop', { name: 'smuggled over http' })
  await req('blocked', 'A: reads an account it shares no workshop with', evaluator, 'GET',
    'app_user?email=eq.' + encodeURIComponent(ACCOUNTS.otherAdmin.email) + '&select=email')

  // --- the anon key, which ships in the client bundle ---------------------
  await req('blocked', 'anon: reads the workshop list', null, 'GET', 'workshop?select=id')
  await req('blocked', 'anon: reads the participant list', null, 'GET', 'participant?select=id')
  await req('blocked', 'anon: reads captures', null, 'GET', 'evaluation?select=id')

  // --- and nothing landed -------------------------------------------------
  const state = await sql(`
    select (select count(*) from participant where name = 'hijacked') as hijacked,
           (select count(*) from evaluation where client_id like 'tl01-forged-%') as forged,
           (select count(*) from workshop where name = 'smuggled over http') as smuggled,
           (select u.role from app_user u where u.email = '${ACCOUNTS.evaluator.email}') as tier,
           (select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email = '${ACCOUNTS.evaluator.email}') as ws_role,
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email = '${ACCOUNTS.evaluator.email}' and wm.workshop_id = '${FIXTURE_WS}')
             as gained;`)
  const s = state[0]
  record(s.hijacked === 0 ? 'PASS' : 'FAIL', 'state', 'no participant was renamed', `${s.hijacked} named "hijacked"`)
  record(s.forged === 0 ? 'PASS' : 'FAIL', 'state', 'no capture was forged into the other workshop', `${s.forged} forged`)
  record(s.smuggled === 0 ? 'PASS' : 'FAIL', 'state', 'no workshop was smuggled in', `${s.smuggled} smuggled`)
  record(s.tier === 'member' ? 'PASS' : 'FAIL', 'state', 'attacker\'s platform tier unchanged', `role = ${s.tier}`)
  record(s.ws_role === 'evaluator' ? 'PASS' : 'FAIL', 'state', 'attacker\'s workshop role unchanged', `role = ${s.ws_role}`)
  record(s.gained === 0 ? 'PASS' : 'FAIL', 'state', 'attacker gained no membership elsewhere', `${s.gained} rows`)
}

// ---------------------------------------------------------------------------

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
  if (mode !== '--keep') await teardown(serviceKey)
  else console.log('\n[--keep] temporary accounts left in place for the browser run')
}

const failed = results.filter((r) => r.verdict !== 'PASS')
console.log(`\n${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
