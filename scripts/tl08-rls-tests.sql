-- tl-08 acceptance harness: are questions and goals really scoped to a workshop?
--
-- This spec closes a hole tl-01 left open and said so. Until now `ksa` was global:
-- its select policy was `has_any_membership()`, so any member of any workshop on the
-- deployment could read — and any AUTHOR of any workshop could edit — every question
-- belonging to every other organization. That is the largest remaining gap in
-- per-workshop authorization, and it is invisible from the UI, because the UI only
-- ever showed one workshop's worth.
--
-- So the interesting attacks here are all cross-workshop, and there are two shapes of
-- them that are easy to confuse:
--
--   READING somebody else's question (checks 1-4), and
--   WRITING INTO somebody else's workshop while holding a legitimate role in your own
--   (checks 5-8). The second is the one a `using` clause alone would miss: a policy
--   needs a `with check` to stop an author moving their own row into a workshop they
--   do not belong to.
--
-- Same conventions as scripts/tl04-rls-tests.sql and tl07-rls-tests.sql, and the same
-- reason for them: under RLS a denied read and an empty table are indistinguishable,
-- so every check DECLARES its expectation, and the state assertions at the end confirm
-- that nothing an attacker attempted actually landed.
--
-- Run against the linked project as `postgres`, then run the teardown:
--
--   node scripts/apply-migration.mjs scripts/tl08-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl08-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl08_results;
create table tl08_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl08_try(text, text, uuid, text);
create or replace function tl08_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl08_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl08_assert(text, boolean, text);
create or replace function tl08_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl08_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   A (admin)      tl08-a@example.org   admin in workshop ONE
--   E (evaluator)  tl08-e@example.org   evaluator in workshop ONE
--   B (admin)      tl08-b@example.org   admin in workshop TWO only
--
-- TWO fixture workshops, neither of them the real pilot: this spec's subject is the
-- boundary BETWEEN workshops, and the pilot workshop holds Joshua's actual roster.
-- Each gets a goal and a question, and both questions are coded `Q1` — which is the
-- spec's headline acceptance criterion expressed as a constraint test. Before this
-- migration the second insert would have failed on a global unique.
--
-- Accounts are provisioned through the real signup path (allowlist +
-- handle_new_user), so app_user and membership come from the trigger, not by hand.
-- ---------------------------------------------------------------------------

do $$
declare
  _one uuid := '88888888-8888-8888-8888-888888888801';
  _two uuid := '88888888-8888-8888-8888-888888888802';
  _a   uuid := '8a000000-0000-4000-8000-000000000001';
  _e   uuid := '8e000000-0000-4000-8000-000000000002';
  _b   uuid := '8b000000-0000-4000-8000-000000000003';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl08-%@example.org';
  delete from app_user where email like 'tl08-%@example.org';
  delete from auth.users where id in (_a, _e, _b);
  delete from role_allowlist where email like 'tl08-%@example.org';
  -- Questions and goals cascade from the workshop.
  delete from workshop where id in (_one, _two);

  insert into workshop (id, name, start_date, location, goal_label)
  values (_one, 'TL08 Workshop One', '2027-04-01', 'Nowhere', 'KSA area'),
         (_two, 'TL08 Workshop Two', '2027-05-01', 'Elsewhere', null);

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl08-a@example.org', array['admin'],     'admin',     'tl-08 test fixture', _one),
    ('tl08-e@example.org', array['evaluator'], 'evaluator', 'tl-08 test fixture', _one),
    ('tl08-b@example.org', array['admin'],     'admin',     'tl-08 test fixture', _two);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_a, 'tl08-a@example.org', 'TL08 Admin A'),
    (_e, 'tl08-e@example.org', 'TL08 Evaluator E'),
    (_b, 'tl08-b@example.org', 'TL08 Admin B')
  ) as v(id, email, name);

  -- One goal and one question per workshop, both questions coded Q1.
  insert into goal (id, workshop_id, code, title, sort_order) values
    ('88888888-0000-4000-8000-000000000001', _one, 'G1', 'One''s exegesis goal', 0),
    ('88888888-0000-4000-8000-000000000002', _two, 'G1', 'Two''s facilitation goal', 0);

  insert into ksa (
    id, workshop_id, goal_id, code, short_label, description, evaluator_facing_prompt
  ) values
    ('88888888-0000-4000-8000-00000000000a', _one, '88888888-0000-4000-8000-000000000001',
     'Q1', 'One''s question', 'belongs to workshop one', 'How did they do it in ONE?'),
    ('88888888-0000-4000-8000-00000000000b', _two, '88888888-0000-4000-8000-000000000002',
     'Q1', 'Two''s question', 'belongs to workshop two', 'How did they do it in TWO?');

  perform tl08_assert(
    'two workshops each hold a question coded Q1 (the composite unique replaced the global one)',
    (select count(*) from ksa where code = 'Q1'
      and workshop_id in (_one, _two)) = 2,
    format('%s Q1 row(s) across the two fixture workshops',
           (select count(*) from ksa where code = 'Q1' and workshop_id in (_one, _two))));

  perform tl08_assert(
    'two workshops each hold a goal coded G1',
    (select count(*) from goal where code = 'G1' and workshop_id in (_one, _two)) = 2,
    format('%s G1 row(s)',
           (select count(*) from goal where code = 'G1' and workshop_id in (_one, _two))));

  perform tl08_assert(
    'fixtures provisioned three accounts through the real signup path',
    (select count(*) from app_user where email like 'tl08-%@example.org') = 3
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl08-%@example.org') = 3,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl08-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl08-%@example.org')));

  perform tl08_assert(
    'ksa.workshop_id is NOT NULL, so no question can exist outside a workshop',
    (select attnotnull from pg_attribute
      where attrelid = 'ksa'::regclass and attname = 'workshop_id'),
    'checked pg_attribute.attnotnull');

  perform tl08_assert(
    'the global unique on ksa.code is gone',
    not exists (
      select 1 from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      where c.relname = 'ksa' and con.contype = 'u'
        and con.conkey = array[(select attnum from pg_attribute
                                 where attrelid = c.oid and attname = 'code')]::smallint[]),
    'no single-column unique constraint on ksa.code');
end $$;

-- ---------------------------------------------------------------------------
-- The negative checks: reading across the boundary. Every one must fail.
--
--   A  8a000000-0000-4000-8000-000000000001  admin, workshop ONE
--   E  8e000000-0000-4000-8000-000000000002  evaluator, workshop ONE
--   B  8b000000-0000-4000-8000-000000000003  admin, workshop TWO
-- ---------------------------------------------------------------------------

-- 1. THE HOLE THIS SPEC CLOSES. Before tl-08 this returned the row, because the policy
--    was "are you a member of anything at all".
select tl08_try('blocked', 'A (admin of ONE) reads TWO''s question',
  '8a000000-0000-4000-8000-000000000001',
  $q$select * from ksa where id = '88888888-0000-4000-8000-00000000000b'$q$);

-- 2. The same for an evaluator, who has even less business there.
select tl08_try('blocked', 'E (evaluator in ONE) reads TWO''s question',
  '8e000000-0000-4000-8000-000000000002',
  $q$select * from ksa where id = '88888888-0000-4000-8000-00000000000b'$q$);

-- 3. Goals are new, so they are scoped from birth; assert it rather than assume it.
select tl08_try('blocked', 'A reads TWO''s goal',
  '8a000000-0000-4000-8000-000000000001',
  $q$select * from goal where id = '88888888-0000-4000-8000-000000000002'$q$);

-- 4. Anonymous, for completeness. The anon key is public.
select tl08_try('blocked', 'anon reads any question', null, $q$select * from ksa$q$);
select tl08_try('blocked', 'anon reads any goal', null, $q$select * from goal$q$);

-- ---------------------------------------------------------------------------
-- The negative checks: writing across the boundary. These are the ones a `using`
-- clause alone would let through.
-- ---------------------------------------------------------------------------

-- 5. Editing another workshop's question while holding admin in your own.
select tl08_try('blocked', 'A edits TWO''s question text',
  '8a000000-0000-4000-8000-000000000001',
  $q$update ksa set evaluator_facing_prompt = 'A got in here'
      where id = '88888888-0000-4000-8000-00000000000b'$q$);

-- 6. Deleting another workshop's question.
select tl08_try('blocked', 'A deletes TWO''s question',
  '8a000000-0000-4000-8000-000000000001',
  $q$delete from ksa where id = '88888888-0000-4000-8000-00000000000b'$q$);

-- 7. INSERTING INTO another workshop. This is the `with check` test: A holds a
--    legitimate authoring role, and is naming somebody else's workshop_id.
select tl08_try('blocked', 'A creates a question inside TWO',
  '8a000000-0000-4000-8000-000000000001',
  $q$insert into ksa (workshop_id, code, short_label, description, evaluator_facing_prompt)
     values ('88888888-8888-8888-8888-888888888802', 'FORGED', 'x', 'x', 'x')$q$);

select tl08_try('blocked', 'A creates a goal inside TWO',
  '8a000000-0000-4000-8000-000000000001',
  $q$insert into goal (workshop_id, code, title) values
     ('88888888-8888-8888-8888-888888888802', 'FORGED', 'x')$q$);

-- 8. MOVING a row across the boundary. A owns the row and owns the role; what they do
--    not own is the destination. Only a `with check` on the update policy stops this,
--    and it is the check most likely to be missing.
select tl08_try('blocked', 'A moves their own question into TWO',
  '8a000000-0000-4000-8000-000000000001',
  $q$update ksa set workshop_id = '88888888-8888-8888-8888-888888888802'
      where id = '88888888-0000-4000-8000-00000000000a'$q$);

-- 9. An evaluator authoring in their OWN workshop. Reading is a member's right;
--    writing is an author's.
select tl08_try('blocked', 'E (evaluator) edits ONE''s question',
  '8e000000-0000-4000-8000-000000000002',
  $q$update ksa set evaluator_facing_prompt = 'E got in here'
      where id = '88888888-0000-4000-8000-00000000000a'$q$);

select tl08_try('blocked', 'E (evaluator) creates a goal in ONE',
  '8e000000-0000-4000-8000-000000000002',
  $q$insert into goal (workshop_id, code, title) values
     ('88888888-8888-8888-8888-888888888801', 'EFORGE', 'x')$q$);

select tl08_try('blocked', 'E (evaluator) deletes ONE''s goal',
  '8e000000-0000-4000-8000-000000000002',
  $q$delete from goal where id = '88888888-0000-4000-8000-000000000001'$q$);

-- ---------------------------------------------------------------------------
-- The permitted paths. If these fail the feature does not work, which is the other
-- way for a permission change to be wrong.
-- ---------------------------------------------------------------------------

select tl08_try('permitted', 'A reads ONE''s own question',
  '8a000000-0000-4000-8000-000000000001',
  $q$select * from ksa where id = '88888888-0000-4000-8000-00000000000a'$q$);

select tl08_try('permitted', 'A reads ONE''s own goal',
  '8a000000-0000-4000-8000-000000000001',
  $q$select * from goal where id = '88888888-0000-4000-8000-000000000001'$q$);

select tl08_try('permitted', 'E (evaluator) READS ONE''s question, which capture needs',
  '8e000000-0000-4000-8000-000000000002',
  $q$select * from ksa where id = '88888888-0000-4000-8000-00000000000a'$q$);

select tl08_try('permitted', 'A edits ONE''s own question',
  '8a000000-0000-4000-8000-000000000001',
  $q$update ksa set evaluator_facing_prompt = 'edited by its own admin'
      where id = '88888888-0000-4000-8000-00000000000a'$q$);

select tl08_try('permitted', 'A creates a goal in ONE',
  '8a000000-0000-4000-8000-000000000001',
  $q$insert into goal (id, workshop_id, code, title, sort_order) values
     ('88888888-0000-4000-8000-000000000003',
      '88888888-8888-8888-8888-888888888801', 'G2', 'A second goal', 1)$q$);

-- A code that is free in THIS workshop but taken in another one. The whole spec, as
-- one insert: before the migration this failed on the global unique.
select tl08_try('permitted', 'B creates a question coded Q2 while ONE also has spare codes',
  '8b000000-0000-4000-8000-000000000003',
  $q$insert into ksa (workshop_id, code, short_label, description, evaluator_facing_prompt)
     values ('88888888-8888-8888-8888-888888888802', 'Q2', 'Two''s second', 'x', 'x')$q$);

-- ---------------------------------------------------------------------------
-- State assertions. Under RLS a blocked write and a silently-dropped write look the
-- same from the client, so the only way to know is to read the table as postgres.
-- ---------------------------------------------------------------------------

do $$
declare
  _one uuid := '88888888-8888-8888-8888-888888888801';
  _two uuid := '88888888-8888-8888-8888-888888888802';
begin
  perform tl08_assert('TWO''s question still says what TWO wrote',
    (select evaluator_facing_prompt from ksa
      where id = '88888888-0000-4000-8000-00000000000b') = 'How did they do it in TWO?',
    coalesce((select evaluator_facing_prompt from ksa
               where id = '88888888-0000-4000-8000-00000000000b'), 'GONE'));

  perform tl08_assert('TWO''s question was not deleted by A',
    exists (select 1 from ksa where id = '88888888-0000-4000-8000-00000000000b'),
    'present');

  perform tl08_assert('no forged row landed in TWO',
    not exists (select 1 from ksa where code = 'FORGED')
      and not exists (select 1 from goal where code = 'FORGED'),
    format('%s forged question(s), %s forged goal(s)',
           (select count(*) from ksa where code = 'FORGED'),
           (select count(*) from goal where code = 'FORGED')));

  perform tl08_assert('no evaluator-forged goal landed in ONE',
    not exists (select 1 from goal where code = 'EFORGE'),
    format('%s row(s)', (select count(*) from goal where code = 'EFORGE')));

  perform tl08_assert('ONE''s question did not move to TWO',
    (select workshop_id from ksa where id = '88888888-0000-4000-8000-00000000000a') = _one,
    format('workshop_id = %s',
           coalesce((select workshop_id from ksa
                      where id = '88888888-0000-4000-8000-00000000000a')::text, 'GONE')));

  perform tl08_assert('ONE''s question still carries the prompt E tried to overwrite',
    (select evaluator_facing_prompt from ksa
      where id = '88888888-0000-4000-8000-00000000000a') = 'edited by its own admin',
    coalesce((select evaluator_facing_prompt from ksa
               where id = '88888888-0000-4000-8000-00000000000a'), 'GONE'));

  perform tl08_assert('A''s legitimate goal landed in ONE',
    exists (select 1 from goal where id = '88888888-0000-4000-8000-000000000003'
             and workshop_id = _one),
    'present');

  perform tl08_assert('B''s legitimate question landed in TWO',
    exists (select 1 from ksa where code = 'Q2' and workshop_id = _two),
    format('%s row(s)', (select count(*) from ksa where code = 'Q2' and workshop_id = _two)));

  -- Deleting a goal must NOT take its questions with it. The classifier tells an
  -- administrator exactly that, and this is the constraint the promise rests on.
  delete from goal where id = '88888888-0000-4000-8000-000000000001';
  perform tl08_assert('deleting a goal leaves its questions ungrouped, not deleted',
    exists (select 1 from ksa where id = '88888888-0000-4000-8000-00000000000a'
             and goal_id is null),
    format('question present = %s, goal_id = %s',
           exists (select 1 from ksa where id = '88888888-0000-4000-8000-00000000000a'),
           coalesce((select goal_id from ksa
                      where id = '88888888-0000-4000-8000-00000000000a')::text, 'null')));

  -- The override columns exist and accept a value, including the empty array that
  -- means "show none on this event".
  perform tl08_assert('activity_ksa carries both override columns',
    (select count(*) from information_schema.columns
      where table_name = 'activity_ksa'
        and column_name in ('prompt_override', 'guiding_questions_override')) = 2,
    format('%s of 2 columns present',
           (select count(*) from information_schema.columns
             where table_name = 'activity_ksa'
               and column_name in ('prompt_override', 'guiding_questions_override'))));

  perform tl08_assert('workshop carries goal_label, and ONE set it',
    (select goal_label from workshop where id = _one) = 'KSA area'
      and (select goal_label from workshop where id = _two) is null,
    format('ONE = %s, TWO = %s',
           coalesce((select goal_label from workshop where id = _one), 'null'),
           coalesce((select goal_label from workshop where id = _two), 'null')));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl08_results
order by (verdict = 'PASS'), seq;
