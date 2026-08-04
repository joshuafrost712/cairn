/**
 * tl-16 acceptance, over real authenticated sessions and real HTTP.
 *
 * `test/templates.test.ts` greps the migration for the shape of its policies and pins
 * the key list against the SQL. Neither is evidence about the database, and this spec's
 * whole surface is a permission plus a constraint: who may reword what twenty-six people
 * will read, and what the database refuses to store.
 *
 * Four things can only break here.
 *
 *   1. **A denied READ returns 200 with zero rows.** RLS filters rather than refuses on
 *      select, per the standing lesson, so a template leaking across workshops would look
 *      exactly like a successful request in every log the app keeps. Only a row count sees
 *      it. This matters more than usual for THIS table because a leak is silent twice
 *      over: the reader's own document would render with the other workshop's wording.
 *   2. **The read policy is deliberately WIDER than the write policy**, which is unusual
 *      here — `ai_config` and `doc_draft` are admin-only in both directions. A template
 *      has to be readable by an evaluator's device, because that is where a participant
 *      report gets rendered, and it holds no evidence. So "an evaluator can read and
 *      cannot write" is an assertion in two directions rather than one.
 *   3. **A chief evaluator must NOT be able to write**, and this is the one gate in the
 *      spec that could plausibly have gone the other way. `workshop_setting` lets a chief
 *      evaluator write; `ai_config` does not. Templates follow `ai_config`, because the
 *      Setup hub is gated ADMIN_ROLES since tl-07 and Wave 2's scar was a UI gate and an
 *      RLS policy naming different lists.
 *   4. **The trigger's refusals carry their slugs.** An unknown key, an empty body and an
 *      oversize body each come back as 23514 with a `tl16.*` detail. If the slug does not
 *      arrive, the editor's message degrades to raw Postgres prose with nothing failing.
 *
 *   node scripts/tl16-session-tests.mjs            # provision, test, tear down
 *   node scripts/tl16-session-tests.mjs --teardown # remove them
 *
 * Prefix-scoped fixtures and prefix-scoped teardown throughout (`tl16-session-*`, two
 * fixture workshop ids), so this can share the live project with another harness without
 * either wiping the other's state.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
/** The workshop the templates live in. */
const WS = 'a6000000-0000-4000-8000-00000000ff01'
/** A second workshop, whose admin must NOT be able to read or write into the first. */
const WS2 = 'a6000000-0000-4000-8000-00000000ff02'

const KEY = 'participant_email.intro'
const KEY2 = 'instructions.observation_routing'

const ACCOUNTS = {
  admin: { email: 'tl16-session-admin@example.org', password: 'tl16-Throwaway-Password-1!', role: 'admin', ws: WS },
  chiefEval: { email: 'tl16-session-chiefeval@example.org', password: 'tl16-Throwaway-Password-2!', role: 'chief_evaluator', ws: WS },
  evaluator: { email: 'tl16-session-evaluator@example.org', password: 'tl16-Throwaway-Password-3!', role: 'evaluator', ws: WS },
  outsider: { email: 'tl16-session-outsider@example.org', password: 'tl16-Throwaway-Password-4!', role: 'admin', ws: WS2 },
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
  console.log(`${verdict} ${expect.padEnd(9)} | ${label.slice(0, 68).padEnd(68)} | ${outcome}`)
}

const assert = (label, condition, detail) =>
  record(condition ? 'PASS' : 'FAIL', 'state', label, detail)

async function teardown(serviceKey) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl16-session-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  // `ai_template` cascades from workshop, so deleting the fixture workshops is enough —
  // it is deleted explicitly anyway, because a cascade that stops working is exactly the
  // kind of thing a teardown should not depend on silently.
  //
  // The `person` line is tl-12's lesson, added to all 25 harnesses: `app_user_link_person`
  // is an AFTER INSERT trigger, so removing the account leaves the minted person behind.
  await sql(`
    delete from ai_template where workshop_id in ('${WS}', '${WS2}');
    delete from workshop_member where workshop_id in ('${WS}', '${WS2}');
    delete from app_user where email like 'tl16-session-%';
    delete from role_allowlist where email like 'tl16-session-%';
    delete from workshop where id in ('${WS}', '${WS2}');
    delete from auth.identities where identity_data->>'email' like 'tl16-session-%';
    delete from auth.users where email like 'tl16-session-%';
    delete from person where primary_email like 'tl16-session-%'
       or display_name like 'TL16 %';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)
  await sql(`
    insert into workshop (id, name, start_date, location) values
      ('${WS}',  'TL16 Session Fixture Workshop', '2027-11-01', 'Nowhere'),
      ('${WS2}', 'TL16 Session Other Workshop',   '2027-12-01', 'Elsewhere');
    select 1;`)

  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'tl-16 session test', '${a.ws}')
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
        user_metadata: { name: `TL16 ${a.role}` },
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

/**
 * A select, judged on ROW COUNT and not on status.
 *
 * The reason this harness exists. A denied read is 200 with `[]`, so treating a 200 as
 * success would mark every leak-prevention check green whether the rule held or not.
 */
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
  const verdict = expect === 'blocked' ? (denied ? 'PASS' : 'FAIL') : !denied ? 'PASS' : 'FAIL'
  record(verdict, expect, label, `${res.status}, ${rows ?? '?'} row(s)`)
  return { status: res.status, rows, text }
}

/** A write, judged on status, plus the error code and detail a refusal must carry. */
async function write(expect, label, token, path, method, body, expectDetail) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* not json */ }
  // An UPDATE or DELETE that RLS filters out returns 200 with an empty array: nothing
  // was refused, nothing was changed. That is a denial and must be counted as one.
  const changedNothing =
    (method === 'PATCH' || method === 'DELETE') && Array.isArray(parsed) && parsed.length === 0
  const ok = res.status < 400 && !changedNothing
  let verdict = expect === 'blocked' ? (ok ? 'FAIL' : 'PASS') : ok ? 'PASS' : 'FAIL'
  // A refusal that arrives without its slug is a refusal the editor cannot explain.
  if (expectDetail && verdict === 'PASS' && !String(parsed?.details ?? '').includes(expectDetail)) {
    verdict = 'FAIL'
  }
  record(
    verdict,
    expect,
    label,
    `${res.status} code=${parsed?.code ?? '-'} details=${String(parsed?.details ?? '-').slice(0, 40)}${changedNothing ? ' (0 rows)' : ''}`,
  )
  return { status: res.status, body: parsed }
}

async function runChecks() {
  const admin = await signIn(ACCOUNTS.admin)
  const chiefEval = await signIn(ACCOUNTS.chiefEval)
  const evaluator = await signIn(ACCOUNTS.evaluator)
  const outsider = await signIn(ACCOUNTS.outsider)
  record('PASS', 'setup', 'four temporary accounts sign in over real HTTP', 'four access tokens issued')

  // --- the admin may author -------------------------------------------------
  await write('permitted', 'a workshop admin writes an override', admin, 'ai_template', 'POST', {
    workshop_id: WS,
    kind: 'email',
    template_key: KEY,
    body: 'Authored by the fixture admin on {{dateLabel}}.',
  })

  // --- the read policy is wider than the write policy ------------------------
  await get('permitted', 'an evaluator of the workshop READS it', evaluator,
    `ai_template?workshop_id=eq.${WS}&select=template_key,body`)
  await get('permitted', 'a chief evaluator READS it', chiefEval,
    `ai_template?workshop_id=eq.${WS}&select=template_key,body`)
  await get('permitted', 'the admin READS it', admin,
    `ai_template?workshop_id=eq.${WS}&select=template_key,body`)

  await write('blocked', 'an evaluator cannot insert', evaluator, 'ai_template', 'POST', {
    workshop_id: WS, kind: 'email', template_key: KEY2, body: 'Answer {{range}} only.',
  })
  await write('blocked', 'an evaluator cannot update', evaluator,
    `ai_template?workshop_id=eq.${WS}&template_key=eq.${KEY}`, 'PATCH', { body: 'evaluator wuz here' })
  await write('blocked', 'an evaluator cannot delete', evaluator,
    `ai_template?workshop_id=eq.${WS}&template_key=eq.${KEY}`, 'DELETE', null)

  // The gate that could plausibly have gone the other way. `workshop_setting` lets a
  // chief evaluator write; this follows `ai_config` instead, matching the ADMIN_ROLES
  // gate the Setup hub has carried since tl-07.
  await write('blocked', 'a CHIEF EVALUATOR cannot write, matching the Setup hub gate', chiefEval,
    'ai_template', 'POST', { workshop_id: WS, kind: 'email', template_key: KEY2, body: 'Answer {{range}} only.' })

  // --- nothing crosses a workshop boundary ----------------------------------
  await get('blocked', 'an admin of ANOTHER workshop reads nothing', outsider,
    `ai_template?workshop_id=eq.${WS}&select=template_key,body`)
  await write('blocked', 'an admin of another workshop cannot write into this one', outsider,
    'ai_template', 'POST', { workshop_id: WS, kind: 'email', template_key: KEY2, body: 'x' })
  await get('blocked', 'an anonymous session reads nothing', null,
    `ai_template?workshop_id=eq.${WS}&select=template_key,body`)
  await write('blocked', 'an anonymous session cannot write', null, 'ai_template', 'POST', {
    workshop_id: WS, kind: 'email', template_key: KEY2, body: 'x',
  })

  // --- the trigger's refusals, each with its slug ---------------------------
  await write('blocked', 'an unknown template_key is refused, with its slug', admin,
    'ai_template', 'POST',
    { workshop_id: WS, kind: 'email', template_key: 'participant_email.invented', body: 'x' },
    'tl16.unknown_template_key')
  await write('blocked', 'an empty body is refused, with its slug', admin, 'ai_template', 'POST',
    { workshop_id: WS, kind: 'email', template_key: KEY2, body: '   ' },
    'tl16.body_is_empty')
  await write('blocked', 'an oversize body is refused, with its slug', admin, 'ai_template', 'POST',
    { workshop_id: WS, kind: 'email', template_key: KEY2, body: 'x'.repeat(20_001) },
    'tl16.body_is_too_long')
  await write('blocked', 'a kind outside the four is refused by the column check', admin,
    'ai_template', 'POST', { workshop_id: WS, kind: 'poem', template_key: KEY2, body: 'x' })

  // --- one override per slot per workshop -----------------------------------
  await write('blocked', 'a second row for the same slot is refused by the unique constraint', admin,
    'ai_template', 'POST', { workshop_id: WS, kind: 'email', template_key: KEY, body: 'a rival body' })

  // --- the same slot in two workshops is two independent rows ---------------
  await write('permitted', 'the OTHER workshop authors the same slot independently', outsider,
    'ai_template', 'POST',
    { workshop_id: WS2, kind: 'email', template_key: KEY, body: 'The other workshop’s wording.' })
  const mine = await sql(`select body from ai_template where workshop_id = '${WS}' and template_key = '${KEY}';`)
  const theirs = await sql(`select body from ai_template where workshop_id = '${WS2}' and template_key = '${KEY}';`)
  assert('two workshops hold different wording for the same slot',
    mine[0]?.body?.includes('fixture admin') && theirs[0]?.body?.includes('other workshop'),
    `${JSON.stringify(mine[0]?.body?.slice(0, 30))} vs ${JSON.stringify(theirs[0]?.body?.slice(0, 30))}`)

  // --- updated_at is the trigger's, not the client's ------------------------
  // The client sends a date in 1999; the row must come back stamped now(). A
  // client-settable audit timestamp is not an audit timestamp.
  await write('permitted', 'the admin updates the body', admin,
    `ai_template?workshop_id=eq.${WS}&template_key=eq.${KEY}`, 'PATCH',
    { body: 'Reworded by the fixture admin.', updated_at: '1999-01-01T00:00:00Z' })
  const stamped = await sql(`
    select extract(year from updated_at)::int as yr from ai_template
    where workshop_id = '${WS}' and template_key = '${KEY}';`)
  assert('the trigger overwrote a client-supplied updated_at', stamped[0]?.yr >= 2026,
    `updated_at year = ${stamped[0]?.yr}`)

  // --- revert is a delete, and the admin may do it -------------------------
  await write('permitted', 'the admin deletes the override (revert to default)', admin,
    `ai_template?workshop_id=eq.${WS}&template_key=eq.${KEY}`, 'DELETE', null)
  const gone = await sql(`select count(*)::int as n from ai_template where workshop_id = '${WS}';`)
  assert('the override is gone, so the workshop falls back to the shipped default',
    gone[0]?.n === 0, `${gone[0]?.n} row(s) left`)

  // --- the RPCs this table's validator must NOT be callable by a client ----
  // tl-23's scar: default privileges grant execute to anon and authenticated
  // EXPLICITLY, so `revoke from public` locks nothing. Tested with the privilege
  // function rather than by reading the migration.
  const privs = await sql(`
    select
      has_function_privilege('anon', 'ai_template_is_legal(text,text)', 'EXECUTE') as anon_legal,
      has_function_privilege('authenticated', 'ai_template_is_legal(text,text)', 'EXECUTE') as auth_legal,
      has_function_privilege('anon', 'ai_template_is_permitted()', 'EXECUTE') as anon_trg,
      has_function_privilege('authenticated', 'ai_template_is_permitted()', 'EXECUTE') as auth_trg;`)
  assert('no client role may execute the validator or the trigger function',
    privs[0] && !privs[0].anon_legal && !privs[0].auth_legal && !privs[0].anon_trg && !privs[0].auth_trg,
    JSON.stringify(privs[0]))
}

const serviceKey = await serviceRoleKey()

if (process.argv.includes('--teardown')) {
  await teardown(serviceKey)
  console.log('tl-16 session fixtures removed.')
  process.exit(0)
}

await provision(serviceKey)
if (process.argv.includes('--diag')) {
  const rows = await sql(`
    select au.email, au.id as app_user_id, wm.workshop_id, wm.role
    from app_user au left join workshop_member wm on wm.app_user_id = au.id
    where au.email like 'tl16-session-%' order by au.email;`)
  console.log(JSON.stringify(rows, null, 2))
  const allow = await sql(`select email, assigned_role, default_workshop_id from role_allowlist where email like 'tl16-session-%' order by email;`)
  console.log(JSON.stringify(allow, null, 2))
  process.exit(0)
}
try {
  await runChecks()
} finally {
  await teardown(serviceKey)
}

const failed = results.filter((r) => r.verdict === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} passed.`)
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.label} -> ${f.outcome}`)
  process.exit(1)
}
