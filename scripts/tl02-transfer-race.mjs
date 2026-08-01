/**
 * tl-02: two concurrent transfers of one workshop's chief admin role.
 *
 * The spec names this and the SQL harness cannot run it: scripts/tl02-rls-tests.sql
 * executes in one session, so "two callers at once" is exactly the case it cannot
 * reach. This fires two genuinely parallel requests at the database and checks the
 * only thing that matters afterward — that the workshop has exactly one chief
 * admin, whichever way the race fell.
 *
 * Two outcomes are both correct, and the script reports which one happened:
 *   * They overlap. Both read the same sitting chief admin, both demote, both
 *     promote, and the partial unique index raises 23505 on the loser.
 *   * They serialize. The first transfer succeeds and demotes the caller to admin,
 *     so the second finds a caller who is no longer the chief admin and refuses
 *     with 42501 tl02.only_chief_admin_transfers.
 *
 * What would be a FAILURE is two chief admins, or none.
 *
 *   node scripts/tl02-transfer-race.mjs
 *
 * Fixtures are prefixed tl02r- and torn down at the end, including on failure.
 */
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

const WS = 'a2000000-0000-4000-8000-00000000ee01'
const CA = 'a2000000-0000-4000-8000-00000000eec1'
const T1 = 'a2000000-0000-4000-8000-00000000ee11'
const T2 = 'a2000000-0000-4000-8000-00000000ee22'

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  return { ok: res.ok, body: text }
}

/** One transfer, as the sitting chief admin, with a deliberate stall so the two overlap. */
const transferAs = (uid, target) => `
  select set_config('role', 'authenticated', true);
  select set_config('request.jwt.claims',
    '{"sub":"${uid}","role":"authenticated"}', true);
  select pg_sleep(0.4);
  select transfer_chief_admin('${WS}', (select id from app_user where email = '${target}'));
`

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`)
}

async function teardown() {
  await sql(`
    delete from membership_change_log where workshop_id = '${WS}';
    delete from workshop_member where workshop_id = '${WS}';
    delete from app_user where email like 'tl02r-%@example.org';
    delete from auth.users where id in ('${CA}','${T1}','${T2}');
    delete from role_allowlist where email like 'tl02r-%@example.org';
    delete from workshop where id = '${WS}';
  `)
}

try {
  await teardown()
  const setup = await sql(`
    insert into workshop (id, name, start_date, location)
    values ('${WS}', 'TL02 Race Workshop', '2027-07-01', 'Nowhere');

    insert into role_allowlist (email, allowed_roles, assigned_role, note)
    values ('tl02r-ca@example.org', array['evaluator'], 'evaluator', 'tl-02 race fixture'),
           ('tl02r-t1@example.org', array['evaluator'], 'evaluator', 'tl-02 race fixture'),
           ('tl02r-t2@example.org', array['evaluator'], 'evaluator', 'tl-02 race fixture');

    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
    )
    select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           v.email, 'not-a-real-password-hash', now(), now(), now(),
           '{"provider":"email"}'::jsonb, json_build_object('name', v.email)::jsonb
    from (values
      ('${CA}'::uuid, 'tl02r-ca@example.org'),
      ('${T1}'::uuid, 'tl02r-t1@example.org'),
      ('${T2}'::uuid, 'tl02r-t2@example.org')
    ) as v(id, email);

    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS}', u.id,
           case u.email when 'tl02r-ca@example.org' then 'chief_admin' else 'admin' end
      from app_user u where u.email like 'tl02r-%@example.org';

    select (select count(*) from workshop_member where workshop_id = '${WS}') as members,
           (select count(*) from workshop_member where workshop_id = '${WS}' and role = 'chief_admin') as chiefs;
  `)
  check('fixtures: one chief admin and two admins', setup.ok && setup.body.includes('"members":3'), setup.body.trim())

  // The race. Same caller, two different targets, fired without awaiting between
  // them, each stalling 0.4s inside its own transaction so the transfers land
  // together rather than one after the other.
  const started = Date.now()
  const [a, b] = await Promise.all([
    sql(transferAs(CA, 'tl02r-t1@example.org')),
    sql(transferAs(CA, 'tl02r-t2@example.org')),
  ])
  const elapsed = Date.now() - started

  const winners = [a, b].filter((r) => r.ok).length
  const losers = [a, b].filter((r) => !r.ok)
  check('exactly one of the two calls succeeded', winners === 1,
    `${winners} succeeded, ${losers.length} refused`)

  const loserBody = losers.map((l) => l.body.replace(/\s+/g, ' ').slice(0, 200)).join(' || ')
  const raced = /23505|duplicate key/.test(loserBody)
  const serialized = /42501|only_chief_admin_transfers|chief admin/.test(loserBody)
  check('the loser was stopped by the index or by the matrix, not silently dropped',
    raced || serialized,
    raced ? 'overlapped: the unique index raised 23505' : `serialized: ${loserBody}`)

  const after = await sql(`
    select (select count(*) from workshop_member where workshop_id = '${WS}' and role = 'chief_admin') as chiefs,
           (select count(*) from workshop_member where workshop_id = '${WS}') as members,
           (select string_agg(u.email || '=' || m.role, ', ' order by u.email)
              from workshop_member m join app_user u on u.id = m.app_user_id
             where m.workshop_id = '${WS}') as roster;
  `)
  check('the workshop has exactly one chief admin afterward', after.body.includes('"chiefs":1'), after.body.trim())
  check('nobody was lost from the workshop', after.body.includes('"members":3'), after.body.trim())
  console.log(`\n(the two requests took ${elapsed}ms together, against a 0.4s stall each)`)
} finally {
  await teardown()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length} checks, ${results.length - failed} pass, ${failed} fail`)
process.exit(failed === 0 ? 0 : 1)
