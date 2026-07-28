-- tl-01 acceptance harness: does per-workshop membership actually hold at the
-- database, or only in the UI?
--
-- Every check below runs as a real session with a real `sub` claim, on the same
-- footing PostgREST puts a browser on: the policy expressions and the
-- security-definer helpers are exercised exactly as they are in production. What
-- the UI would or would not render is not consulted anywhere in this file, which
-- is the point — a permission verified only by "the right person can do it" has
-- verified nothing.
--
-- Each check DECLARES its expectation, because under RLS a denied read and an
-- empty table look identical: the row is filtered, not refused. "0 rows returned"
-- is therefore the denial for a select and the denial for an unpermitted update
-- alike, and a harness that printed the raw outcome would report both as success.
-- So `blocked` passes on an error OR on zero rows affected, `permitted` passes
-- only on no error AND at least one row. The state assertions at the end close the
-- remaining gap by checking that nothing an attacker attempted actually landed.
--
-- Run against the linked project through a client that connects as `postgres`
-- (the Management API query endpoint does), so fixture setup bypasses RLS while
-- the checks themselves do not. Then run the teardown:
--
--   tl01-rls-tests.sql      -- builds fixtures, runs the checks, prints the report
--   tl01-rls-teardown.sql   -- removes every fixture row
--
-- Teardown is a separate file rather than a tail on this one because only the
-- last statement's result comes back over the API, and the report is the thing
-- worth reading. Both are idempotent; re-running is safe.

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl01_results;
create table tl01_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl01_try(text, text, uuid, text);
create or replace function tl01_try(_expect text, _label text, _uid uuid, _sql text)
returns void
language plpgsql
as $$
declare
  _count   bigint;
  _outcome text;
  _errored boolean := false;
  _verdict text;
begin
  -- Become the session under test. `is_local` keeps it scoped to this transaction
  -- so a failed check cannot leak an impersonation forward. A null uid means the
  -- unauthenticated case: the `anon` role holding the public key that ships in the
  -- client bundle, with no session at all.
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

  insert into tl01_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

/** Record a state assertion: what must still be true after the attempts above. */
create or replace function tl01_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl01_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixture: a second workshop nobody in the pilot belongs to, with data in it,
-- plus an account that belongs ONLY to that workshop. Two organizations on one
-- deployment is the situation tl-01 exists for, so the test builds it.
-- ---------------------------------------------------------------------------

do $$
declare
  _ws   uuid := '22222222-2222-2222-2222-222222222222';
  _uid  uuid := '33333333-3333-3333-3333-333333333333';
  _team uuid;
  _part uuid;
  _act  uuid;
  _eval uuid;
  _au   uuid;
begin
  -- Clear anything a previous run left behind, so a re-run measures the policies
  -- rather than accumulated fixtures. Order matters twice over: captures first
  -- because evaluation.workshop_id is `on delete set null` and dropping the
  -- workshop would orphan them, and the fixture ACCOUNT before its auth row,
  -- because app_user.auth_user_id is set-null too. Removing the auth row is what
  -- makes the signup trigger fire again below, which is the point of provisioning
  -- the fixture account through the real path rather than by hand.
  delete from evaluation where client_id like 'tl01-%';
  delete from app_user where email = 'tl01-fixture@example.org';
  delete from auth.users where id = _uid;
  delete from workshop where id in (_ws, '44444444-4444-4444-4444-444444444444');

  insert into workshop (id, name, start_date, location)
  values (_ws, 'TL01 Fixture Workshop B', '2027-01-01', 'Nowhere');

  insert into team (workshop_id, name) values (_ws, 'TL01 Fixture Team') returning id into _team;
  insert into participant (workshop_id, name, team_id)
  values (_ws, 'TL01 Fixture Participant', _team) returning id into _part;
  insert into activity (workshop_id, title, sort_order)
  values (_ws, 'TL01 Fixture Activity', 1) returning id into _act;
  insert into evaluation (client_id, workshop_id, activity_id, evaluator_email, source_text)
  values ('tl01-fixture-eval', _ws, _act, 'fixture@example.org', 'fixture capture text')
  returning id into _eval;
  insert into observation (evaluation_id, participant_id, activity_id, text, evidence_designation)
  values (_eval, _part, _act, 'fixture observation', 2);

  -- The fixture account is provisioned through the real signup path (allowlist +
  -- handle_new_user trigger) rather than hand-inserted, so the trigger's new
  -- membership behaviour is under test too.
  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values ('tl01-fixture@example.org', array['admin'], 'admin', 'tl-01 test fixture', _ws)
  on conflict (email) do update set default_workshop_id = excluded.default_workshop_id,
                                    allowed_roles = excluded.allowed_roles,
                                    assigned_role = excluded.assigned_role;

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) values (
    _uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'tl01-fixture@example.org', 'not-a-real-password-hash',
    now(), now(), now(), '{"provider":"email"}'::jsonb, '{"name":"TL01 Fixture Admin"}'::jsonb
  );

  select id into _au from app_user where auth_user_id = _uid;
  perform tl01_assert(
    'signup provisions app_user (platform tier) + workshop_member (workshop role)',
    exists (select 1 from workshop_member wm
             where wm.app_user_id = _au and wm.workshop_id = _ws and wm.role = 'admin')
      and (select role from app_user where id = _au) = 'member',
    coalesce((select format('app_user.role=%s, membership=%s',
                            (select role from app_user where id = _au), wm.role)
                from workshop_member wm
               where wm.app_user_id = _au and wm.workshop_id = _ws), 'MISSING'));
end $$;

-- ---------------------------------------------------------------------------
-- Negative checks. Katie (chief_evaluator in the Bali workshop, no membership in
-- the fixture workshop) is the attacker in most of them.
--
--   Katie:         43bd8e1d-4fcc-4f3f-9d94-b0c013a47413  chief_evaluator, Bali
--   Josh:          3aea7d0d-133b-43ee-b5d0-a7a80374a87f  chief_admin (Bali) + platform_owner
--   Fixture admin: 33333333-3333-3333-3333-333333333333  admin, Workshop B only
-- ---------------------------------------------------------------------------

-- 1. The forged active workshop. A tampered localStorage id is, at the database,
--    simply a question about a workshop you do not belong to.
select tl01_try('blocked', 'forged workshop id: read its activities',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from activity where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('blocked', 'forged workshop id: write a capture into it',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$insert into evaluation (client_id, workshop_id, source_text)
     values ('tl01-forged-' || gen_random_uuid()::text,
             '22222222-2222-2222-2222-222222222222', 'forged')$q$);

-- 2. Cross-workshop reads with a perfectly legitimate session token.
select tl01_try('blocked', 'cross-workshop read: another workshop''s evaluations',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from evaluation where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('blocked', 'cross-workshop read: another workshop''s observations',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from observation o join evaluation e on e.id = o.evaluation_id
      where e.workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('blocked', 'cross-workshop read: another workshop''s participants',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from participant where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('blocked', 'cross-workshop read: the other workshop row itself',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from workshop where id = '22222222-2222-2222-2222-222222222222'$q$);

-- 3. Cross-workshop authoring: a chief_evaluator in Bali is not one anywhere else.
select tl01_try('blocked', 'cross-workshop write: rename another workshop''s participant',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$update participant set name = 'hijacked'
      where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('blocked', 'cross-workshop write: delete another workshop''s activity',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$delete from activity where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

-- 4. Self-promotion, all four ways it would be attempted.
select tl01_try('blocked', 'self-promotion: grant yourself a membership elsewhere',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$insert into workshop_member (workshop_id, app_user_id, role)
     select '22222222-2222-2222-2222-222222222222', id, 'chief_admin'
       from app_user where auth_user_id = auth.uid()$q$);

select tl01_try('blocked', 'self-promotion: raise your role in your own workshop',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$update workshop_member set role = 'chief_admin'
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('blocked', 'self-promotion: grant yourself the platform tier',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$update app_user set role = 'platform_owner' where auth_user_id = auth.uid()$q$);

select tl01_try('blocked', 'self-promotion: create a workshop without the platform tier',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$insert into workshop (name) values ('smuggled workshop')$q$);

-- 5. The directory. Two organizations on one deployment must not read each
--    other's people.
select tl01_try('blocked', 'directory: read an account you share no workshop with',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from app_user where email = 'tl01-fixture@example.org'$q$);

select tl01_try('blocked', 'directory: read the memberships of a workshop you are not in',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from workshop_member
      where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

-- 6. The other direction. An admin role that leaked across workshops is the exact
--    failure tl-01 exists to prevent, so it is checked from both sides.
select tl01_try('blocked', 'reverse direction: workshop B admin reads Bali''s evaluations',
  '33333333-3333-3333-3333-333333333333',
  $q$select 1 from evaluation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('blocked', 'reverse direction: workshop B admin edits a Bali participant',
  '33333333-3333-3333-3333-333333333333',
  $q$update participant set name = 'hijacked'
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- 7. Anonymous. Reference reads used to be open to the anon key, which is
--    published in the client bundle — the hole that made per-workshop roles
--    meaningless no matter how carefully they were assigned.
select tl01_try('blocked', 'anon key: read the workshop list', null,
  $q$select 1 from workshop$q$);

select tl01_try('blocked', 'anon key: read the participant list', null,
  $q$select 1 from participant$q$);

select tl01_try('blocked', 'anon key: read captures', null,
  $q$select 1 from evaluation$q$);

-- ---------------------------------------------------------------------------
-- Positive checks. A gate that denies everything is not a gate.
-- ---------------------------------------------------------------------------

select tl01_try('permitted', 'Bali member reads Bali activities',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from activity where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('permitted', 'Bali member reads Bali evaluations',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from evaluation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('permitted', 'Bali member writes a capture into Bali',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$insert into evaluation (client_id, workshop_id, source_text)
     values ('tl01-positive-' || gen_random_uuid()::text,
             '11111111-1111-1111-1111-111111111111', 'legitimate capture')$q$);

select tl01_try('permitted', 'Bali chief_evaluator edits a Bali participant',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$update participant set preferred_language = preferred_language
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('permitted', 'Bali member reads its own membership row',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from workshop_member
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl01_try('permitted', 'Bali member reads a colleague in the same workshop',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from app_user where email = 'josh_frost@sil.org'$q$);

select tl01_try('permitted', 'Bali member reads the KSA question bank',
  '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413',
  $q$select 1 from ksa$q$);

select tl01_try('permitted', 'workshop B admin reads workshop B',
  '33333333-3333-3333-3333-333333333333',
  $q$select 1 from activity where workshop_id = '22222222-2222-2222-2222-222222222222'$q$);

select tl01_try('permitted', 'platform owner creates a workshop',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$insert into workshop (id, name)
     values ('44444444-4444-4444-4444-444444444444', 'TL01 Created By Owner')$q$);

select tl01_try('permitted', 'the created workshop is visible to its creator',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$select 1 from workshop where id = '44444444-4444-4444-4444-444444444444'$q$);

-- ---------------------------------------------------------------------------
-- State assertions. This is where "no error, 0 rows" is converted into a claim
-- about the database: nothing an attacker attempted above actually landed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl01_assert('attacker''s platform tier is unchanged',
    (select role from app_user where email = 'katie_frost@sil.org') = 'member',
    format('katie_frost@sil.org role = %s',
           (select role from app_user where email = 'katie_frost@sil.org')));

  perform tl01_assert('attacker''s workshop role is unchanged',
    (select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
      where u.email = 'katie_frost@sil.org'
        and wm.workshop_id = '11111111-1111-1111-1111-111111111111') = 'chief_evaluator',
    format('membership role = %s',
           (select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email = 'katie_frost@sil.org'
               and wm.workshop_id = '11111111-1111-1111-1111-111111111111')));

  perform tl01_assert('attacker gained no membership in the other workshop',
    not exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
                 where u.email = 'katie_frost@sil.org'
                   and wm.workshop_id = '22222222-2222-2222-2222-222222222222'),
    'no workshop_member row in workshop B');

  perform tl01_assert('no participant was renamed by a cross-workshop write',
    not exists (select 1 from participant where name = 'hijacked'),
    format('%s participant(s) named "hijacked"',
           (select count(*) from participant where name = 'hijacked')));

  perform tl01_assert('the other workshop''s activity survived the delete attempt',
    exists (select 1 from activity where workshop_id = '22222222-2222-2222-2222-222222222222'),
    format('%s activity row(s) in workshop B',
           (select count(*) from activity where workshop_id = '22222222-2222-2222-2222-222222222222')));

  perform tl01_assert('no capture was forged into the other workshop',
    not exists (select 1 from evaluation where client_id like 'tl01-forged-%'),
    format('%s forged capture(s)',
           (select count(*) from evaluation where client_id like 'tl01-forged-%')));

  perform tl01_assert('no workshop was smuggled in without the platform tier',
    not exists (select 1 from workshop where name = 'smuggled workshop'),
    'no "smuggled workshop" row');

  perform tl01_assert('the platform owner''s new workshop made them its chief_admin',
    (select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
      where u.email = 'josh_frost@sil.org'
        and wm.workshop_id = '44444444-4444-4444-4444-444444444444') = 'chief_admin',
    format('creator role = %s',
           coalesce((select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
                      where u.email = 'josh_frost@sil.org'
                        and wm.workshop_id = '44444444-4444-4444-4444-444444444444'), 'NONE')));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl01_results
order by (verdict = 'PASS'), seq;
