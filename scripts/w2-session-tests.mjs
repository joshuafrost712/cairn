/**
 * Wave 2 acceptance for the three new tables, over real authenticated sessions
 * and real HTTP.
 *
 * Same shape and the same reasoning as scripts/tl01-session-tests.mjs, which it
 * deliberately mirrors: the thing being checked is the response ON THE WIRE, not
 * a policy expression evaluated in place, because that is what the browser
 * actually gets. And because RLS DENIES A READ BY FILTERING IT, a denial is a
 * 200 with an empty array rather than an error. A check that only looked for a
 * 4xx would pass while reading nothing and prove nothing.
 *
 * What it pins:
 *
 *   workshop_setting   any member reads; only the author roles write.
 *   report_assignment  any member reads (an evaluator must see their own
 *                      queue); only the author roles write, so nobody can hand
 *                      themselves work or hand their work away.
 *   doc_draft          author roles ONLY, on all four verbs. This is the one
 *                      that matters most: workshop_member includes the
 *                      `participant` role, and a participant email contains that
 *                      participant's assessment, so a member-wide read policy
 *                      would publish the evaluations to the people being
 *                      evaluated. There is a check for exactly that below.
 *
 * Self-provisioning and self-cleaning: it creates a throwaway workshop with
 * three throwaway accounts in it (participant, evaluator, chief_evaluator), runs
 * the checks, and removes all of it. It never touches a real person's account,
 * and it never runs a request under test with the service_role key, which
 * bypasses RLS and would make every check pass for the wrong reason.
 *
 *   node scripts/w2-session-tests.mjs            # provision, test, tear down
 *   node scripts/w2-session-tests.mjs --keep     # leave the accounts in place
 *   node scripts/w2-session-tests.mjs --teardown # remove them
 *
 * Credentials: anon key from .env, service_role fetched from the Management API
 * with SUPABASE_ACCESS_TOKEN (see the vault memory for where that lives).
 * Nothing is written to disk.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const BALI = '11111111-1111-1111-1111-111111111111'
const W2_WS = '33333333-3333-3333-3333-333333333333'
const W2_PARTICIPANT = '44444444-4444-4444-4444-444444444444'

const PASSWORD = 'w2-Throwaway-Password-1!'
const ACCOUNTS = {
  participant: { email: 'w2-session-participant@example.org', role: 'participant' },
  evaluator: { email: 'w2-session-evaluator@example.org', role: 'evaluator' },
  chief: { email: 'w2-session-chief@example.org', role: 'chief_evaluator' },
  // Not used by the policy checks: Settings is ADMIN_ROLES in the client, and
  // scripts/w2-ui-walkthrough.mjs needs an account that can actually open it.
  admin: { email: 'w2-session-admin@example.org', role: 'admin' },
}

// ---------------------------------------------------------------------------
// Plumbing (identical to the tl-01 harness; kept local rather than shared so
// each script stays runnable on its own)
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

// ---------------------------------------------------------------------------
// Provision / teardown
// ---------------------------------------------------------------------------

async function teardown(serviceKey) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('w2-session-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from doc_draft where id like 'w2-session-%';
    delete from app_user where email like 'w2-session-%';
    delete from role_allowlist where email like 'w2-session-%';
    delete from workshop where id = '${W2_WS}';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)

  // A workshop with one of each new row already in it, so the "permitted read"
  // checks have something to return. Without seeded rows every read would come
  // back empty and read as a denial, which is the trap this whole harness exists
  // to avoid falling into.
  await sql(`
    insert into workshop (id, name, start_date, location)
    values ('${W2_WS}', 'W2 Session Fixture Workshop', '2027-02-01', 'Nowhere');
    insert into participant (id, workshop_id, name)
    values ('${W2_PARTICIPANT}', '${W2_WS}', 'W2 Session Participant');
    -- Three more with nobody on them. The policy checks below do not need them;
    -- scripts/w2-ui-walkthrough.mjs does, because a board where everyone is
    -- already covered cannot demonstrate the attention colour or auto-assign.
    insert into participant (workshop_id, name) values
      ('${W2_WS}', 'W2 Uncovered Alpha'),
      ('${W2_WS}', 'W2 Uncovered Bravo'),
      ('${W2_WS}', 'W2 Uncovered Charlie');
    insert into workshop_setting (workshop_id, key, value)
    values ('${W2_WS}', 'required_confirmations', to_jsonb(2));
    insert into report_assignment (workshop_id, participant_id, evaluator_email, kind)
    values ('${W2_WS}', '${W2_PARTICIPANT}', 'seeded@example.org', 'review');
    insert into doc_draft (id, workshop_id, kind, subject_key, updated_at, status)
    values ('w2-session-seeded-draft', '${W2_WS}', 'participant_email',
            '${W2_PARTICIPANT}', now(), 'approved');
    select 1;`)

  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'wave 2 session test', '${W2_WS}')
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
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { name: `W2 ${a.role}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${a.email} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

async function signIn(a) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: PASSWORD }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${a.email}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body.access_token
}

/**
 * One PostgREST request as a given session, judged against its expectation.
 *
 * `blocked` passes on a 4xx OR on an empty result set, because RLS denies a read
 * by filtering it rather than refusing it: a 200 with `[]` IS the denial.
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
  const detail =
    res.status >= 400
      ? `${res.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`
      : `${res.status}, ${rows ?? '?'} row(s)`
  record(verdict, expect, label, detail)
  return { status: res.status, rows }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function runChecks() {
  const participant = await signIn(ACCOUNTS.participant)
  const evaluator = await signIn(ACCOUNTS.evaluator)
  const chief = await signIn(ACCOUNTS.chief)
  record('PASS', 'setup', 'the temporary accounts sign in over real HTTP', 'tokens issued')

  // --- doc_draft: the one that is chief-only, and why ----------------------
  await req('blocked', 'participant: reads outgoing documents about themselves', participant, 'GET',
    `doc_draft?workshop_id=eq.${W2_WS}&select=id,status`)
  await req('blocked', 'evaluator: reads outgoing documents', evaluator, 'GET',
    `doc_draft?workshop_id=eq.${W2_WS}&select=id`)
  await req('permitted', 'chief: reads outgoing documents', chief, 'GET',
    `doc_draft?workshop_id=eq.${W2_WS}&select=id,status`)
  await req('permitted', 'chief: writes an outgoing document', chief, 'POST', 'doc_draft', {
    id: `w2-session-chief-${Date.now()}`,
    workshop_id: W2_WS,
    kind: 'participant_email',
    subject_key: W2_PARTICIPANT,
    updated_at: new Date().toISOString(),
  })
  await req('blocked', 'evaluator: writes an outgoing document', evaluator, 'POST', 'doc_draft', {
    id: `w2-session-forged-${Date.now()}`,
    workshop_id: W2_WS,
    kind: 'participant_email',
    subject_key: W2_PARTICIPANT,
    updated_at: new Date().toISOString(),
  })
  await req('blocked', 'participant: marks a document sent', participant, 'PATCH',
    `doc_draft?workshop_id=eq.${W2_WS}`, { status: 'sent' })

  // --- report_assignment: readable by members, writable by authors ---------
  await req('permitted', 'evaluator: reads the rota, including their own queue', evaluator, 'GET',
    `report_assignment?workshop_id=eq.${W2_WS}&select=participant_id,evaluator_email`)
  await req('blocked', 'evaluator: hands themselves a participant', evaluator, 'POST',
    'report_assignment',
    { workshop_id: W2_WS, participant_id: W2_PARTICIPANT, evaluator_email: ACCOUNTS.evaluator.email, kind: 'review' })
  await req('blocked', 'evaluator: hands their own work to somebody else', evaluator, 'PATCH',
    `report_assignment?workshop_id=eq.${W2_WS}`, { evaluator_email: 'someone@example.org' })
  await req('blocked', 'evaluator: drops an assignment they do not want', evaluator, 'DELETE',
    `report_assignment?workshop_id=eq.${W2_WS}&evaluator_email=eq.seeded@example.org`)
  await req('blocked', 'participant: assigns themselves a friendly reviewer', participant, 'POST',
    'report_assignment',
    { workshop_id: W2_WS, participant_id: W2_PARTICIPANT, evaluator_email: 'friend@example.org', kind: 'review' })
  await req('permitted', 'chief: assigns a participant to an evaluator', chief, 'POST',
    'report_assignment',
    { workshop_id: W2_WS, participant_id: W2_PARTICIPANT, evaluator_email: ACCOUNTS.evaluator.email, kind: 'review' })

  // --- workshop_setting: readable by members, writable by authors ----------
  await req('permitted', 'evaluator: reads the threshold their work is judged by', evaluator, 'GET',
    `workshop_setting?workshop_id=eq.${W2_WS}&select=key,value`)
  await req('blocked', 'evaluator: lowers the verification threshold', evaluator, 'PATCH',
    `workshop_setting?workshop_id=eq.${W2_WS}&key=eq.required_confirmations`, { value: 1 })
  await req('blocked', 'participant: raises their own review quota', participant, 'POST',
    'workshop_setting',
    { workshop_id: W2_WS, key: 'review_quota_default', value: 99 })
  await req('permitted', 'chief: sets the review quota', chief, 'POST', 'workshop_setting', {
    workshop_id: W2_WS,
    key: 'review_quota_default',
    value: 4,
  })

  // --- the cross-workshop boundary on the new tables -----------------------
  await req('blocked', 'chief here: reads the pilot workshop\'s rota', chief, 'GET',
    `report_assignment?workshop_id=eq.${BALI}&select=participant_id`)
  await req('blocked', 'chief here: reads the pilot workshop\'s settings', chief, 'GET',
    `workshop_setting?workshop_id=eq.${BALI}&select=key`)
  await req('blocked', 'chief here: reads the pilot workshop\'s documents', chief, 'GET',
    `doc_draft?workshop_id=eq.${BALI}&select=id`)
  await req('blocked', 'chief here: assigns somebody in the pilot workshop', chief, 'POST',
    'report_assignment',
    { workshop_id: BALI, participant_id: W2_PARTICIPANT, evaluator_email: 'x@example.org', kind: 'review' })

  // --- the anon key, which ships in the client bundle ----------------------
  await req('blocked', 'anon: reads the rota', null, 'GET', 'report_assignment?select=participant_id')
  await req('blocked', 'anon: reads workshop settings', null, 'GET', 'workshop_setting?select=key')
  await req('blocked', 'anon: reads outgoing documents', null, 'GET', 'doc_draft?select=id')

  // --- and nothing landed --------------------------------------------------
  const state = await sql(`
    select (select count(*) from doc_draft where id like 'w2-session-forged-%') as forged,
           (select count(*) from doc_draft where workshop_id = '${W2_WS}' and status = 'sent') as marked_sent,
           (select count(*) from report_assignment
             where workshop_id = '${W2_WS}' and evaluator_email = 'friend@example.org') as self_assigned,
           (select count(*) from report_assignment
             where workshop_id = '${W2_WS}' and evaluator_email = 'seeded@example.org') as seeded_survives,
           (select count(*) from report_assignment where workshop_id = '${BALI}'
             and evaluator_email = 'x@example.org') as cross_workshop,
           (select value::text from workshop_setting
             where workshop_id = '${W2_WS}' and key = 'required_confirmations') as threshold;`)
  const s = state[0]
  const check = (ok, label, outcome) => record(ok ? 'PASS' : 'FAIL', 'state', label, outcome)
  check(Number(s.forged) === 0, 'no document was forged by an evaluator', `${s.forged} forged`)
  check(Number(s.marked_sent) === 0, 'no document was marked sent by a participant', `${s.marked_sent} sent`)
  check(Number(s.self_assigned) === 0, 'no participant chose their own reviewer', `${s.self_assigned} rows`)
  check(Number(s.seeded_survives) === 1, 'the evaluator could not delete their assignment', `${s.seeded_survives} row`)
  check(Number(s.cross_workshop) === 0, 'nothing was written into the pilot workshop', `${s.cross_workshop} rows`)
  check(s.threshold === '2', 'the verification threshold was not lowered', `value = ${s.threshold}`)
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
  else console.log('\n[--keep] temporary accounts left in place')
}

const failed = results.filter((r) => r.verdict !== 'PASS')
console.log(`\n${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
