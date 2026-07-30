-- tl-18 acceptance harness: the sync-health page reads three tables at once, and
-- a page whose numbers come from a denied read is worse than no page at all.
--
-- This spec adds no table and no policy. What it adds is a surface that
-- AGGREGATES `evaluation`, `observation` and `verification_verdict` for a whole
-- workshop and presents the counts as the truth about who is stuck. That makes
-- one existing property load-bearing in a new way: under RLS a denied read comes
-- back as zero rows, not as an error (see the vault note "RLS denial is silent
-- filtering"). A non-member opening this page must not see a tidy set of zeroes
-- that reads like "everybody's work is counting".
--
-- So each check DECLARES blocked or permitted, and the state assertions at the
-- end prove the fixture rows genuinely exist — otherwise every "blocked" verdict
-- would pass for free against an empty table.
--
-- Run against the linked project as `postgres`, then run the teardown:
--
--   node scripts/apply-migration.mjs scripts/tl18-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl18-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness (same shape as tl01/tl03/tl04, kept per-spec so a teardown of one
-- cannot pull the harness out from under another).
-- ---------------------------------------------------------------------------

drop table if exists tl18_results;
create table tl18_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl18_try(text, text, uuid, text);
create or replace function tl18_try(_expect text, _label text, _uid uuid, _sql text)
returns void
language plpgsql
as $$
declare
  _count   bigint;
  _outcome text;
  _errored boolean := false;
  _verdict text;
begin
  if _uid is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
                       json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  end if;

  begin
    execute _sql;
    get diagnostics _count = row_count;
    _outcome := format('no error, %s row(s)', _count);
  exception when others then
    _errored := true;
    _count := 0;
    _outcome := format('error [%s] %s', sqlstate, sqlerrm);
  end;
  reset role;

  if _expect = 'blocked' then
    _verdict := case when _errored or _count = 0 then 'PASS' else 'FAIL' end;
  else
    _verdict := case when not _errored and _count > 0 then 'PASS' else 'FAIL' end;
  end if;

  insert into tl18_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl18_assert(text, boolean, text);
create or replace function tl18_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl18_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   M (member)    tl18-m@example.org   evaluator in the pilot workshop
--   O (outsider)  tl18-o@example.org   evaluator in a second workshop only
--
-- One evaluation, one observation and one verdict in the pilot workshop, all
-- attributed to somebody OTHER than M — the page's whole job is showing an
-- administrator other people's stuck work, so a check that only reads your own
-- rows would measure nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _other uuid := '66666666-6666-6666-6666-666666666666';
  _m     uuid := '5d000000-0000-4000-8000-000000000001';
  _o     uuid := '5e000000-0000-4000-8000-000000000002';
  _part  uuid;
  _act   uuid;
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from verification_verdict where id like 'tl18-%';
  delete from observation where id like 'tl18-%';
  delete from evaluation where client_id like 'tl18-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl18-%@example.org';
  delete from app_user where email like 'tl18-%@example.org';
  delete from auth.users where id in (_m, _o);
  delete from role_allowlist where email like 'tl18-%@example.org';
  delete from workshop where id = _other;

  insert into workshop (id, name, start_date, location)
  values (_other, 'TL18 Fixture Workshop (outsider''s)', '2027-03-01', 'Nowhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl18-m@example.org', array['evaluator'], 'evaluator', 'tl-18 test fixture', _pilot),
    ('tl18-o@example.org', array['evaluator'], 'evaluator', 'tl-18 test fixture', _other);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_m, 'tl18-m@example.org', 'TL18 Member'),
    (_o, 'tl18-o@example.org', 'TL18 Outsider')
  ) as v(id, email, name);

  select id into _part from participant where workshop_id = _pilot order by name limit 1;
  select id into _act  from activity   where workshop_id = _pilot order by sort_order limit 1;

  -- A submitted capture recorded by a third party, exactly the row the funnel is
  -- meant to stage.
  insert into evaluation (
    client_id, evaluator_email, activity_id, workshop_id, source_language,
    answers, quick_ratings, source_text, participant_scope, attestation,
    ruleset_version, edit_history
  ) values (
    'tl18-capture', 'tl18-third-party@example.org', _act, _pilot, 'en',
    '{}'::jsonb, '{}'::jsonb, 'tl-18 fixture capture text', '[]'::jsonb, true,
    'v1', '[]'::jsonb
  );

  insert into observation (
    id, capture_client_id, workshop_id, participant_id, participant_name,
    ksa_code, text, source_excerpt, evidence_designation,
    sentiment_flag, confidence, needs_review, origin, evaluator_email
  ) values (
    'tl18-obs::0', 'tl18-capture', _pilot, _part::text, 'TL18 Fixture Subject',
    'K1.1', 'fixture observation', 'fixture excerpt', 2,
    'neutral', 'high', false, 'individual', 'tl18-third-party@example.org'
  );

  insert into verification_verdict (
    id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at
  ) values (
    'tl18-obs::0::tl18-third-party@example.org', 'tl18-obs::0', 'tl18-capture',
    _pilot, 'tl18-third-party@example.org', 'confirm', now()
  );

  perform tl18_assert(
    'fixtures provisioned two accounts through the real signup path',
    (select count(*) from app_user where email like 'tl18-%@example.org') = 2
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl18-%@example.org') = 2,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl18-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl18-%@example.org')));

  perform tl18_assert(
    'the three rows the funnel reads really exist, so a zero below is a denial',
    exists (select 1 from evaluation where client_id = 'tl18-capture')
      and exists (select 1 from observation where id = 'tl18-obs::0')
      and exists (select 1 from verification_verdict where id = 'tl18-obs::0::tl18-third-party@example.org'),
    'evaluation + observation + verdict present');
end $$;

-- ---------------------------------------------------------------------------
-- The reads the sync-health page performs, from three vantage points.
--
--   M  5d000000-0000-4000-8000-000000000001  evaluator, pilot workshop
--   O  5e000000-0000-4000-8000-000000000002  evaluator, other workshop
--   anon                                     signed out
-- ---------------------------------------------------------------------------

-- 1-3. An outsider gets nothing from any of the three tables. Not an error: zero
--      rows, which is precisely why the page must never render an outsider's
--      empty funnel as good news.
select tl18_try('blocked', 'an outsider reads the workshop''s evaluations',
  '5e000000-0000-4000-8000-000000000002',
  $q$select 1 from evaluation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl18_try('blocked', 'an outsider reads the workshop''s observations',
  '5e000000-0000-4000-8000-000000000002',
  $q$select 1 from observation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl18_try('blocked', 'an outsider reads the workshop''s verdicts',
  '5e000000-0000-4000-8000-000000000002',
  $q$select 1 from verification_verdict where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- 4. Signed out, the same read returns nothing.
select tl18_try('blocked', 'a signed-out browser reads the workshop''s observations',
  null,
  $q$select 1 from observation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- 5-7. A member does get the rows, including a third party's. This is the
--      permitted half, and without it the three checks above would pass on a
--      database that simply denies everything to everybody.
select tl18_try('permitted', 'a member reads a third party''s evaluation',
  '5d000000-0000-4000-8000-000000000001',
  $q$select 1 from evaluation where client_id = 'tl18-capture'$q$);

select tl18_try('permitted', 'a member reads a third party''s observation',
  '5d000000-0000-4000-8000-000000000001',
  $q$select 1 from observation where id = 'tl18-obs::0'$q$);

select tl18_try('permitted', 'a member reads a third party''s verdict',
  '5d000000-0000-4000-8000-000000000001',
  $q$select 1 from verification_verdict where id = 'tl18-obs::0::tl18-third-party@example.org'$q$);

-- 8. The gauge is read-only. An evaluator looking at stuck work must not be able
--    to make it un-stuck by editing the row that says so.
select tl18_try('blocked', 'a member rewrites a third party''s observation from the funnel''s data',
  '5d000000-0000-4000-8000-000000000001',
  $q$update observation set evidence_designation = 0 where id = 'tl18-obs::0'$q$);

-- ---------------------------------------------------------------------------
-- State: nothing an attempt above tried actually landed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl18_assert('the fixture observation''s designation was not lowered',
    (select evidence_designation from observation where id = 'tl18-obs::0') = 2,
    format('designation = %s', coalesce((select evidence_designation from observation
                                          where id = 'tl18-obs::0'), -1)));

  perform tl18_assert('the third party''s verdict is intact',
    (select decision from verification_verdict
      where id = 'tl18-obs::0::tl18-third-party@example.org') = 'confirm',
    coalesce((select decision from verification_verdict
               where id = 'tl18-obs::0::tl18-third-party@example.org'), 'GONE'));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl18_results
order by (verdict = 'PASS'), seq;
