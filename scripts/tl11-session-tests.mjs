/**
 * tl-11 acceptance, over real authenticated sessions and real HTTP.
 *
 * scripts/tl11-rls-tests.sql proves the rules by impersonating sessions inside
 * Postgres. It cannot prove three things that break first in a browser:
 *
 *   1. Whether the new RPCs are callable at all. PostgREST maps JSON keys to
 *      parameter names, these take leading-underscore parameters, and the grant to
 *      `authenticated` is separate from every policy.
 *   2. Whether a refusal still carries its slug by the time it reaches the client.
 *      `toResult()` in src/db/membership.ts reads `code` and `details` off the
 *      error body, and tl-11 widened its slug matcher from an exact `tl02.` prefix
 *      to a shape. If `tl11.*` does not arrive in `details`, every refusal on the
 *      People screen silently degrades to raw Postgres prose with nothing failing.
 *   3. Whether a real signup through Supabase Auth honors an invitation. The SQL
 *      harness inserts into `auth.users` directly, which fires the same trigger but
 *      goes nowhere near the auth service — and the auth service is what wraps a
 *      trigger exception before the browser sees it. SignIn's invite-only message
 *      is matched against that wrapped text, so this is the only place the match
 *      can be checked against the real shape.
 *
 *   node scripts/tl11-session-tests.mjs            # provision, test, tear down
 *   node scripts/tl11-session-tests.mjs --teardown # remove them
 *
 * Reads the anon key from .env and the service_role key from the Management API.
 * service_role creates and deletes the temporary accounts and is never used for a
 * request under test, since it bypasses RLS and would make everything pass for the
 * wrong reason.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WS = 'a4000000-0000-4000-8000-00000000dd01'
const WS2 = 'a4000000-0000-4000-8000-00000000dd02'

const ACCOUNTS = {
  chief: { email: 'tl11-session-chief@example.org', password: 'tl11-Throwaway-Password-1!', role: 'chief_admin' },
  admin: { email: 'tl11-session-admin@example.org', password: 'tl11-Throwaway-Password-2!', role: 'admin' },
  evaluator: { email: 'tl11-session-evaluator@example.org', password: 'tl11-Throwaway-Password-3!', role: 'evaluator' },
}

/** Invited during the run and signed up for real. Never pre-created. */
const INVITEE = { email: 'tl11-session-invitee@example.org', password: 'tl11-Throwaway-Password-4!' }
/** Invited, then withdrawn, then attempts to sign up. Must be refused. */
const WITHDRAWN = { email: 'tl11-session-withdrawn@example.org', password: 'tl11-Throwaway-Password-5!' }

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
  console.log(`${verdict} ${expect.padEnd(9)} | ${label.slice(0, 62).padEnd(62)} | ${outcome}`)
}

async function teardown(serviceKey) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  const stragglers = []
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl11-session-')) continue
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
    if (!res.ok) stragglers.push(`${u.email} -> ${res.status}`)
  }
  if (stragglers.length > 0) {
    console.warn(`[teardown] admin API refused ${stragglers.length} delete(s): ${stragglers.join(', ')}`)
  }
  await sql(`
    delete from membership_change_log where workshop_id in ('${WS}', '${WS2}');
    delete from workshop_invitation where workshop_id in ('${WS}', '${WS2}');
    delete from workshop_invitation where email like 'tl11-session-%';
    delete from workshop_member where workshop_id in ('${WS}', '${WS2}');
    delete from app_user where email like 'tl11-session-%';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl11-session-%';
    delete from role_allowlist where email like 'tl11-session-%';
    delete from workshop where id in ('${WS}', '${WS2}');
    delete from auth.identities where identity_data->>'email' like 'tl11-session-%';
    delete from auth.users where email like 'tl11-session-%';
    select 1;`)
}

async function provision(serviceKey) {
  await teardown(serviceKey)
  await sql(`
    insert into workshop (id, name, start_date, location) values
      ('${WS}',  'TL11 Session Fixture Workshop', '2027-09-01', 'Nowhere'),
      ('${WS2}', 'TL11 Session Second Workshop',  '2027-10-01', 'Elsewhere');
    select 1;`)

  for (const a of Object.values(ACCOUNTS)) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${a.email}', array['${a.role}'], '${a.role}', 'tl-11 session test', '${WS}')
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
        user_metadata: { name: `TL11 ${a.role}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${a.email} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }

  // The chief admin also runs the second workshop, for the two-invitations claim.
  await sql(`
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS2}', id, 'chief_admin' from app_user where email = '${ACCOUNTS.chief.email}'
    on conflict (workshop_id, app_user_id) do update set role = excluded.role;
    select 1;`)
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
 * Create an account exactly as SignIn's `signUp` does: anon key, no privileges.
 *
 * Used here only for the attempts that must be REFUSED, and the reason is a real
 * constraint rather than a shortcut. A successful signup on this project sends a
 * confirmation email, and the hosted free tier caps that at a couple an hour: the
 * first version of this harness put the accepted path through here and got
 * `429 over_email_send_rate_limit`, and before that a transient
 * `400 email_address_invalid`, neither of which says anything about tl-11. A
 * refusal sends no email, so it is not rate-limited and is stable.
 *
 * That limit is not only a testing problem — see the review record. A cohort
 * signing up the same evening will meet it, which is why SignIn now names it.
 */
async function signUp(a) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password, data: { name: 'TL11 Invitee' } }),
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, body, text }
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
    ? `${res.status} ${text.slice(0, 90)}`
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

const assert = (label, condition, detail) =>
  record(condition ? 'PASS' : 'FAIL', 'state', label, detail)

async function runChecks(serviceKey) {
  const chief = await signIn(ACCOUNTS.chief)
  const admin = await signIn(ACCOUNTS.admin)
  const evaluator = await signIn(ACCOUNTS.evaluator)
  record('PASS', 'setup', 'three temporary accounts sign in over real HTTP', 'three access tokens issued')

  // --- the RPCs are reachable, and the invite returns the shape the client reads
  const invited = await rpc('permitted', 'chief admin invites an evaluator', chief,
    'invite_to_workshop', { _workshop_id: WS, _email: INVITEE.email, _role: 'evaluator' })
  assert('the response carries the outcome and the invitation id the client reads',
    invited.body?.outcome === 'invited' && Boolean(invited.body?.invitation_id),
    JSON.stringify(invited.body))

  await rpc('permitted', 'and into the second workshop as well', chief,
    'invite_to_workshop', { _workshop_id: WS2, _email: INVITEE.email, _role: 'evaluator' })

  await rpc('permitted', 'an admin invites an evaluator', admin,
    'invite_to_workshop', { _workshop_id: WS, _email: WITHDRAWN.email, _role: 'evaluator' })

  // --- refusals, and whether the slug survives the trip -----------------------
  const refused = await rpc('blocked', 'an admin cannot invite another admin', admin,
    'invite_to_workshop', { _workshop_id: WS, _email: 'tl11-session-nope@example.org', _role: 'admin' })
  assert('a tl-02 refusal still arrives with its 42501 and its slug',
    refused.body?.code === '42501' && refused.body?.details === 'tl02.admin_may_only_grant_evaluator',
    `code=${refused.body?.code} details=${refused.body?.details}`)

  // The check that the widened slug matcher exists for a reason. Before tl-11,
  // `toResult` matched `tl02.` exactly, so this refusal would have reached the UI
  // with slug=null and rendered Postgres prose — with nothing failing anywhere.
  const dup = await rpc('blocked', 'the same address cannot be invited twice', chief,
    'invite_to_workshop', { _workshop_id: WS, _email: INVITEE.email, _role: 'evaluator' })
  assert('and a tl-11 refusal arrives with a tl11.* slug in details',
    dup.body?.details === 'tl11.already_invited',
    `details=${dup.body?.details}`)

  await rpc('blocked', 'an evaluator cannot invite anybody', evaluator,
    'invite_to_workshop', { _workshop_id: WS, _email: 'tl11-session-nope2@example.org', _role: 'evaluator' })

  // --- who may read the table ------------------------------------------------
  await get('permitted', 'a chief admin reads the workshop\'s invitations', chief,
    `workshop_invitation?workshop_id=eq.${WS}&select=id,email,role,status`)
  await get('permitted', 'an admin reads them too', admin,
    `workshop_invitation?workshop_id=eq.${WS}&select=id,email,role,status`)
  await get('blocked', 'an evaluator in the same workshop reads none', evaluator,
    `workshop_invitation?workshop_id=eq.${WS}&select=id,email,role,status`)
  await get('blocked', 'an anonymous session reads none', null,
    `workshop_invitation?workshop_id=eq.${WS}&select=id,email,role,status`)

  // A browser cannot write this table at all: the grants are revoked, not merely
  // left un-policied.
  const direct = await fetch(`${SUPABASE_URL}/rest/v1/workshop_invitation`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${chief}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ workshop_id: WS, email: 'tl11-session-direct@example.org', role: 'admin' }),
  })
  record(direct.status >= 400 ? 'PASS' : 'FAIL', 'blocked',
    'a chief admin cannot insert an invitation directly', `${direct.status}`)

  // --- acceptance through the real auth service ------------------------------
  //
  // The admin endpoint rather than the public one, because the public one sends a
  // confirmation email and the project's quota makes that flaky (see signUp's
  // note). Both go through GoTrue and both fire `handle_new_user`, so this proves
  // the acceptance path; what it does NOT prove is that a given person's signup
  // email will get out today, which is a platform quota and not this code.
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: INVITEE.email,
      password: INVITEE.password,
      email_confirm: true,
      user_metadata: { name: 'TL11 Invitee' },
    }),
  })
  record(created.status < 400 ? 'PASS' : 'FAIL', 'permitted',
    'the invited address creates an account, and the trigger runs',
    `${created.status} ${(await created.text()).slice(0, 80)}`)

  const memberships = await sql(`
    select w.id from workshop_member wm
      join app_user u on u.id = wm.app_user_id
      join workshop w on w.id = wm.workshop_id
     where u.email = '${INVITEE.email}' and w.id in ('${WS}', '${WS2}');`)
  assert('and lands in BOTH workshops it was invited to', memberships.length === 2,
    `${memberships.length} membership(s)`)

  const accepted = await sql(`
    select count(*)::int as n from workshop_invitation
     where email = '${INVITEE.email}' and status = 'accepted';`)
  assert('with both invitations marked accepted', accepted[0]?.n === 2, `${accepted[0]?.n} accepted`)

  // --- revocation, and whether it actually closes the door -------------------
  const pending = await sql(`
    select id from workshop_invitation where email = '${WITHDRAWN.email}' and status = 'pending';`)
  await rpc('permitted', 'the admin withdraws the invitation they issued', admin,
    'revoke_invitation', { _id: pending[0]?.id })

  const refusedSignup = await signUp(WITHDRAWN)
  record(refusedSignup.status >= 400 ? 'PASS' : 'FAIL', 'blocked',
    'a withdrawn invitation no longer lets that address create an account',
    `${refusedSignup.status} ${(refusedSignup.text ?? '').slice(0, 120)}`)

  // The check that cannot be made anywhere else, and the one that found a real bug.
  //
  // SignIn replaces the server's error with a readable sentence only when it
  // recognizes it, and what reaches the browser is the auth service's WRAPPING of
  // the trigger's exception, not the exception. The first version of this harness
  // matched the trigger's own words and failed here, which is how we learned that
  // `src/lib/signupErrors.ts` would never have fired once in production.
  //
  // The pattern below is deliberately the same one that module uses, and
  // test/peopleDirectory.test.ts pins that module against these exact strings. This
  // side records what the wire says; that side records what the app does with it.
  const wire = `${refusedSignup.body?.msg ?? ''} ${refusedSignup.body?.message ?? ''} ${refusedSignup.body?.error_description ?? ''} ${refusedSignup.text ?? ''}`
  assert("and src/lib/signupErrors.ts classifies what actually arrives as invite-only",
    /database error saving new user|unexpected_failure|not been invited|not authorized to sign up/i.test(wire),
    wire.slice(0, 130).replace(/\s+/g, ' '))

  const orphan = await sql(`select count(*)::int as n from app_user where email = '${WITHDRAWN.email}';`)
  assert('and no orphan app_user row was left behind', orphan[0]?.n === 0, `${orphan[0]?.n} row(s)`)

  // --- re-dating -------------------------------------------------------------
  await sql(`
    insert into workshop_invitation (workshop_id, email, role, invited_at)
    values ('${WS}', 'tl11-session-resend@example.org', 'evaluator', now() - interval '14 days');
    select 1;`)
  const resendable = await sql(`
    select id from workshop_invitation where email = 'tl11-session-resend@example.org';`)
  await rpc('permitted', 'a pending invitation can be re-dated', chief,
    'resend_invitation', { _id: resendable[0]?.id })
  const redated = await sql(`
    select (invited_at > now() - interval '1 hour') as fresh
      from workshop_invitation where id = '${resendable[0]?.id}';`)
  assert('and its date actually moved', redated[0]?.fresh === true, `fresh=${redated[0]?.fresh}`)
}

async function main() {
  const serviceKey = await serviceRoleKey()
  if (process.argv.includes('--teardown')) {
    await teardown(serviceKey)
    console.log('tl-11 session fixtures removed.')
    return
  }
  await provision(serviceKey)
  try {
    await runChecks(serviceKey)
  } finally {
    await teardown(serviceKey)
  }
  const failed = results.filter((r) => r.verdict === 'FAIL')
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
