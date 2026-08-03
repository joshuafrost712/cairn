-- tl-07 acceptance harness: is the setup audit log actually append-only, and is the
-- actor actually the caller?
--
-- The log's whole value is that it cannot be edited by the person it records. So the
-- interesting attacks are not reads: they are an administrator rewriting the entry
-- that says what they changed, deleting it, or attributing their edit to a colleague.
-- All three would leave the app looking exactly right.
--
-- There is one more that is easy to miss. `log_setup_change` is SECURITY DEFINER, so
-- it runs as the table's owner and past its policies. A security-definer function that
-- forgets its own authorization check is a public write path with extra steps, so the
-- first two checks below are aimed straight at it.
--
-- Same conventions as scripts/tl04-rls-tests.sql, and the same reason for them: under
-- RLS a denied read and an empty table are indistinguishable, so every check DECLARES
-- its expectation and the state assertions at the end confirm that nothing an attacker
-- attempted actually landed.
--
-- Run against the linked project as `postgres`, then run the teardown:
--
--   node scripts/apply-migration.mjs scripts/tl07-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl07-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl07_results;
create table tl07_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl07_try(text, text, uuid, text);
create or replace function tl07_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl07_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl07_assert(text, boolean, text);
create or replace function tl07_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl07_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   A (admin)      tl07-a@example.org   admin in the pilot workshop
--   E (evaluator)  tl07-e@example.org   evaluator in the pilot workshop
--   O (outsider)   tl07-o@example.org   admin in a SECOND workshop only
--
-- O is an admin rather than an evaluator on purpose: the cross-workshop check has to
-- prove the RPC scopes on the workshop argument and not merely on holding the role
-- somewhere.
--
-- Provisioned through the real signup path (allowlist + handle_new_user), so the
-- app_user row and the membership come from the trigger rather than by hand.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _other uuid := '77777777-7777-7777-7777-777777777777';
  _a     uuid := '7a000000-0000-4000-8000-000000000001';
  _e     uuid := '7e000000-0000-4000-8000-000000000002';
  _o     uuid := '70000000-0000-4000-8000-000000000003';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from setup_change_log where id like 'tl07-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl07-%@example.org';
  delete from app_user where email like 'tl07-%@example.org';
  delete from auth.users where id in (_a, _e, _o);
  delete from role_allowlist where email like 'tl07-%@example.org';
  delete from workshop where id = _other;

  insert into workshop (id, name, start_date, location)
  values (_other, 'TL07 Fixture Workshop (outsider''s)', '2027-03-01', 'Nowhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl07-a@example.org', array['admin'],     'admin',     'tl-07 test fixture', _pilot),
    ('tl07-e@example.org', array['evaluator'], 'evaluator', 'tl-07 test fixture', _pilot),
    ('tl07-o@example.org', array['admin'],     'admin',     'tl-07 test fixture', _other);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_a, 'tl07-a@example.org', 'TL07 Admin A'),
    (_e, 'tl07-e@example.org', 'TL07 Evaluator E'),
    (_o, 'tl07-o@example.org', 'TL07 Outsider Admin O')
  ) as v(id, email, name);

  -- One genuine entry for A to try to rewrite, and one in the other workshop so the
  -- cross-workshop read has something real to fail to find. Inserted as postgres,
  -- which is the only path that bypasses the RPC.
  insert into setup_change_log (
    id, workshop_id, actor_email, entity, entity_id, entity_label,
    operation, severity, workshop_state, diff, counts
  ) values (
    'tl07-existing', _pilot, 'tl07-a@example.org', 'question', 'k-fixture', 'Q-FIXTURE',
    'update', 'invalidates_evidence', 'in_progress',
    '{"evidence_levels":{"before":"old","after":"new"}}'::jsonb,
    '{"observations":23,"participants":6}'::jsonb
  ), (
    'tl07-other-workshop', _other, 'tl07-o@example.org', 'event', 'a-fixture', 'Day 1',
    'delete', 'destructive', 'in_progress', '{}'::jsonb, '{}'::jsonb
  );

  perform tl07_assert(
    'fixtures provisioned three accounts through the real signup path',
    (select count(*) from app_user where email like 'tl07-%@example.org') = 3
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl07-%@example.org') = 3,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl07-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl07-%@example.org')));

  perform tl07_assert(
    'the admin fixture really holds admin in the pilot workshop',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email = 'tl07-a@example.org' and wm.workshop_id = _pilot
               and wm.role = 'admin'),
    coalesce((select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
               where u.email = 'tl07-a@example.org' and wm.workshop_id = _pilot), 'NO MEMBERSHIP'));
end $$;

-- ---------------------------------------------------------------------------
-- The negative checks. Every one of these must fail.
--
--   A  7a000000-0000-4000-8000-000000000001  admin, pilot workshop
--   E  7e000000-0000-4000-8000-000000000002  evaluator, pilot workshop
--   O  70000000-0000-4000-8000-000000000003  admin, other workshop
-- ---------------------------------------------------------------------------

-- 1. The security-definer trap. If the function forgot its own role check, this is a
--    public write path and every evaluator can write the administrators' audit log.
select tl07_try('blocked', 'E (evaluator) calls log_setup_change for their own workshop',
  '7e000000-0000-4000-8000-000000000002',
  $q$select log_setup_change('tl07-forged-by-evaluator',
        '11111111-1111-1111-1111-111111111111'::uuid, 'question', 'k1', 'Q1',
        'delete', 'destructive', 'in_progress')$q$);

-- 2. Cross-workshop: holding admin SOMEWHERE is not holding it here.
select tl07_try('blocked', 'O (admin elsewhere) logs a change against the pilot workshop',
  '70000000-0000-4000-8000-000000000003',
  $q$select log_setup_change('tl07-forged-cross-workshop',
        '11111111-1111-1111-1111-111111111111'::uuid, 'workshop', 'w1', 'Pilot',
        'delete', 'destructive', 'in_progress')$q$);

-- 3. Straight into the table, bypassing the RPC. There is no insert policy, so even a
--    legitimate administrator cannot write a row whose actor they chose.
select tl07_try('blocked', 'A (admin) inserts into setup_change_log directly',
  '7a000000-0000-4000-8000-000000000001',
  $q$insert into setup_change_log
       (id, workshop_id, actor_email, entity, entity_label, operation, severity, workshop_state)
     values ('tl07-direct-insert', '11111111-1111-1111-1111-111111111111',
             'somebody-else@example.org', 'question', 'Q1', 'delete', 'safe', 'draft')$q$);

-- 4. Rewriting history: the entry that says what A did, edited by A.
select tl07_try('blocked', 'A rewrites the severity of their own logged change',
  '7a000000-0000-4000-8000-000000000001',
  $q$update setup_change_log set severity = 'safe', counts = '{}'::jsonb
       where id = 'tl07-existing'$q$);

-- 5. Deleting history.
select tl07_try('blocked', 'A deletes their own logged change',
  '7a000000-0000-4000-8000-000000000001',
  $q$delete from setup_change_log where id = 'tl07-existing'$q$);

-- 6. An evaluator reading the administrators' log. Management information, not
--    something needed while capturing.
select tl07_try('blocked', 'E reads the setup log for their workshop',
  '7e000000-0000-4000-8000-000000000002',
  $q$select * from setup_change_log where id = 'tl07-existing'$q$);

-- 7. An administrator reading another workshop's log.
select tl07_try('blocked', 'A reads the other workshop''s log entry',
  '7a000000-0000-4000-8000-000000000001',
  $q$select * from setup_change_log where id = 'tl07-other-workshop'$q$);

-- 8. Anonymous, for completeness.
select tl07_try('blocked', 'anon reads the setup log', null,
  $q$select * from setup_change_log$q$);

-- ---------------------------------------------------------------------------
-- The permitted paths. If these fail the feature does not work, which is the other
-- way for a permission change to be wrong.
-- ---------------------------------------------------------------------------

select tl07_try('permitted', 'A logs a change against their own workshop through the RPC',
  '7a000000-0000-4000-8000-000000000001',
  $q$select log_setup_change('tl07-legit',
        '11111111-1111-1111-1111-111111111111'::uuid, 'question', 'k9', 'Q9 — fixture',
        'update', 'invalidates_evidence', 'in_progress',
        '{"evidence_levels":{"before":"a","after":"b"}}'::jsonb,
        '{"observations":23,"participants":6}'::jsonb)$q$);

select tl07_try('permitted', 'A reads their own workshop''s log',
  '7a000000-0000-4000-8000-000000000001',
  $q$select * from setup_change_log where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- A replayed offline queue must not double-log. Same id twice is a no-op, not an error
-- and not a second row; the assertion below counts.
select tl07_try('permitted', 'A replays the same log id (offline queue re-drain)',
  '7a000000-0000-4000-8000-000000000001',
  $q$select log_setup_change('tl07-legit',
        '11111111-1111-1111-1111-111111111111'::uuid, 'question', 'k9', 'Q9 — fixture',
        'update', 'invalidates_evidence', 'in_progress')$q$);

-- ---------------------------------------------------------------------------
-- State assertions. Under RLS a blocked write and a silently-dropped write look the
-- same from the client, so the only way to know is to read the table as postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl07_assert('no evaluator-written entry landed',
    not exists (select 1 from setup_change_log where id = 'tl07-forged-by-evaluator'),
    format('%s row(s)', (select count(*) from setup_change_log
                          where id = 'tl07-forged-by-evaluator')));

  perform tl07_assert('no cross-workshop entry landed',
    not exists (select 1 from setup_change_log where id = 'tl07-forged-cross-workshop'),
    format('%s row(s)', (select count(*) from setup_change_log
                          where id = 'tl07-forged-cross-workshop')));

  perform tl07_assert('no direct insert landed',
    not exists (select 1 from setup_change_log where id = 'tl07-direct-insert'),
    format('%s row(s)', (select count(*) from setup_change_log where id = 'tl07-direct-insert')));

  perform tl07_assert('the existing entry still says what it said',
    (select severity from setup_change_log where id = 'tl07-existing') = 'invalidates_evidence'
      and (select counts->>'observations' from setup_change_log where id = 'tl07-existing') = '23',
    format('severity = %s, observations = %s',
           coalesce((select severity from setup_change_log where id = 'tl07-existing'), 'GONE'),
           coalesce((select counts->>'observations' from setup_change_log
                      where id = 'tl07-existing'), 'GONE')));

  perform tl07_assert('the legitimate entry landed',
    exists (select 1 from setup_change_log where id = 'tl07-legit'),
    'tl07-legit present');

  perform tl07_assert('the actor is the CALLER, not a value the client supplied',
    (select actor_email from setup_change_log where id = 'tl07-legit') = 'tl07-a@example.org',
    format('actor_email = %s', coalesce((select actor_email from setup_change_log
                                          where id = 'tl07-legit'), 'GONE')));

  perform tl07_assert('a replayed queue did not double-log',
    (select count(*) from setup_change_log where id = 'tl07-legit') = 1,
    format('%s row(s) for tl07-legit',
           (select count(*) from setup_change_log where id = 'tl07-legit')));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl07_results
order by (verdict = 'PASS'), seq;