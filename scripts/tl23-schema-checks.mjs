/**
 * tl-23 schema acceptance, against the LIVE project.
 *
 * SQL is tested where SQL runs: the ceiling arithmetic, the function grants, and
 * set_platform_setting's new key all live in Postgres, so a vitest assertion about
 * them would be a claim about a file rather than about the database the app uses.
 *
 * What it proves, in order:
 *   1. The two cache columns exist and are nullable.
 *   2. ai_spend_permitted is executable by service_role and by NOBODY else.
 *   3. With hosted AI off (this deployment's real state) it refuses with the slug.
 *   4. The ceiling refuses AT the boundary and permits below it, measured against
 *      fixture rows summing to exact values.
 *   5. Client-side hosted-api rows with null token counts add nothing to the sum —
 *      the no-double-count design, pinned where it matters.
 *   6. set_platform_setting accepts the new key from a platform owner, refuses it
 *      from a plain member, refuses a non-number and a non-positive number, and
 *      still enforces tl-13's boolean invariant on hosted_ai_enabled.
 *
 * Fixture-scoped throughout (workshop a6000000-...-ff23, emails tl23-sc-*); every
 * mutation happens inside a transaction that is rolled back, or is deleted in
 * teardown, so the deployment's real settings are never left changed.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WS = 'a6000000-0000-4000-8000-00000000ff23'

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text.slice(0, 500))
  return text ? JSON.parse(text) : null
}

/** Run a batch expected to raise; returns the error text ('' when it succeeded). */
async function sqlError(query) {
  try {
    await sql(query)
    return ''
  } catch (err) {
    return err.message
  }
}

const results = []
const assert = (label, condition, detail = '') => {
  results.push(condition)
  console.log(`${condition ? 'PASS' : 'FAIL'} | ${label.padEnd(72)} | ${String(detail).slice(0, 80)}`)
}

// --- 1. the columns -------------------------------------------------------
const cols = await sql(`
  select column_name, is_nullable, data_type from information_schema.columns
  where table_name = 'ai_call_log' and column_name in ('cache_read_tokens', 'cache_write_tokens')
  order by column_name;`)
assert('cache_read_tokens exists, nullable integer',
  cols.some((c) => c.column_name === 'cache_read_tokens' && c.is_nullable === 'YES' && c.data_type === 'integer'))
assert('cache_write_tokens exists, nullable integer',
  cols.some((c) => c.column_name === 'cache_write_tokens' && c.is_nullable === 'YES' && c.data_type === 'integer'))

// --- 2. who may execute the spend check ------------------------------------
const grants = (await sql(`
  select grantee, has_function_privilege(grantee, 'ai_spend_permitted(uuid)', 'execute') as may
  from (values ('service_role'), ('authenticated'), ('anon')) as g(grantee);`))
  .reduce((m, r) => ({ ...m, [r.grantee]: r.may }), {})
assert('service_role may execute ai_spend_permitted', grants.service_role === true)
assert('authenticated may NOT execute it', grants.authenticated === false)
assert('anon may NOT execute it', grants.anon === false)

// --- 3. hosted AI off refuses with the slug --------------------------------
const hosted = await sql(`select value from platform_setting where key = 'hosted_ai_enabled';`)
const hostedWasOn = hosted?.[0]?.value === true
const offAnswer = await sql(`
  begin;
  update platform_setting set value = to_jsonb(false) where key = 'hosted_ai_enabled';
  select ai_spend_permitted('${WS}') as slug;
  rollback;`)
assert("hosted AI off → 'tl23.hosted_ai_disabled_on_this_deployment'",
  offAnswer?.[0]?.slug === 'tl23.hosted_ai_disabled_on_this_deployment',
  `deployment's live value untouched (currently ${hostedWasOn ? 'on' : 'off'})`)

// --- 4 & 5. the ceiling boundary, with fixture rows, all rolled back --------
const boundary = await sql(`
  begin;
  update platform_setting set value = to_jsonb(true) where key = 'hosted_ai_enabled';
  update platform_setting set value = to_jsonb(1000) where key = 'ai_daily_token_ceiling';
  insert into workshop (id, name) values ('${WS}', 'tl23-sc fixture') on conflict (id) do nothing;
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', 400, 99, 300, 200);
  -- 999 of 1000 spent, all four columns represented: still permitted.
  select ai_spend_permitted('${WS}') as below;
  -- A client-side trace row: hosted-api mode, NULL token counts. Must add zero.
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in, tokens_out)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', null, null);
  select ai_spend_permitted('${WS}') as still_below;
  -- One more token reaches the boundary exactly: refused AT it, not past it.
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', 1);
  select ai_spend_permitted('${WS}') as at_boundary;
  rollback;`)
// The management API returns the rows of the LAST select per statement batch; run
// the three selects separately if this shape ever changes. Today it returns the
// final select's rows, so re-run the batch in three stages for explicit answers:
const below = await sql(`
  begin;
  update platform_setting set value = to_jsonb(true) where key = 'hosted_ai_enabled';
  update platform_setting set value = to_jsonb(1000) where key = 'ai_daily_token_ceiling';
  insert into workshop (id, name) values ('${WS}', 'tl23-sc fixture') on conflict (id) do nothing;
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', 400, 99, 300, 200);
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in, tokens_out)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', null, null);
  select ai_spend_permitted('${WS}') as slug;
  rollback;`)
assert('999 of 1000 spent (all four columns counted, nulls as zero) → permitted',
  below?.[0]?.slug === null, JSON.stringify(below?.[0]))
assert("exactly 1000 of 1000 → 'tl23.daily_token_ceiling_reached' (refuses AT the boundary)",
  boundary?.[0]?.at_boundary === 'tl23.daily_token_ceiling_reached', JSON.stringify(boundary?.[0]))

// --- 5b. forged rows cannot open or bypass the ceiling ----------------------
const negRefused = await sqlError(`
  begin;
  insert into workshop (id, name) values ('${WS}', 'tl23-sc fixture') on conflict (id) do nothing;
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in)
  values ('${WS}', 'observation_routing', 'hosted-api', 'result', -5);
  rollback;`)
assert('a negative token count is refused at the table (check constraint)',
  /ai_call_log_tokens_nonnegative|check constraint/i.test(negRefused), negRefused.slice(0, 60))

const clampHolds = await sql(`
  begin;
  alter table ai_call_log drop constraint ai_call_log_tokens_nonnegative;
  update platform_setting set value = to_jsonb(true) where key = 'hosted_ai_enabled';
  update platform_setting set value = to_jsonb(10) where key = 'ai_daily_token_ceiling';
  insert into workshop (id, name) values ('${WS}', 'tl23-sc fixture') on conflict (id) do nothing;
  insert into ai_call_log (workshop_id, fn, mode, outcome, tokens_in) values
    ('${WS}', 'observation_routing', 'hosted-api', 'result', -1000000000),
    ('${WS}', 'observation_routing', 'hosted-api', 'result', 10);
  select ai_spend_permitted('${WS}') as slug;
  rollback;`)
assert('even without the constraint, the sum clamps negatives (ceiling stays shut)',
  clampHolds?.[0]?.slug === 'tl23.daily_token_ceiling_reached', JSON.stringify(clampHolds?.[0]))

// --- 6. set_platform_setting and the new key --------------------------------
// Fixture identities: a platform owner and a plain member, minted as app_user rows
// with throwaway auth ids, addressed via request.jwt.claims exactly as PostgREST
// would present them. Rolled back.
const OWNER = '00000000-0000-4000-8000-0000tl230001'.replace('tl23', 'ff23')
const MEMBER = '00000000-0000-4000-8000-0000tl230002'.replace('tl23', 'ff23')
const asUser = (authId, statement) => `
  begin;
  insert into role_allowlist (email, allowed_roles, assigned_role, platform_owner) values
    ('tl23-sc-owner@example.org', array['evaluator'], 'evaluator', true),
    ('tl23-sc-member@example.org', array['evaluator'], 'evaluator', false);
  insert into auth.users (id, email) values
    ('${OWNER}', 'tl23-sc-owner@example.org'),
    ('${MEMBER}', 'tl23-sc-member@example.org');
  -- the admission trigger minted app_user rows on the auth.users insert;
  -- promote the fixture owner (platform_owner on role_allowlist covers admission,
  -- but the app_user tier is what is_platform_owner() reads).
  update app_user set role = 'platform_owner' where auth_user_id = '${OWNER}';
  update app_user set role = 'member' where auth_user_id = '${MEMBER}';
  select set_config('request.jwt.claims', '{"sub":"${authId}","role":"authenticated"}', true);
  ${statement};
  rollback;`

const ownerOk = await sqlError(asUser(OWNER, `select set_platform_setting('ai_daily_token_ceiling', to_jsonb(5000000))`))
assert('a platform owner may set the ceiling', ownerOk === '', ownerOk)

const memberNo = await sqlError(asUser(MEMBER, `select set_platform_setting('ai_daily_token_ceiling', to_jsonb(5000000))`))
assert('a plain member is refused (tl11.platform_owner_only)', /platform_owner_only|deployment''?s owner/i.test(memberNo), memberNo.slice(0, 60))

const notNumber = await sqlError(asUser(OWNER, `select set_platform_setting('ai_daily_token_ceiling', to_jsonb('lots'::text))`))
assert('a non-number ceiling is refused', /ceiling_needs_a_positive_number|positive number/i.test(notNumber), notNumber.slice(0, 60))

const zero = await sqlError(asUser(OWNER, `select set_platform_setting('ai_daily_token_ceiling', to_jsonb(0))`))
assert('a zero ceiling is refused', /ceiling_needs_a_positive_number|positive number/i.test(zero), zero.slice(0, 60))

const boolStillHeld = await sqlError(asUser(OWNER, `select set_platform_setting('hosted_ai_enabled', to_jsonb(1))`))
assert("tl-13's boolean invariant on hosted_ai_enabled still fires", /hosted_ai_needs_a_boolean|on or off/i.test(boolStillHeld), boolStillHeld.slice(0, 60))

const unknownKey = await sqlError(asUser(OWNER, `select set_platform_setting('made_up_setting', to_jsonb(true))`))
assert("tl-11's unknown-key refusal still fires", /unknown_setting|not a setting/i.test(unknownKey), unknownKey.slice(0, 60))

// --- verdict ----------------------------------------------------------------
const failed = results.filter((r) => !r).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} FAILED`)
process.exit(failed === 0 ? 0 : 1)
