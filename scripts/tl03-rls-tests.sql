-- tl-03 acceptance harness: what does the BACKEND say about the capture pull?
--
-- tl-03 adds no table and no policy. What it adds is a read the app never made
-- before — an administrator's device pulling every submitted capture in the
-- workshop, `source_text` and all — and a UI gate in front of the screen that
-- makes that read. So the question worth putting to Postgres is which of those two
-- is really doing the work.
--
-- The answer is recorded rather than assumed, including the uncomfortable half:
-- `evaluation_select` (tl-01) is "any member of this workshop", so an evaluator
-- with a console can read a colleague's capture text whether or not the routing
-- screen is reachable. That is not a regression tl-03 introduced and it is not
-- fixed here, but a spec that claimed "routing is admin-only" without saying so
-- would be claiming a boundary it does not have. The gate closes the *mechanism*,
-- not the capture text.
--
-- The check tl-03 genuinely depends on is the last one: hiding the routing UI is
-- only safe because an evaluator has no write path to `observation` at all
-- (tl-04). If that were ever relaxed, removing the UI would be cosmetic.
--
-- Same conventions as scripts/tl01-rls-tests.sql and tl04-rls-tests.sql: under RLS
-- a denied read and an empty table are indistinguishable, so every check DECLARES
-- whether it expects 'blocked' or 'permitted', and state assertions confirm that
-- nothing an attacker attempted actually landed.
--
--   node scripts/apply-migration.mjs scripts/tl03-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl03-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl03_results;
create table tl03_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl03_try(text, text, uuid, text);
create or replace function tl03_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl03_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl03_assert(text, boolean, text);
create or replace function tl03_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl03_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   E (evaluator)  tl03-e@example.org  evaluator in the pilot workshop
--   A (admin)      tl03-a@example.org  admin in the pilot workshop
--   O (outsider)   tl03-o@example.org  evaluator in a second workshop only
--
-- Plus one submitted capture belonging to nobody in this list, standing in for
-- the phone submission an administrator has to be able to route.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _other uuid := '33333333-3333-3333-3333-333333333333';
  _e     uuid := '3e000000-0000-4000-8000-000000000001';
  _a     uuid := '3a000000-0000-4000-8000-000000000002';
  _o     uuid := '30000000-0000-4000-8000-000000000003';
  _act   uuid;
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from observation where capture_client_id like 'tl03-%';
  delete from evaluation where client_id like 'tl03-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl03-%@example.org';
  delete from app_user where email like 'tl03-%@example.org';
  delete from auth.users where id in (_e, _a, _o);
  delete from role_allowlist where email like 'tl03-%@example.org';
  delete from workshop where id = _other;

  insert into workshop (id, name, start_date, location)
  values (_other, 'TL03 Fixture Workshop (outsider''s)', '2027-03-01', 'Nowhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl03-e@example.org', array['evaluator'], 'evaluator', 'tl-03 test fixture', _pilot),
    ('tl03-a@example.org', array['admin'],     'admin',     'tl-03 test fixture', _pilot),
    ('tl03-o@example.org', array['evaluator'], 'evaluator', 'tl-03 test fixture', _other);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_e, 'tl03-e@example.org', 'TL03 Evaluator'),
    (_a, 'tl03-a@example.org', 'TL03 Admin'),
    (_o, 'tl03-o@example.org', 'TL03 Outsider')
  ) as v(id, email, name);

  select id into _act from activity where workshop_id = _pilot order by sort_order limit 1;

  -- Two captures: one in the pilot workshop that the administrator must be able
  -- to pull, one in the outsider's workshop so the cross-workshop read has
  -- something real to fail to find. An empty table passes a bad check for free.
  insert into evaluation (
    client_id, evaluator_email, activity_id, workshop_id, source_language, answers,
    source_text, participant_scope, attestation, ruleset_version, edit_history
  ) values (
    'tl03-phone-capture', 'somebody-elses-phone@example.org', _act, _pilot, 'en', '{}'::jsonb,
    'Fixture capture text that only the workshop should be able to read.',
    '[]'::jsonb, true, 'v1', '[]'::jsonb
  ), (
    'tl03-other-capture', 'tl03-o@example.org', null, _other, 'en', '{}'::jsonb,
    'Fixture capture in the outsider''s own workshop.',
    '[]'::jsonb, true, 'v1', '[]'::jsonb
  );

  perform tl03_assert(
    'fixtures provisioned three accounts through the real signup path',
    (select count(*) from app_user where email like 'tl03-%@example.org') = 3
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl03-%@example.org') = 3,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl03-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl03-%@example.org')));
end $$;

-- ---------------------------------------------------------------------------
-- The checks.
--
--   E  3e000000-0000-4000-8000-000000000001  evaluator, pilot workshop
--   A  3a000000-0000-4000-8000-000000000002  admin,     pilot workshop
--   O  30000000-0000-4000-8000-000000000003  evaluator, other workshop
-- ---------------------------------------------------------------------------

-- 1. The read tl-03 depends on: an administrator can see a capture they did not
--    record, with its text, or there is nothing to route.
select tl03_try('permitted', 'A reads another device''s capture with its source_text',
  '3a000000-0000-4000-8000-000000000002',
  $q$select source_text from evaluation where client_id = 'tl03-phone-capture'$q$);

-- 2. The honest limit. Same read, as a plain evaluator: PERMITTED, because
--    evaluation_select is membership-wide. The routing gate hides the mechanism;
--    it does not make a colleague's capture text unreadable, and this spec should
--    not be read as claiming it does.
select tl03_try('permitted', 'E can also read it: the gate is UI-only, not RLS',
  '3e000000-0000-4000-8000-000000000001',
  $q$select source_text from evaluation where client_id = 'tl03-phone-capture'$q$);

-- 3. Cross-workshop, which IS enforced by the database.
select tl03_try('blocked', 'O cannot read the pilot workshop''s captures',
  '30000000-0000-4000-8000-000000000003',
  $q$select source_text from evaluation where client_id = 'tl03-phone-capture'$q$);

-- 4. And in the other direction, so the check is not passing by accident.
select tl03_try('blocked', 'E cannot read the other workshop''s captures',
  '3e000000-0000-4000-8000-000000000001',
  $q$select source_text from evaluation where client_id = 'tl03-other-capture'$q$);

-- 5. Unauthenticated.
select tl03_try('blocked', 'anon cannot read any capture', null,
  $q$select source_text from evaluation where client_id like 'tl03-%'$q$);

-- 6. The load-bearing one. Removing the routing UI is only safe because an
--    evaluator has no write path to observation (tl-04). If this ever passed as
--    'permitted', the whole gate would be cosmetic.
select tl03_try('blocked', 'E cannot write an observation, so hiding the UI is real',
  '3e000000-0000-4000-8000-000000000001',
  $q$insert into observation
       (id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
        text, source_excerpt, evidence_designation, sentiment_flag, confidence,
        needs_review, origin, evaluator_email)
     values ('tl03-forged-obs::0', 'tl03-phone-capture',
             '11111111-1111-1111-1111-111111111111', null, 'Forged Subject', 'K1.1',
             'forged by an evaluator', 'excerpt', 3, 'neutral', 'high', false,
             'individual', 'tl03-e@example.org')$q$);

-- 7. Regression: narrowing the UI must not have narrowed the capture path. An
--    evaluator still submits their own work.
select tl03_try('permitted', 'E can still submit their own capture',
  '3e000000-0000-4000-8000-000000000001',
  $q$insert into evaluation
       (client_id, evaluator_email, activity_id, workshop_id, source_language, answers,
        source_text, participant_scope, attestation, ruleset_version, edit_history)
     values ('tl03-own-capture', 'tl03-e@example.org', null,
             '11111111-1111-1111-1111-111111111111', 'en', '{}'::jsonb,
             'my own capture', '[]'::jsonb, true, 'v1', '[]'::jsonb)$q$);

-- 8. An administrator can write the observations they route.
select tl03_try('permitted', 'A can write the observations they routed',
  '3a000000-0000-4000-8000-000000000002',
  $q$insert into observation
       (id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
        text, source_excerpt, evidence_designation, sentiment_flag, confidence,
        needs_review, origin, evaluator_email)
     values ('tl03-admin-obs::0', 'tl03-phone-capture',
             '11111111-1111-1111-1111-111111111111', null, 'Fixture Subject', 'K1.1',
             'routed by the administrator', 'excerpt', 2, 'neutral', 'high', false,
             'individual', 'somebody-elses-phone@example.org')$q$);

-- ---------------------------------------------------------------------------
-- State assertions: what actually landed, which "0 rows" cannot show.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl03_assert('no observation was forged by an evaluator',
    not exists (select 1 from observation where id = 'tl03-forged-obs::0'),
    format('%s forged observation(s)',
           (select count(*) from observation where id = 'tl03-forged-obs::0')));

  perform tl03_assert('the administrator''s routed observation did land',
    exists (select 1 from observation where id = 'tl03-admin-obs::0'),
    'tl03-admin-obs::0 present');

  perform tl03_assert('the evaluator''s own capture did land',
    exists (select 1 from evaluation where client_id = 'tl03-own-capture'),
    'tl03-own-capture present');

  perform tl03_assert('the phone capture''s text was not altered by anyone',
    (select source_text from evaluation where client_id = 'tl03-phone-capture')
      = 'Fixture capture text that only the workshop should be able to read.',
    'unchanged');
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl03_results
order by (verdict = 'PASS'), seq;
