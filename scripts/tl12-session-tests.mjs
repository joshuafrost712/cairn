/**
 * tl-12 acceptance, over real authenticated sessions and real HTTP.
 *
 * Everything this spec is FOR is a permission: who may read somebody's
 * credentials, who may write them, and who may join two people's histories
 * together. `test/personProfiles.test.ts` checks the client's copy of those rules
 * and greps the migration for their shape; neither is evidence about the database.
 * This is.
 *
 * Three things in particular can only break here.
 *
 *   1. **A denied READ returns 200 with zero rows.** RLS filters rather than
 *      refuses on select, per the standing lesson, so an `admins`-only profile
 *      leaking to an evaluator would look exactly like a successful request in
 *      every log the app keeps. The only way to see it is to count rows.
 *   2. **`merge_persons` is callable at all.** PostgREST maps JSON keys to
 *      parameter names, it takes leading-underscore parameters, and the grant to
 *      `authenticated` is separate from every policy — the same three ways tl-11's
 *      RPCs could have been unreachable.
 *   3. **A refusal still carries its slug.** `mergePersons` reads `code` and
 *      `details` off the error body and maps `tl12.*` to a chrome string. If the
 *      slug does not arrive, every refusal on the merge screen silently degrades
 *      to raw Postgres prose with nothing failing.
 *
 *   node scripts/tl12-session-tests.mjs            # provision, test, tear down
 *   node scripts/tl12-session-tests.mjs --teardown # remove them
 *
 * Prefix-scoped fixtures and prefix-scoped teardown throughout (`tl12-session-*`,
 * two fixture workshop ids), so this can share the live project with another
 * harness without either wiping the other's state.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
/** The workshop the profiles live in. */
const WS = 'a5000000-0000-4000-8000-00000000ee01'
/** A second workshop, whose admin must NOT be able to read into the first. */
const WS2 = 'a5000000-0000-4000-8000-00000000ee02'

const ACCOUNTS = {
  chief: { email: 'tl12-session-chief@example.org', password: 'tl12-Throwaway-Password-1!', role: 'chief_admin', ws: WS },
  evaluator: { email: 'tl12-session-evaluator@example.org', password: 'tl12-Throwaway-Password-2!', role: 'evaluator', ws: WS },
  subject: { email: 'tl12-session-subject@example.org', password: 'tl12-Throwaway-Password-3!', role: 'evaluator', ws: WS },
  outsider: { email: 'tl12-session-outsider@example.org', password: 'tl12-Throwaway-Password-4!', role: 'chief_admin', ws: WS2 },
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
  console.log(`${verdict} ${expect.padEnd(9)} | ${label.slice(0, 66).padEnd(66)} | ${outcome}`)
}

const assert = (label, condition, detail) =>
  record(condition ? 'PASS' : 'FAIL', 'state', label, detail)

async function teardown(serviceKey) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl12-session-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  // person_profile cascades from person. Participants are deleted before the
  // people they point at only because the fixture participants are ours; the FK is
  // `on delete set null`, so the order is tidiness rather than necessity.
  await sql(`
    delete from participant where workshop_id in ('${WS}', '${WS2}');
    delete from workshop_member where workshop_id in ('${WS}', '${WS2}');
    delete from app_user where email like 'tl12-session-%';
    delete from role_allowlist where email like 'tl12-session-%';
    delete from workshop where id in ('${WS}', '${WS2}');
    delete from auth.identities where identity_data->>'email' like 'tl12-session-%';
    delete from auth.users where email like 'tl12-session-%';
    delete from person where primary_email like 'tl12-session-%'
       or display_name like 'TL12 %';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)
  await sql(`
    insert into workshop (id, name, start_date, location) values
      ('${WS}',  'TL12 Session Fixture Workshop', '2027-11-01', 'Nowhere'),
      ('${WS2}', 'TL12 Session Other Workshop',   '2027-12-01', 'Elsewhere');
    select 1;`)

  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'tl-12 session test', '${a.ws}')
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
        user_metadata: { name: `TL12 ${a.role}` },
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
 * The reason this harness exists. A denied read is 200 with `[]`, so treating a
 * 200 as success would mark every leak-prevention check green whether the rule
 * held or not.
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

/** A write, judged on status: a refused write really does refuse, with 42501. */
async function write(expect, label, token, path, method, body) {
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
  // An UPDATE that RLS filters out returns 200 with an empty array: nothing was
  // refused, nothing was changed. That is a denial and must be counted as one.
  const changedNothing = method === 'PATCH' && Array.isArray(parsed) && parsed.length === 0
  const ok = res.status < 400 && !changedNothing
  const verdict = expect === 'blocked' ? (ok ? 'FAIL' : 'PASS') : ok ? 'PASS' : 'FAIL'
  record(verdict, expect, label, `${res.status} code=${parsed?.code ?? '-'} ${changedNothing ? '(0 rows changed)' : ''}`)
  return { status: res.status, body: parsed }
}

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
  record(verdict, expect, label, ok
    ? `${res.status} ${text.slice(0, 80)}`
    : `${res.status} code=${body?.code ?? '?'} details=${body?.details ?? '?'}`)
  return { status: res.status, body }
}

async function runChecks() {
  const chief = await signIn(ACCOUNTS.chief)
  const evaluator = await signIn(ACCOUNTS.evaluator)
  const subject = await signIn(ACCOUNTS.subject)
  const outsider = await signIn(ACCOUNTS.outsider)
  record('PASS', 'setup', 'four temporary accounts sign in over real HTTP', 'four access tokens issued')

  // The signup trigger should have minted a person for each account.
  const linked = await sql(`
    select email, person_id is not null as linked from app_user
    where email like 'tl12-session-%' order by email;`)
  assert('app_user_link_person minted a person for every new account',
    linked.length === 4 && linked.every((r) => r.linked),
    JSON.stringify(linked.map((r) => `${r.email.split('@')[0]}=${r.linked}`)))

  const ids = await sql(`
    select email, person_id from app_user where email like 'tl12-session-%';`)
  const personOf = Object.fromEntries(ids.map((r) => [r.email, r.person_id]))
  const subjectPerson = personOf[ACCOUNTS.subject.email]

  // --- a workshop-visible profile ------------------------------------------
  await sql(`
    insert into person_profile (person_id, headline, certifications, visibility)
    values ('${subjectPerson}', 'TL12 fixture headline', array['CBC level 2'], 'workshop')
    on conflict (person_id) do update set visibility = 'workshop';
    select 1;`)

  await get('permitted', 'the subject reads their own profile', subject,
    `person_profile?person_id=eq.${subjectPerson}&select=headline,visibility`)
  await get('permitted', 'a fellow evaluator reads a workshop-visible profile', evaluator,
    `person_profile?person_id=eq.${subjectPerson}&select=headline,visibility`)
  await get('permitted', 'the workshop`s chief admin reads it', chief,
    `person_profile?person_id=eq.${subjectPerson}&select=headline,visibility`)

  // The spec's cross-workshop negative. An administrator, but of somewhere else.
  await get('blocked', 'a chief admin of ANOTHER workshop reads nothing', outsider,
    `person_profile?person_id=eq.${subjectPerson}&select=headline,visibility`)
  await get('blocked', 'an anonymous session reads nothing', null,
    `person_profile?person_id=eq.${subjectPerson}&select=headline,visibility`)

  // --- admins-only ----------------------------------------------------------
  await sql(`update person_profile set visibility = 'admins' where person_id = '${subjectPerson}'; select 1;`)
  await get('blocked', 'an evaluator in the workshop reads an admins-only profile', evaluator,
    `person_profile?person_id=eq.${subjectPerson}&select=headline`)
  await get('permitted', 'the chief admin still reads it', chief,
    `person_profile?person_id=eq.${subjectPerson}&select=headline`)
  await get('permitted', 'and so does its subject', subject,
    `person_profile?person_id=eq.${subjectPerson}&select=headline`)

  // --- private --------------------------------------------------------------
  await sql(`update person_profile set visibility = 'private' where person_id = '${subjectPerson}'; select 1;`)
  await get('blocked', 'an evaluator in the workshop reads a private profile', evaluator,
    `person_profile?person_id=eq.${subjectPerson}&select=headline`)
  await get('permitted', 'its subject reads their own private profile', subject,
    `person_profile?person_id=eq.${subjectPerson}&select=headline`)
  await sql(`update person_profile set visibility = 'workshop' where person_id = '${subjectPerson}'; select 1;`)

  // --- who may WRITE --------------------------------------------------------
  await write('blocked', 'an evaluator cannot rewrite a colleague`s profile', evaluator,
    `person_profile?person_id=eq.${subjectPerson}`, 'PATCH', { headline: 'injected by a peer' })
  await write('permitted', 'the subject edits their own', subject,
    `person_profile?person_id=eq.${subjectPerson}`, 'PATCH', { headline: 'edited by its owner' })
  await write('permitted', 'and so may the workshop`s chief admin', chief,
    `person_profile?person_id=eq.${subjectPerson}`, 'PATCH', { headline: 'edited by the chief admin' })
  await write('blocked', 'an admin of another workshop cannot', outsider,
    `person_profile?person_id=eq.${subjectPerson}`, 'PATCH', { headline: 'injected from elsewhere' })

  const finalHeadline = await sql(
    `select headline from person_profile where person_id = '${subjectPerson}';`)
  assert('and none of the refused writes changed anything',
    finalHeadline[0]?.headline === 'edited by the chief admin',
    `headline=${finalHeadline[0]?.headline}`)

  await write('blocked', 'an evaluator cannot create a person row', evaluator,
    'person', 'POST', { display_name: 'TL12 Injected Person' })

  // --- the merge ------------------------------------------------------------
  // Two participants in WS, one in WS2, each with a person of its own.
  await sql(`
    insert into person (id, display_name, primary_email) values
      ('a5000000-0000-4000-8000-0000000000a1', 'TL12 Amos Khokhar', null),
      ('a5000000-0000-4000-8000-0000000000a2', 'TL12 Amos Kokhar',  null),
      ('a5000000-0000-4000-8000-0000000000a3', 'TL12 Elsewhere Person', null);
    insert into participant (id, workshop_id, name, person_id) values
      ('a5000000-0000-4000-8000-0000000000b1', '${WS}',  'TL12 Amos Khokhar', 'a5000000-0000-4000-8000-0000000000a1'),
      ('a5000000-0000-4000-8000-0000000000b2', '${WS}',  'TL12 Amos Kokhar',  'a5000000-0000-4000-8000-0000000000a2'),
      ('a5000000-0000-4000-8000-0000000000b3', '${WS2}', 'TL12 Elsewhere',    'a5000000-0000-4000-8000-0000000000a3');
    insert into person_profile (person_id, certifications, experience_areas, visibility) values
      ('a5000000-0000-4000-8000-0000000000a1', array['CBC level 2'], array['Psalms'],   'workshop'),
      ('a5000000-0000-4000-8000-0000000000a2', array['CLAT'],        array['Epistles'], 'admins');
    select 1;`)

  await rpc('blocked', 'an evaluator cannot merge two people', evaluator, 'merge_persons', {
    _survivor_id: 'a5000000-0000-4000-8000-0000000000a1',
    _absorbed_id: 'a5000000-0000-4000-8000-0000000000a2',
  })

  // The rule that is stricter than "I administer one of them".
  const crossWorkshop = await rpc('blocked',
    'a chief admin cannot absorb somebody from a workshop they do not administer', chief,
    'merge_persons', {
      _survivor_id: 'a5000000-0000-4000-8000-0000000000a1',
      _absorbed_id: 'a5000000-0000-4000-8000-0000000000a3',
    })
  assert('and that refusal arrives with a tl12.* slug the browser can map',
    crossWorkshop.body?.code === '42501' &&
      crossWorkshop.body?.details === 'tl12.merge_needs_both_workshops',
    `code=${crossWorkshop.body?.code} details=${crossWorkshop.body?.details}`)

  const same = await rpc('blocked', 'merging somebody into themselves is refused', chief,
    'merge_persons', {
      _survivor_id: 'a5000000-0000-4000-8000-0000000000a1',
      _absorbed_id: 'a5000000-0000-4000-8000-0000000000a1',
    })
  assert('with its own slug', same.body?.details === 'tl12.merge_needs_two',
    `details=${same.body?.details}`)

  const merged = await rpc('permitted', 'the chief admin merges the two duplicates', chief,
    'merge_persons', {
      _survivor_id: 'a5000000-0000-4000-8000-0000000000a1',
      _absorbed_id: 'a5000000-0000-4000-8000-0000000000a2',
    })
  assert('the RPC reports what moved, which is what the UI prints',
    merged.body?.ok === true && merged.body?.moved_participants === 1,
    JSON.stringify(merged.body))

  const after = await sql(`
    select
      (select count(*) from participant
        where person_id = 'a5000000-0000-4000-8000-0000000000a1') as repointed,
      (select count(*) from participant
        where id in ('a5000000-0000-4000-8000-0000000000b1','a5000000-0000-4000-8000-0000000000b2')) as participants_left,
      (select count(*) from person where id = 'a5000000-0000-4000-8000-0000000000a2') as absorbed_left,
      (select certifications from person_profile
        where person_id = 'a5000000-0000-4000-8000-0000000000a1') as certs,
      (select visibility from person_profile
        where person_id = 'a5000000-0000-4000-8000-0000000000a1') as visibility;`)
  assert('both participant rows now point at the survivor', after[0]?.repointed === 2,
    `repointed=${after[0]?.repointed}`)
  assert('and NEITHER participant row was deleted, so no evidence moved',
    after[0]?.participants_left === 2, `participants=${after[0]?.participants_left}`)
  assert('the absorbed person is gone', Number(after[0]?.absorbed_left) === 0,
    `absorbed=${after[0]?.absorbed_left}`)
  assert('the two credential lists were unioned, not replaced',
    JSON.stringify(after[0]?.certs) === JSON.stringify(['CBC level 2', 'CLAT']),
    JSON.stringify(after[0]?.certs))
  // Widening somebody's exposure as a side effect of an administrative tidy-up is
  // the one thing a merge must not do.
  assert('and visibility narrowed to the stricter of the two rather than widening',
    after[0]?.visibility === 'admins', `visibility=${after[0]?.visibility}`)
}

async function main() {
  const serviceKey = await serviceRoleKey()
  if (process.argv.includes('--teardown')) {
    await teardown(serviceKey)
    console.log('tl-12 session fixtures removed.')
    return
  }
  await provision(serviceKey)
  try {
    await runChecks()
  } finally {
    await teardown(serviceKey)
  }
  const failed = results.filter((r) => r.verdict === 'FAIL')
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
