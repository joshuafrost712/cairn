/**
 * tl-14: prove the assumptions column and its validation are real on the LIVE database.
 *
 *   node scripts/tl14-schema-checks.mjs
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS. `test/estimate.test.ts` reads the
 * migration file and checks that the SQL says the right things. That catches drift
 * between the TypeScript and the SQL, and it cannot catch the failure that actually
 * cost tl-13 a live regression: a migration whose text is right and whose EFFECT on
 * the deployed database is not. `create table if not exists` skipping a CREATE while
 * running the GRANTs beside it is invisible to any check that reads the file. So this
 * asks Postgres.
 *
 * Runs as `postgres` through the Management API, which means it tests the TRIGGER
 * rather than the RLS policies. That is the right target: the trigger is the object
 * this migration changed, and it is the guard that has no way around it — including
 * the service-role paths the Edge Functions use.
 *
 * Nothing is left behind. The write attempts happen inside a DO block that ends by
 * raising, so the transaction is discarded whether the checks pass or fail; a passing
 * run reports itself through the raised message, which is why "error: ALL_CHECKS_PASSED"
 * is the success case rather than a contradiction.
 */
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function run(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: res.ok, body }
}

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

// ---------------------------------------------------------------------------
// 1. The column exists, with the shape the migration declared.
// ---------------------------------------------------------------------------
{
  const { body } = await run(`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_name = 'ai_config' and column_name = 'assumptions'
  `)
  const row = Array.isArray(body) ? body[0] : null
  check('assumptions column exists', Boolean(row), JSON.stringify(row ?? body))
  if (row) {
    check('it is jsonb', row.data_type === 'jsonb', row.data_type)
    check('it is not null', row.is_nullable === 'NO', row.is_nullable)
    // The default is what keeps every existing workshop's behaviour unchanged: a row
    // written before this migration reads as "no overrides", not as null.
    check(
      "it defaults to an empty object",
      String(row.column_default ?? '').includes("'{}'::jsonb"),
      String(row.column_default),
    )
  }
}

// ---------------------------------------------------------------------------
// 2. tl-13's grants on ai_config are UNCHANGED.
//
// The single most important check in this file. This migration must add a column and
// touch nothing else; if it has widened or narrowed who may write ai_config, that is
// exactly the tl-13/platform_setting failure repeating with the roles reversed.
// ---------------------------------------------------------------------------
{
  const { body } = await run(`
    select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where table_name = 'ai_config' and grantee in ('anon', 'authenticated')
    group by grantee order by grantee
  `)
  const rows = Array.isArray(body) ? body : []
  const authenticated = rows.find((r) => r.grantee === 'authenticated')
  const anon = rows.find((r) => r.grantee === 'anon')
  check(
    'authenticated still holds exactly select, insert, update',
    authenticated?.privs === 'INSERT,SELECT,UPDATE',
    authenticated?.privs ?? 'none',
  )
  check('authenticated still cannot delete', !String(authenticated?.privs ?? '').includes('DELETE'))
  check('anon still holds nothing', anon === undefined, anon?.privs ?? 'none')
}

// ---------------------------------------------------------------------------
// 3. The validator's verdicts, as a pure function. No writes.
// ---------------------------------------------------------------------------
{
  const { body } = await run(`
    select
      ai_assumptions_are_legal('{}'::jsonb)                              as empty_ok,
      ai_assumptions_are_legal(null)                                     as null_ok,
      ai_assumptions_are_legal('{"captureChars": 2400}'::jsonb)          as good_ok,
      ai_assumptions_are_legal('{"captureChars": 0}'::jsonb)             as zero_ok,
      ai_assumptions_are_legal('{"nope": 1}'::jsonb)                     as unknown_key,
      ai_assumptions_are_legal('{"captureChars": "2400"}'::jsonb)        as not_a_number,
      ai_assumptions_are_legal('{"captureChars": -5}'::jsonb)            as negative,
      ai_assumptions_are_legal('[1,2]'::jsonb)                           as not_an_object
  `)
  const r = Array.isArray(body) ? body[0] : {}
  check('an empty map is legal', r.empty_ok === null, String(r.empty_ok))
  check('null is legal', r.null_ok === null, String(r.null_ok))
  check('a known numeric override is legal', r.good_ok === null, String(r.good_ok))
  // Zero is a real assumption (nobody expects discrepancy notes), so it must pass.
  check('zero is legal, not treated as absent', r.zero_ok === null, String(r.zero_ok))
  check('an unknown key is refused', r.unknown_key === 'tl14.unknown_assumption', String(r.unknown_key))
  check(
    'a string value is refused',
    r.not_a_number === 'tl14.assumption_must_be_a_number',
    String(r.not_a_number),
  )
  check(
    'a negative value is refused',
    r.negative === 'tl14.assumption_must_not_be_negative',
    String(r.negative),
  )
  check(
    'an array is refused',
    r.not_an_object === 'tl14.assumptions_must_be_an_object',
    String(r.not_an_object),
  )
}

// ---------------------------------------------------------------------------
// 4. The TRIGGER enforces it on a real write, and tl-13's own check still fires.
//
// A validator nothing calls is decoration. This attempts four writes against a real
// workshop and requires the first three to be refused and the fourth to be accepted,
// then aborts so none of them persist.
// ---------------------------------------------------------------------------
{
  const { ok, body } = await run(`
    do $$
    declare
      _w uuid;
      _got text;
    begin
      select id into _w from workshop order by created_at limit 1;
      if _w is null then
        raise exception 'NO_WORKSHOP_TO_TEST_AGAINST';
      end if;

      -- (a) a negative assumption
      _got := 'accepted';
      begin
        insert into ai_config (workshop_id, mode, assumptions)
        values (_w, 'github-claude', '{"captureChars": -5}'::jsonb)
        on conflict (workshop_id) do update set assumptions = excluded.assumptions;
      exception when check_violation then _got := 'refused';
      end;
      if _got <> 'refused' then raise exception 'FAIL: negative assumption was accepted'; end if;

      -- (b) an unknown assumption key
      _got := 'accepted';
      begin
        insert into ai_config (workshop_id, mode, assumptions)
        values (_w, 'github-claude', '{"somethingNewer": 1}'::jsonb)
        on conflict (workshop_id) do update set assumptions = excluded.assumptions;
      exception when check_violation then _got := 'refused';
      end;
      if _got <> 'refused' then raise exception 'FAIL: unknown assumption was accepted'; end if;

      -- (c) tl-13's invariant, which this migration re-declared the trigger to keep.
      --     If re-declaring dropped it, an unknown FUNCTION would now be accepted.
      _got := 'accepted';
      begin
        insert into ai_config (workshop_id, mode, functions)
        values (_w, 'github-claude', '{"not_a_function": {"enabled": true}}'::jsonb)
        on conflict (workshop_id) do update set functions = excluded.functions;
      exception when check_violation then _got := 'refused';
      end;
      if _got <> 'refused' then raise exception 'FAIL: tl-13 function check no longer fires'; end if;

      -- (c2) tl-13's OTHER invariant: hosted-api is refused unless the deployment
      --      permits it. Checked live because re-declaring a trigger function is
      --      exactly how an invariant gets dropped without any test noticing, and a
      --      regex over the migration file proves only that the words are present.
      --      This deployment keeps hosted_ai_enabled false, which is what makes the
      --      refusal the expected outcome here.
      _got := 'accepted';
      begin
        insert into ai_config (workshop_id, mode)
        values (_w, 'hosted-api')
        on conflict (workshop_id) do update set mode = excluded.mode;
      exception when check_violation then _got := 'refused';
      end;
      if _got <> 'refused' then
        raise exception 'FAIL: tl-13 hosted-api deployment check no longer fires';
      end if;

      -- (d) a legal override is accepted, so the guard is not simply refusing everything.
      insert into ai_config (workshop_id, mode, assumptions)
      values (_w, 'github-claude', '{"captureChars": 2400, "discrepancyNotes": 0}'::jsonb)
      on conflict (workshop_id) do update set assumptions = excluded.assumptions;

      -- Abort, so nothing above is kept. The message IS the pass signal.
      raise exception 'ALL_CHECKS_PASSED';
    end $$;
  `)
  const msg = JSON.stringify(body)
  const passed = !ok && msg.includes('ALL_CHECKS_PASSED')
  check(
    'the trigger refuses bad assumptions, keeps both tl-13 invariants, and accepts good input',
    passed,
    passed ? '' : msg,
  )
  check('nothing was persisted (the block aborted)', !ok || msg.includes('ALL_CHECKS_PASSED'))
}

// ---------------------------------------------------------------------------
// 5. No workshop's stored configuration was disturbed by the migration.
// ---------------------------------------------------------------------------
{
  const { body } = await run(`
    select count(*) as rows,
           count(*) filter (where assumptions is null) as null_assumptions,
           count(*) filter (where assumptions <> '{}'::jsonb) as with_overrides
    from ai_config
  `)
  const r = Array.isArray(body) ? body[0] : {}
  check('no ai_config row has a null assumptions value', Number(r.null_assumptions) === 0, JSON.stringify(r))
  console.log(`  info  ai_config rows: ${r.rows}, with overrides: ${r.with_overrides}`)
}

console.log(failures === 0 ? '\ntl-14 schema checks: all passed' : `\ntl-14 schema checks: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
