-- tl-02 acceptance harness: does the promotion matrix hold in the database, or
-- only in the TypeScript that draws the buttons?
--
-- The refusals are the spec. A permission change verified only by "the right
-- person can do it" has verified nothing, so most of what follows is attempts
-- that must fail, each one declaring that expectation before it runs.
--
-- Same conventions as scripts/tl01-rls-tests.sql and scripts/tl04-rls-tests.sql,
-- and the same reason for them: under RLS a denied read and an empty table are
-- indistinguishable. An RPC refusal is louder — it raises 42501 — but the state
-- assertions at the end still exist, because "the call errored" and "nothing
-- changed" are different claims and only the second one matters.
--
-- Fixtures are prefixed tl02- and torn down on that prefix only, so this can run
-- against the live project beside another session's harness.
--
--   node scripts/apply-migration.mjs scripts/tl02-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl02-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl02_results;
create table tl02_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl02_try(text, text, uuid, text);
create or replace function tl02_try(_expect text, _label text, _uid uuid, _sql text)
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
    -- The slug in DETAIL is the stable half of a refusal; record it, because a
    -- test that only reads the prose cannot tell WHICH rule fired.
    _outcome := format('error [%s] %s', sqlstate, sqlerrm);
  end;
  reset role;

  -- tl-01's definition, kept deliberately: under RLS a refused write and a
  -- filtered one are different mechanisms with the same meaning, so `blocked`
  -- accepts either an exception or zero rows. That is safe for the RPC calls too,
  -- because `select some_rpc(...)` returns exactly one row when it succeeds — a
  -- zero-row false pass is not reachable for them.
  if _expect = 'blocked' then
    _verdict := case when _errored or _count = 0 then 'PASS' else 'FAIL' end;
  else
    _verdict := case when not _errored and _count > 0 then 'PASS' else 'FAIL' end;
  end if;

  insert into tl02_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl02_slug(text, text, uuid, text, text);
create or replace function tl02_slug(_expect_slug text, _label text, _uid uuid, _sql text, _unused text default null)
returns void
language plpgsql
as $$
declare
  _got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  begin
    execute _sql;
    _got := '(no error)';
  exception when others then
    get stacked diagnostics _got = pg_exception_detail;
  end;
  reset role;

  insert into tl02_results (verdict, expect, label, outcome)
  values (case when _got = _expect_slug then 'PASS' else 'FAIL' end,
          'slug', _label, format('detail = %s', coalesce(nullif(_got, ''), '(empty)')));
end $$;

drop function if exists tl02_assert(text, boolean, text);
create or replace function tl02_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl02_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- One fixture workshop of its own, so nothing here touches the pilot workshop's
-- two real memberships. Six accounts, because the matrix needs an actor and a
-- target at every rank that behaves differently:
--
--   CA  tl02-ca@example.org   chief_admin   the fixture workshop's owner
--   A1  tl02-a1@example.org   admin         the delegate whose limits are the spec
--   A2  tl02-a2@example.org   admin         the other admin A1 must not be able to touch
--   E1  tl02-e1@example.org   evaluator     the one person A1 may act on
--   CE  tl02-ce@example.org   chief_evaluator  in reach of CA, out of reach of A1
--   OUT tl02-out@example.org  (no membership)  a stranger, and the grant target
--
-- Provisioned through the real signup path (allowlist + handle_new_user), so the
-- app_user rows come from the trigger rather than by hand. `default_workshop_id`
-- is left null and memberships are set explicitly below, because the trigger's
-- bridge would otherwise give everybody the same role.
-- ---------------------------------------------------------------------------

do $$
declare
  _ws  uuid := 'a2000000-0000-4000-8000-000000000001';
  _ca  uuid := 'a2000000-0000-4000-8000-0000000000c1';
  _a1  uuid := 'a2000000-0000-4000-8000-0000000000a1';
  _a2  uuid := 'a2000000-0000-4000-8000-0000000000a2';
  _e1  uuid := 'a2000000-0000-4000-8000-0000000000e1';
  _ce  uuid := 'a2000000-0000-4000-8000-0000000000ce';
  _out uuid := 'a2000000-0000-4000-8000-0000000000f0';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from membership_change_log where workshop_id = _ws;
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl02-%@example.org';
  delete from app_user where email like 'tl02-%@example.org';
  delete from auth.users where id in (_ca, _a1, _a2, _e1, _ce, _out);
  delete from role_allowlist where email like 'tl02-%@example.org';
  delete from workshop where id = _ws;

  insert into workshop (id, name, start_date, location)
  values (_ws, 'TL02 Fixture Workshop', '2027-04-01', 'Nowhere');

  -- One participant, so "the platform owner can read the workshop row and nothing
  -- inside it" has something real to fail to find. An empty table would pass that
  -- check for free.
  insert into participant (id, workshop_id, name, preferred_language)
  values ('a2000000-0000-4000-8000-0000000000d1', _ws, 'TL02 Fixture Participant', 'English');

  insert into role_allowlist (email, allowed_roles, assigned_role, note)
  select v.email, array['evaluator'], 'evaluator', 'tl-02 test fixture'
  from (values ('tl02-ca@example.org'), ('tl02-a1@example.org'), ('tl02-a2@example.org'),
               ('tl02-e1@example.org'), ('tl02-ce@example.org'), ('tl02-out@example.org')
       ) as v(email);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_ca,  'tl02-ca@example.org',  'TL02 Chief Admin'),
    (_a1,  'tl02-a1@example.org',  'TL02 Admin One'),
    (_a2,  'tl02-a2@example.org',  'TL02 Admin Two'),
    (_e1,  'tl02-e1@example.org',  'TL02 Evaluator One'),
    (_ce,  'tl02-ce@example.org',  'TL02 Chief Evaluator'),
    (_out, 'tl02-out@example.org', 'TL02 Outsider')
  ) as v(id, email, name);

  insert into workshop_member (workshop_id, app_user_id, role)
  select _ws, u.id,
         case u.email
           when 'tl02-ca@example.org' then 'chief_admin'
           when 'tl02-a1@example.org' then 'admin'
           when 'tl02-a2@example.org' then 'admin'
           when 'tl02-e1@example.org' then 'evaluator'
           when 'tl02-ce@example.org' then 'chief_evaluator'
         end
    from app_user u
   where u.email in ('tl02-ca@example.org','tl02-a1@example.org','tl02-a2@example.org',
                     'tl02-e1@example.org','tl02-ce@example.org');

  perform tl02_assert(
    'fixtures provisioned six accounts and five memberships through the real signup path',
    (select count(*) from app_user where email like 'tl02-%@example.org') = 6
      and (select count(*) from workshop_member where workshop_id = _ws) = 5,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl02-%@example.org'),
           (select count(*) from workshop_member where workshop_id = _ws)));
end $$;

-- Helper: the fixture's app_user ids by email, so the checks below read as the
-- matrix rather than as uuids.
--
-- Security definer, and the reason is a real finding rather than convenience.
-- `app_user_select` shows you yourself plus people you share a workshop with, so
-- a plain helper returns NULL whenever the caller cannot already see the target —
-- and every "add somebody new" check then failed with "that person does not have
-- an account yet", which looks like a matrix refusal and is not one. The UI will
-- hold a real id when it calls these RPCs, so the helper stands in for that.
-- **Carry-forward for tl-11:** an invitation cannot be addressed by app_user_id
-- from the browser, because the browser cannot read the row of somebody who is
-- not yet in the workshop. It has to be addressed by email, inside an RPC.
drop function if exists tl02_uid(text);
create or replace function tl02_uid(_email text) returns uuid
language sql stable security definer set search_path = public
as $$ select id from app_user where email = _email $$;

-- ---------------------------------------------------------------------------
-- 1. The invariant: exactly one chief admin per workshop.
-- ---------------------------------------------------------------------------

select tl02_assert('the partial unique index exists',
  exists (select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'workshop_member_one_chief_admin'),
  'workshop_member_one_chief_admin');

-- Attempted as `postgres`, deliberately: this is the structural guarantee, and it
-- must hold even against a caller that no policy can stop.
do $$
declare _err text;
begin
  begin
    insert into workshop_member (workshop_id, app_user_id, role)
    values ('a2000000-0000-4000-8000-000000000001', tl02_uid('tl02-out@example.org'), 'chief_admin');
    _err := '(no error — a second chief admin was accepted)';
  exception when others then
    _err := format('error [%s] %s', sqlstate, sqlerrm);
  end;
  perform tl02_assert('a second chief_admin cannot exist even for a superuser',
    _err like 'error [23505]%', _err);
end $$;

-- ---------------------------------------------------------------------------
-- 2. The chief admin's powers. The positives, so the refusals below mean
--    something: a matrix that refuses everything passes a negatives-only suite.
-- ---------------------------------------------------------------------------

select tl02_try('permitted', 'CA promotes the outsider to admin',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'), 'admin')$q$);

select tl02_try('permitted', 'CA demotes that new admin to evaluator',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'), 'evaluator')$q$);

select tl02_try('permitted', 'CA removes them again',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'))$q$);

select tl02_try('permitted', 'CA re-ranks the chief evaluator as a consultant',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ce@example.org'), 'consultant')$q$);

select tl02_try('permitted', 'CA puts the chief evaluator back',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ce@example.org'), 'chief_evaluator')$q$);

-- ---------------------------------------------------------------------------
-- 3. The admin's ceiling. This is the asymmetry Joshua asked for, cell by cell.
-- ---------------------------------------------------------------------------

select tl02_try('permitted', 'A1 adds the outsider as an evaluator',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'), 'evaluator')$q$);

select tl02_try('permitted', 'A1 removes that evaluator again',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'))$q$);

select tl02_try('blocked', 'A1 promotes an evaluator to admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_try('blocked', 'A1 promotes an evaluator to chief_evaluator',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'chief_evaluator')$q$);

select tl02_try('blocked', 'A1 promotes an evaluator to consultant',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'consultant')$q$);

select tl02_try('blocked', 'A1 grants chief_admin directly',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'chief_admin')$q$);

select tl02_try('blocked', 'A1 demotes the other admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'), 'evaluator')$q$);

select tl02_try('blocked', 'A1 removes the other admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'))$q$);

select tl02_try('blocked', 'A1 removes the chief admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'))$q$);

select tl02_try('blocked', 'A1 demotes the chief admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'), 'evaluator')$q$);

select tl02_try('blocked', 'A1 removes the chief evaluator',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ce@example.org'))$q$);

select tl02_try('blocked', 'A1 promotes themselves to chief_admin',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'), 'chief_admin')$q$);

select tl02_try('blocked', 'A1 transfers the chief admin role to themselves',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'))$q$);

-- ---------------------------------------------------------------------------
-- 4. Nobody grants chief_admin, and nobody strands a workshop.
-- ---------------------------------------------------------------------------

select tl02_try('blocked', 'CA grants chief_admin through set_workshop_member_role',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'), 'chief_admin')$q$);

select tl02_try('blocked', 'CA demotes themselves',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'), 'admin')$q$);

select tl02_try('blocked', 'CA removes themselves',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'))$q$);

-- ---------------------------------------------------------------------------
-- 5. Everyone else. An evaluator calling any of the three, and a member of a
--    different workshop entirely.
-- ---------------------------------------------------------------------------

select tl02_try('blocked', 'E1 promotes themselves to admin',
  'a2000000-0000-4000-8000-0000000000e1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_try('blocked', 'E1 removes an admin',
  'a2000000-0000-4000-8000-0000000000e1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'))$q$);

select tl02_try('blocked', 'E1 transfers the chief admin role',
  'a2000000-0000-4000-8000-0000000000e1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'))$q$);

select tl02_try('blocked', 'CE (chief evaluator, an evaluation role) promotes an evaluator',
  'a2000000-0000-4000-8000-0000000000ce',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_try('blocked', 'the outsider, a member of no workshop, adds themselves',
  'a2000000-0000-4000-8000-0000000000f0',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'), 'admin')$q$);

-- The pilot workshop's own chief admin has no standing in the fixture workshop.
-- Membership, not rank, is what the RPC resolves.
select tl02_try('blocked', 'the pilot workshop''s chief admin acts on the fixture workshop',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

-- ---------------------------------------------------------------------------
-- 6. Passing somebody else's user id as the actor.
--
--    There is no actor argument, which is the answer: the caller is resolved from
--    auth.uid() inside the function. The attack that remains is impersonating the
--    session itself, so this runs A1's forged attempt as an anon session and as a
--    session whose sub belongs to no account.
-- ---------------------------------------------------------------------------

select tl02_try('blocked', 'an anon session calls the RPC',
  null,
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_try('blocked', 'a session whose sub matches no account calls the RPC',
  'a2000000-0000-4000-8000-0000000000ff',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

-- The table itself is still closed. tl-01 revoked the grants; tl-02 did not
-- reopen them by adding a policy.
select tl02_try('blocked', 'A1 writes workshop_member directly, bypassing the RPC',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$update workshop_member set role = 'chief_admin'
      where workshop_id = 'a2000000-0000-4000-8000-000000000001'
        and app_user_id = tl02_uid('tl02-a1@example.org')$q$);

select tl02_try('blocked', 'A1 inserts a membership directly',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$insert into workshop_member (workshop_id, app_user_id, role)
     values ('a2000000-0000-4000-8000-000000000001', tl02_uid('tl02-out@example.org'), 'admin')$q$);

-- ---------------------------------------------------------------------------
-- 7. The slugs. The message is prose and may be reworded; the slug is the
--    contract tl-11 renders against, so it is asserted rather than assumed.
-- ---------------------------------------------------------------------------

select tl02_slug('tl02.admin_may_only_grant_evaluator', 'admin over-reach carries its own slug',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_slug('tl02.chief_admin_by_transfer_only', 'granting chief_admin carries its own slug',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'), 'chief_admin')$q$);

select tl02_slug('tl02.chief_admin_cannot_leave', 'the chief admin''s own exit carries its own slug',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'))$q$);

select tl02_slug('tl02.only_chief_admin_transfers', 'a non-chief transfer carries its own slug',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'))$q$);

select tl02_slug('tl02.target_not_a_member', 'transferring to a non-member carries its own slug',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'))$q$);

-- ---------------------------------------------------------------------------
-- 8. Self-removal. Leaving a workshop you were added to should not require
--    anybody's permission — except the chief admin's, whose exit is a transfer.
-- ---------------------------------------------------------------------------

select tl02_try('permitted', 'A2 removes their own membership',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$select remove_workshop_member('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'))$q$);

-- Put A2 back; the transfer sequence below needs a second admin present.
do $$ begin
  insert into workshop_member (workshop_id, app_user_id, role)
  values ('a2000000-0000-4000-8000-000000000001', tl02_uid('tl02-a2@example.org'), 'admin')
  on conflict (workshop_id, app_user_id) do update set role = 'admin';
end $$;

-- ---------------------------------------------------------------------------
-- 9. The transfer, and the state it must leave behind.
-- ---------------------------------------------------------------------------

select tl02_try('blocked', 'CA transfers to somebody who is not a member',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-out@example.org'))$q$);

select tl02_try('blocked', 'CA transfers to themselves',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-ca@example.org'))$q$);

select tl02_try('permitted', 'CA transfers the role to A1',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a1@example.org'))$q$);

do $$
declare _ws uuid := 'a2000000-0000-4000-8000-000000000001';
begin
  perform tl02_assert('after the transfer A1 is the chief admin',
    (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-a1@example.org')) = 'chief_admin',
    format('A1 = %s', (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-a1@example.org'))));

  perform tl02_assert('the former chief admin ends as an admin, not removed',
    (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-ca@example.org')) = 'admin',
    format('CA = %s', coalesce((select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-ca@example.org')), 'GONE')));

  perform tl02_assert('the workshop still has exactly one chief admin',
    (select count(*) from workshop_member where workshop_id = _ws and role = 'chief_admin') = 1,
    format('%s chief admin(s)', (select count(*) from workshop_member where workshop_id = _ws and role = 'chief_admin')));
end $$;

-- The old chief admin now holds an admin's ceiling, which is the real proof that
-- the transfer moved authority rather than only a label.
select tl02_try('blocked', 'the former chief admin can no longer promote to admin',
  'a2000000-0000-4000-8000-0000000000c1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

select tl02_try('permitted', 'the new chief admin can',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'admin')$q$);

-- Put E1 back, so the later "an evaluator cannot read the log" check is asked of
-- an actual evaluator. Leaving them promoted would have made that check pass for
-- the wrong reason, which is how a suite quietly stops testing what it names.
select tl02_try('permitted', 'the new chief admin returns E1 to evaluator',
  'a2000000-0000-4000-8000-0000000000a1',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'evaluator')$q$);

-- ---------------------------------------------------------------------------
-- 10. The recovery path: a platform owner rescues a workshop whose chief admin
--     is gone at the auth level.
-- ---------------------------------------------------------------------------

-- Delete A1's account the way an identity provider would: from auth.users.
do $$
begin
  delete from app_user where email = 'tl02-a1@example.org';
  delete from auth.users where id = 'a2000000-0000-4000-8000-0000000000a1';
  perform tl02_assert('the fixture workshop is now leaderless',
    (select count(*) from workshop_member
      where workshop_id = 'a2000000-0000-4000-8000-000000000001' and role = 'chief_admin') = 0,
    format('%s chief admin(s)', (select count(*) from workshop_member
      where workshop_id = 'a2000000-0000-4000-8000-000000000001' and role = 'chief_admin')));
end $$;

select tl02_try('blocked', 'an admin cannot rescue it themselves',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'))$q$);

select tl02_try('permitted', 'the platform owner rescues it, holding no membership in it',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select transfer_chief_admin('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-a2@example.org'))$q$);

do $$
declare _ws uuid := 'a2000000-0000-4000-8000-000000000001';
begin
  perform tl02_assert('the rescued workshop has a chief admin again',
    (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-a2@example.org')) = 'chief_admin',
    format('A2 = %s', (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-a2@example.org'))));

  perform tl02_assert('the rescue did not make the platform owner a member',
    not exists (select 1 from workshop_member
                 where workshop_id = _ws
                   and app_user_id = (select id from app_user where lower(email) = 'josh_frost@sil.org')),
    'no membership row for the platform owner in the fixture workshop');
end $$;

-- The recovery path is transfer and only transfer. A platform owner holding no
-- membership still cannot administer the workshop.
select tl02_try('blocked', 'the platform owner promotes somebody in a workshop they do not belong to',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select set_workshop_member_role('a2000000-0000-4000-8000-000000000001',
        tl02_uid('tl02-e1@example.org'), 'consultant')$q$);

select tl02_try('blocked', 'the platform owner renames a workshop they do not belong to',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$update workshop set name = 'Seized by the platform owner'
      where id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'the platform owner upserts OVER a workshop they do not belong to',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$insert into workshop (id, name, start_date, location)
     values ('a2000000-0000-4000-8000-000000000001', 'Seized by upsert', '2027-04-01', 'Nowhere')
     on conflict (id) do update set name = excluded.name returning id$q$);

-- The read widening this spec introduces, stated as a check rather than left to
-- the migration comment: a platform owner sees every workshop ROW, and nothing
-- inside one they do not belong to.
select tl02_try('permitted', 'the platform owner READS a workshop row they do not belong to',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select 1 from workshop where id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'and cannot read its participants',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select 1 from participant where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'and cannot read its roster',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select 1 from workshop_member where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'and an ordinary member of another workshop still reads nothing of it',
  'a2000000-0000-4000-8000-0000000000e1',
  $q$select 1 from workshop where id = '11111111-1111-1111-1111-111111111111'$q$);

-- ---------------------------------------------------------------------------
-- 11. The workshop-upsert bug tl-08 found, and its fix.
--
--     PostgREST's upsert is `insert ... on conflict do update`, for which
--     Postgres applies the UPDATE policy's WITH CHECK to the appended row. Before
--     this migration that refused every workshop a platform owner created in the
--     app. tl-17's create flow is blocked until this passes.
-- ---------------------------------------------------------------------------

select tl02_try('permitted', 'the platform owner UPSERTS a new workshop, as the outbox does',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$insert into workshop (id, name, start_date, location)
     values ('a2000000-0000-4000-8000-0000000000b1', 'TL02 Created Through The Outbox', '2027-05-01', 'Nowhere')
     on conflict (id) do update set name = excluded.name,
       start_date = excluded.start_date, location = excluded.location$q$);

do $$
begin
  perform tl02_assert('the created workshop actually landed in Postgres',
    exists (select 1 from workshop where id = 'a2000000-0000-4000-8000-0000000000b1'),
    'a2000000-...b1 present');

  perform tl02_assert('its creator was seeded as its chief admin by the tl-01 trigger',
    (select role from workshop_member
      where workshop_id = 'a2000000-0000-4000-8000-0000000000b1'
        and app_user_id = (select id from app_user where lower(email) = 'josh_frost@sil.org')) = 'chief_admin',
    coalesce((select role from workshop_member
      where workshop_id = 'a2000000-0000-4000-8000-0000000000b1'
        and app_user_id = (select id from app_user where lower(email) = 'josh_frost@sil.org')), 'NO MEMBERSHIP'));
end $$;

-- And an ordinary member still cannot create one, so the fix widened nothing else.
select tl02_try('blocked', 'a workshop admin upserts a brand new workshop',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$insert into workshop (id, name, start_date, location)
     values ('a2000000-0000-4000-8000-0000000000b2', 'TL02 Should Not Exist', '2027-05-01', 'Nowhere')
     on conflict (id) do update set name = excluded.name$q$);

-- ---------------------------------------------------------------------------
-- 12. The audit log.
-- ---------------------------------------------------------------------------

do $$
declare _ws uuid := 'a2000000-0000-4000-8000-000000000001';
begin
  perform tl02_assert('every successful change was logged',
    (select count(*) from membership_change_log where workshop_id = _ws) >= 12,
    format('%s log row(s)', (select count(*) from membership_change_log where workshop_id = _ws)));

  perform tl02_assert('no refused attempt was logged',
    not exists (select 1 from membership_change_log
                 where workshop_id = _ws and to_role = 'chief_admin' and operation = 'grant'),
    'no grant row reaches chief_admin');

  perform tl02_assert('the transfer wrote both halves',
    (select count(*) from membership_change_log
      where workshop_id = _ws and operation = 'transfer') = 2,
    format('%s transfer row(s)', (select count(*) from membership_change_log
      where workshop_id = _ws and operation = 'transfer')));

  perform tl02_assert('the recovery is distinguishable from an ordinary transfer',
    exists (select 1 from membership_change_log where workshop_id = _ws and operation = 'recover'),
    format('%s recover row(s)', (select count(*) from membership_change_log
      where workshop_id = _ws and operation = 'recover')));

  perform tl02_assert('a deleted actor still has a name in the log',
    exists (select 1 from membership_change_log
             where workshop_id = _ws and actor_email = 'tl02-a1@example.org'
               and actor_app_user_id is null),
    'A1''s rows survive the deletion of A1''s account');
end $$;

select tl02_try('blocked', 'an evaluator reads the membership log',
  'a2000000-0000-4000-8000-0000000000e1',
  $q$select 1 from membership_change_log
      where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('permitted', 'the chief admin reads the membership log',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$select 1 from membership_change_log
      where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'an admin rewrites the log',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$update membership_change_log set to_role = 'evaluator'
      where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'an admin deletes from the log',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$delete from membership_change_log
      where workshop_id = 'a2000000-0000-4000-8000-000000000001'$q$);

select tl02_try('blocked', 'an admin forges a log row',
  'a2000000-0000-4000-8000-0000000000a2',
  $q$insert into membership_change_log (workshop_id, operation, to_role)
     values ('a2000000-0000-4000-8000-000000000001', 'grant', 'chief_admin')$q$);

-- ---------------------------------------------------------------------------
-- 13. Nothing landed that should not have. The checks above prove calls errored;
--     these prove the database is where the matrix says it should be.
-- ---------------------------------------------------------------------------

do $$
declare _ws uuid := 'a2000000-0000-4000-8000-000000000001';
begin
  perform tl02_assert('E1 is still an evaluator despite four attempts to raise them',
    (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-e1@example.org')) = 'evaluator',
    format('E1 = %s', coalesce((select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-e1@example.org')), 'GONE')));

  perform tl02_assert('the chief evaluator is still a chief evaluator',
    (select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-ce@example.org')) = 'chief_evaluator',
    format('CE = %s', coalesce((select role from workshop_member where workshop_id = _ws and app_user_id = tl02_uid('tl02-ce@example.org')), 'GONE')));

  perform tl02_assert('the outsider still belongs to no workshop',
    not exists (select 1 from workshop_member where app_user_id = tl02_uid('tl02-out@example.org')),
    format('%s membership(s)', (select count(*) from workshop_member where app_user_id = tl02_uid('tl02-out@example.org'))));

  perform tl02_assert('no second workshop was created by a non-owner',
    not exists (select 1 from workshop where id = 'a2000000-0000-4000-8000-0000000000b2'),
    'a2000000-...b2 absent');

  perform tl02_assert('the fixture workshop was not renamed by the platform owner',
    (select name from workshop where id = _ws) = 'TL02 Fixture Workshop',
    format('name = %s', (select name from workshop where id = _ws)));

  perform tl02_assert('the pilot workshop was untouched by any of this',
    (select count(*) from workshop_member where workshop_id = '11111111-1111-1111-1111-111111111111') = 2
      and (select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
            where wm.workshop_id = '11111111-1111-1111-1111-111111111111'
              and lower(u.email) = 'josh_frost@sil.org') = 'chief_admin',
    format('%s pilot membership(s)', (select count(*) from workshop_member
      where workshop_id = '11111111-1111-1111-1111-111111111111')));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl02_results
order by (verdict = 'PASS'), seq;
