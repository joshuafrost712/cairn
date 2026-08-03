-- tl-11 acceptance harness: can an administrator grow a workshop, and can nobody
-- else?
--
-- The refusals are the spec, as in tl-02. What is new here is that two of the
-- claims are about a path no RPC can reach — signup — so this harness provisions
-- accounts by inserting into `auth.users`, which fires `handle_new_user` exactly
-- as Supabase Auth does. That is the only way to test acceptance, revocation's
-- teeth, and email normalization in one place.
--
-- Fixtures are prefixed tl11- and torn down on that prefix only, so this runs
-- against the live project beside another session's harness.
--
--   node scripts/apply-migration.mjs scripts/tl11-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl11-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness (same shape as tl02's, and the same reasons for it)
-- ---------------------------------------------------------------------------

drop table if exists tl11_results;
create table tl11_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl11_try(text, text, uuid, text);
create or replace function tl11_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl11_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl11_slug(text, text, uuid, text);
create or replace function tl11_slug(_expect_slug text, _label text, _uid uuid, _sql text)
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

  insert into tl11_results (verdict, expect, label, outcome)
  values (case when _got = _expect_slug then 'PASS' else 'FAIL' end,
          'slug', _label, format('detail = %s', coalesce(nullif(_got, ''), '(empty)')));
end $$;

drop function if exists tl11_assert(text, boolean, text);
create or replace function tl11_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl11_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

/**
 * Run a statement as the owner, not as a session.
 *
 * Signup is not something an authenticated session does: Supabase Auth inserts
 * into `auth.users` with its own privileges, and `handle_new_user` is a definer
 * trigger on top of that. Driving it through `tl11_try` set the session role to
 * `anon`, which cannot touch `auth.users` at all — so every signup that was
 * supposed to be REFUSED by the invite-only gate was instead refused by table
 * permissions, and passed. A green that proves the wrong mechanism.
 *
 * So blocked cases here must also match the message. `_expect_message` is not
 * optional decoration: without it this function reintroduces the same false green
 * one layer up.
 */
drop function if exists tl11_owner(text, text, text, text);
create or replace function tl11_owner(_expect text, _label text, _sql text, _expect_message text default null)
returns void
language plpgsql
as $$
declare
  _outcome text;
  _errored boolean := false;
  _message text := '';
  _verdict text;
begin
  begin
    execute _sql;
    _outcome := 'no error';
  exception when others then
    _errored := true;
    _message := sqlerrm;
    _outcome := format('error [%s] %s', sqlstate, sqlerrm);
  end;

  if _expect = 'blocked' then
    _verdict := case
      when not _errored then 'FAIL'
      when _expect_message is not null and _message not ilike '%' || _expect_message || '%' then 'FAIL'
      else 'PASS'
    end;
  else
    _verdict := case when _errored then 'FAIL' else 'PASS' end;
  end if;

  insert into tl11_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

/**
 * Sign somebody up, the way Supabase Auth does.
 *
 * Inserting into `auth.users` fires `on_auth_user_created`, so this exercises the
 * real `handle_new_user` — the invite-only gate, the invitation acceptance loop,
 * and tl-01's allowlist bridge — rather than a reimplementation of it. Every claim
 * about what happens when an invited person finally signs up runs through here.
 */
drop function if exists tl11_signup(uuid, text, text);
create or replace function tl11_signup(_id uuid, _email text, _name text)
returns void
language plpgsql
as $$
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  values (_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          _email, 'not-a-real-password-hash', now(), now(), now(),
          '{"provider":"email"}'::jsonb, json_build_object('name', _name)::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Two workshops, because "invited to two workshops before signing up gets both
-- memberships" is one of the spec's acceptance criteria and a single-workshop
-- fixture cannot see it.
--
--   W1  the workshop under test
--   W2  a second one, for the multi-workshop claim and for the cross-workshop read
--
--   CA   tl11-ca@example.org    chief_admin in W1 and W2
--   A1   tl11-a1@example.org    admin in W1: the delegate whose limits are the spec
--   E1   tl11-e1@example.org    evaluator in W1: may read nothing about invitations
--   EXST tl11-existing@example.org  an account with no membership in W1, to prove
--                               that inviting an existing address adds it outright
--
-- Accounts are provisioned through the real signup path with allowlist rows and
-- `default_workshop_id` null, so the trigger's bridge does not hand everybody the
-- same role.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1   uuid := 'a3000000-0000-4000-8000-000000000001';
  _w2   uuid := 'a3000000-0000-4000-8000-000000000002';
  _ca   uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _a1   uuid := 'a3000000-0000-4000-8000-0000000000a1';
  _e1   uuid := 'a3000000-0000-4000-8000-0000000000e1';
  _exst uuid := 'a3000000-0000-4000-8000-0000000000f1';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from membership_change_log where workshop_id in (_w1, _w2);
  delete from workshop_invitation where workshop_id in (_w1, _w2);
  delete from workshop_member where workshop_id in (_w1, _w2);
  delete from app_user where email like 'tl11-%@example.org';
-- tl-12: the app_user_link_person trigger mints a person row for every account,
-- so a teardown that removes the account and stops there leaves one behind.
  delete from person where primary_email like 'tl11-%@example.org';
  delete from auth.users where email like 'tl11-%@example.org';
  delete from role_allowlist where email like 'tl11-%@example.org';
  delete from workshop where id in (_w1, _w2);

  insert into workshop (id, name, start_date, location) values
    (_w1, 'TL11 Fixture Workshop', '2027-05-01', 'Nowhere'),
    (_w2, 'TL11 Second Workshop',  '2027-06-01', 'Elsewhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note)
  select v.email, array['evaluator'], 'evaluator', 'tl-11 test fixture'
  from (values ('tl11-ca@example.org'), ('tl11-a1@example.org'),
               ('tl11-e1@example.org'), ('tl11-existing@example.org')
       ) as v(email);

  perform tl11_signup(_ca,   'tl11-ca@example.org',       'TL11 Chief Admin');
  perform tl11_signup(_a1,   'tl11-a1@example.org',       'TL11 Admin One');
  perform tl11_signup(_e1,   'tl11-e1@example.org',       'TL11 Evaluator One');
  perform tl11_signup(_exst, 'tl11-existing@example.org',  'TL11 Existing Account');

  insert into workshop_member (workshop_id, app_user_id, role)
  select _w1, u.id,
         case u.email
           when 'tl11-ca@example.org' then 'chief_admin'
           when 'tl11-a1@example.org' then 'admin'
           when 'tl11-e1@example.org' then 'evaluator'
         end
    from app_user u
   where u.email in ('tl11-ca@example.org','tl11-a1@example.org','tl11-e1@example.org');

  insert into workshop_member (workshop_id, app_user_id, role)
  select _w2, u.id, 'chief_admin' from app_user u where u.email = 'tl11-ca@example.org';

  perform tl11_assert(
    'fixtures provisioned four accounts through the real signup path',
    (select count(*) from app_user where email like 'tl11-%@example.org') = 4,
    format('%s app_user row(s)', (select count(*) from app_user where email like 'tl11-%@example.org')));
end $$;

-- ---------------------------------------------------------------------------
-- 1. Who may invite, and as what.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _w2 uuid := 'a3000000-0000-4000-8000-000000000002';
  _ca uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _a1 uuid := 'a3000000-0000-4000-8000-0000000000a1';
  _e1 uuid := 'a3000000-0000-4000-8000-0000000000e1';
begin
  perform tl11_try('permitted', 'chief admin invites an evaluator', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-newbie@example.org', 'evaluator'));

  perform tl11_try('permitted', 'chief admin invites a consultant', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-consult@example.org', 'consultant'));

  perform tl11_try('permitted', 'admin invites an evaluator', _a1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-second@example.org', 'evaluator'));

  -- The whole point of the matrix: delegating administration does not delegate
  -- control, so an admin cannot staff the workshop with another admin.
  perform tl11_try('blocked', 'admin cannot invite an admin', _a1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope@example.org', 'admin'));
  perform tl11_slug('tl02.admin_may_only_grant_evaluator', 'and says which rule refused it', _a1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope@example.org', 'admin'));

  perform tl11_try('blocked', 'admin cannot invite a consultant either', _a1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope2@example.org', 'consultant'));

  perform tl11_try('blocked', 'an evaluator cannot invite anybody', _e1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope3@example.org', 'evaluator'));
  perform tl11_slug('tl02.not_an_administrator', 'and says so', _e1,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope3@example.org', 'evaluator'));

  -- Nobody reaches chief_admin through an invitation. The check constraint on the
  -- table says the same thing structurally; can_grant gets there first, which is
  -- what makes the refusal readable.
  perform tl11_try('blocked', 'nobody can invite a chief admin', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope4@example.org', 'chief_admin'));
  perform tl11_slug('tl02.chief_admin_by_transfer_only', 'and points at transfer instead', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-nope4@example.org', 'chief_admin'));

  perform tl11_try('blocked', 'a chief admin of another workshop cannot invite into this one', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)',
           '00000000-0000-4000-8000-0000000000ff', 'tl11-nope5@example.org', 'evaluator'));

  perform tl11_try('blocked', 'a malformed address is refused before anything is written', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'not-an-email', 'evaluator'));
  perform tl11_slug('tl11.bad_email', 'and says why', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'not-an-email', 'evaluator'));

  perform tl11_try('blocked', 'the same address cannot be invited twice while one is pending', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-newbie@example.org', 'evaluator'));
  perform tl11_slug('tl11.already_invited', 'and says to withdraw the first', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-newbie@example.org', 'evaluator'));

  perform tl11_try('blocked', 'somebody already in the workshop cannot be invited to it', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-e1@example.org', 'consultant'));
  perform tl11_slug('tl11.already_a_member', 'and points at the role control instead', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-e1@example.org', 'consultant'));

  -- The second workshop, for the multi-workshop acceptance claim below.
  perform tl11_try('permitted', 'the same address can be invited to a second workshop', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w2, 'tl11-newbie@example.org', 'evaluator'));

  -- Mixed case in, lowercase stored: the address the invitation names and the
  -- address `auth.users` will hold have to be the same string or acceptance is a
  -- silent no-op.
  perform tl11_try('permitted', 'a mixed-case address is accepted', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'TL11-Mixed.Case@Example.ORG', 'evaluator'));
end $$;

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
begin
  perform tl11_assert('the mixed-case invitation was stored lowercase',
    exists (select 1 from workshop_invitation
             where workshop_id = _w1 and email = 'tl11-mixed.case@example.org'),
    coalesce((select email from workshop_invitation
               where workshop_id = _w1 and lower(email) = 'tl11-mixed.case@example.org'), '(none)'));

  -- The deviation from the spec, asserted rather than described: an invitation is
  -- ONE grant of signup, not two. If a future change re-introduces the allowlist
  -- write, this fails and the revocation drift comes back with it.
  perform tl11_assert('inviting writes nothing to role_allowlist',
    not exists (select 1 from role_allowlist where email = 'tl11-newbie@example.org'),
    format('%s allowlist row(s) for the invited address',
           (select count(*) from role_allowlist where email = 'tl11-newbie@example.org')));

  perform tl11_assert('every invitation is on the membership log',
    (select count(*) from membership_change_log where workshop_id = _w1 and operation = 'invite') = 4,
    format('%s invite row(s)',
           (select count(*) from membership_change_log where workshop_id = _w1 and operation = 'invite')));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Inviting an address that already has an account is a grant, not a wait.
--
--    This is the case tl-02 could not reach from a browser at all: its RPCs take
--    an `app_user_id`, and `app_user_select` hides anybody you do not already
--    share a workshop with, so the client could not resolve the id.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _ca uuid := 'a3000000-0000-4000-8000-0000000000c1';
begin
  perform tl11_try('permitted', 'inviting an existing account adds it immediately', _ca,
    format('select invite_to_workshop(%L::uuid, %L, %L)', _w1, 'tl11-existing@example.org', 'evaluator'));

  perform tl11_assert('the existing account is a member now, not pending',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where wm.workshop_id = _w1 and u.email = 'tl11-existing@example.org'
               and wm.role = 'evaluator'),
    'membership present');

  perform tl11_assert('and its invitation is recorded as accepted on the spot',
    exists (select 1 from workshop_invitation
             where workshop_id = _w1 and email = 'tl11-existing@example.org'
               and status = 'accepted' and accepted_at is not null),
    coalesce((select status from workshop_invitation
               where workshop_id = _w1 and email = 'tl11-existing@example.org'), '(none)'));

  perform tl11_assert('an immediate add is logged as a grant, not an invite',
    exists (select 1 from membership_change_log
             where workshop_id = _w1 and operation = 'grant'
               and target_email = 'tl11-existing@example.org'),
    'grant row present');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Acceptance on first sign-in.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _w2 uuid := 'a3000000-0000-4000-8000-000000000002';
begin
  -- No allowlist row for this address at all. Before tl-11 this signup was refused.
  perform tl11_owner('permitted', 'an invited address with no allowlist row can sign up',
    format('select tl11_signup(%L::uuid, %L, %L)',
           'a3000000-0000-4000-8000-0000000000b1', 'tl11-newbie@example.org', 'TL11 Newbie'));

  perform tl11_assert('signing up produced the membership the invitation named',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where wm.workshop_id = _w1 and u.email = 'tl11-newbie@example.org'
               and wm.role = 'evaluator'),
    'W1 membership present');

  -- The multi-workshop claim: two pending invitations, one signup, both land.
  perform tl11_assert('and the second workshop it was invited to as well',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where wm.workshop_id = _w2 and u.email = 'tl11-newbie@example.org'),
    'W2 membership present');

  perform tl11_assert('both invitations are marked accepted',
    (select count(*) from workshop_invitation
      where email = 'tl11-newbie@example.org' and status = 'accepted') = 2,
    format('%s accepted', (select count(*) from workshop_invitation
                            where email = 'tl11-newbie@example.org' and status = 'accepted')));

  perform tl11_assert('acceptance is on the membership log as a grant',
    (select count(*) from membership_change_log
      where target_email = 'tl11-newbie@example.org' and operation = 'grant') = 2,
    'two grant rows');

  -- Normalization end to end: invited as TL11-Mixed.Case@Example.ORG, signs up
  -- lowercase. `auth.users` stores lowercase, so an unnormalized invitation would
  -- sit pending forever while the person lands in no workshop at all.
  perform tl11_owner('permitted', 'a mixed-case invitation matches a lowercase signup',
    format('select tl11_signup(%L::uuid, %L, %L)',
           'a3000000-0000-4000-8000-0000000000b2', 'tl11-mixed.case@example.org', 'TL11 Mixed Case'));

  perform tl11_assert('and that person is in the workshop',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where wm.workshop_id = _w1 and u.email = 'tl11-mixed.case@example.org'),
    'membership present');

  -- The gate still holds for everybody else.
  perform tl11_owner('blocked', 'an address with neither an invitation nor an allowlist row cannot sign up',
    format('select tl11_signup(%L::uuid, %L, %L)',
           'a3000000-0000-4000-8000-0000000000b3', 'tl11-stranger@example.org', 'TL11 Stranger'),
    'has not been invited');

  perform tl11_assert('and no orphan account was left behind by the refusal',
    not exists (select 1 from auth.users where email = 'tl11-stranger@example.org')
    and not exists (select 1 from app_user where email = 'tl11-stranger@example.org'),
    'no auth.users or app_user row');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Revocation, and its teeth.
--
--    The bug a reviewer looks for first: a withdrawn invitation that still lets
--    the person create an account. There is only one grant to take back here, so
--    the test is whether taking it back actually closes the door.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _ca uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _a1 uuid := 'a3000000-0000-4000-8000-0000000000a1';
  _e1 uuid := 'a3000000-0000-4000-8000-0000000000e1';
  _consult uuid;
  _second  uuid;
begin
  select id into _consult from workshop_invitation
   where workshop_id = _w1 and email = 'tl11-consult@example.org' and status = 'pending';
  select id into _second from workshop_invitation
   where workshop_id = _w1 and email = 'tl11-second@example.org' and status = 'pending';

  perform tl11_try('blocked', 'an admin cannot withdraw a consultant invitation', _a1,
    format('select revoke_invitation(%L::uuid)', _consult));
  perform tl11_slug('tl02.admin_may_only_grant_evaluator', 'and says which rule refused it', _a1,
    format('select revoke_invitation(%L::uuid)', _consult));

  perform tl11_try('blocked', 'an evaluator cannot withdraw anything', _e1,
    format('select revoke_invitation(%L::uuid)', _second));

  perform tl11_try('permitted', 'an admin can withdraw the evaluator invitation they issued', _a1,
    format('select revoke_invitation(%L::uuid)', _second));

  perform tl11_try('blocked', 'and cannot withdraw it twice', _a1,
    format('select revoke_invitation(%L::uuid)', _second));
  perform tl11_slug('tl11.not_pending', 'because it is no longer pending', _a1,
    format('select revoke_invitation(%L::uuid)', _second));

  perform tl11_try('permitted', 'a chief admin can withdraw the consultant invitation', _ca,
    format('select revoke_invitation(%L::uuid)', _consult));
end $$;

do $$
begin
  -- The claim the whole design turns on.
  perform tl11_owner('blocked', 'a withdrawn invitation no longer lets that address sign up',
    format('select tl11_signup(%L::uuid, %L, %L)',
           'a3000000-0000-4000-8000-0000000000b4', 'tl11-second@example.org', 'TL11 Withdrawn'),
    'has not been invited');

  perform tl11_assert('withdrawal is on the membership log',
    (select count(*) from membership_change_log where operation = 'uninvite'
      and target_email in ('tl11-second@example.org', 'tl11-consult@example.org')) = 2,
    format('%s uninvite row(s)',
           (select count(*) from membership_change_log where operation = 'uninvite'
             and target_email in ('tl11-second@example.org', 'tl11-consult@example.org'))));
end $$;

-- ---------------------------------------------------------------------------
-- 5. The table itself: who may read it, and who may write it directly.
--
--    Every write in this spec is a decision the server makes, so the answer to
--    the second question is nobody. `workshop_invitation` has a select policy and
--    no others, and the grants are revoked as well — a policy alone would leave
--    the table writable the day somebody adds one.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _ca uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _a1 uuid := 'a3000000-0000-4000-8000-0000000000a1';
  _e1 uuid := 'a3000000-0000-4000-8000-0000000000e1';
  _any uuid;
begin
  select id into _any from workshop_invitation where workshop_id = _w1 limit 1;

  perform tl11_try('permitted', 'a chief admin reads their workshop''s invitations', _ca,
    format('select 1 from workshop_invitation where workshop_id = %L::uuid', _w1));
  perform tl11_try('permitted', 'an admin reads them too', _a1,
    format('select 1 from workshop_invitation where workshop_id = %L::uuid', _w1));

  -- An evaluator is a member of this workshop and still sees nothing: who has been
  -- invited is an administrator's question, and RLS answers it as zero rows.
  perform tl11_try('blocked', 'an evaluator in the workshop sees no invitations', _e1,
    format('select 1 from workshop_invitation where workshop_id = %L::uuid', _w1));

  perform tl11_try('blocked', 'an anonymous session sees none', null,
    format('select 1 from workshop_invitation where workshop_id = %L::uuid', _w1));

  perform tl11_try('blocked', 'a chief admin cannot insert an invitation directly', _ca,
    format('insert into workshop_invitation (workshop_id, email, role) values (%L::uuid, %L, %L)',
           _w1, 'tl11-direct@example.org', 'admin'));

  perform tl11_try('blocked', 'nor flip one back to pending after withdrawing it', _ca,
    format('update workshop_invitation set status = %L where id = %L::uuid', 'pending', _any));

  perform tl11_try('blocked', 'nor delete one to erase the record', _ca,
    format('delete from workshop_invitation where id = %L::uuid', _any));

  -- role_allowlist stays what it was: unreadable and unwritable from any session.
  perform tl11_try('blocked', 'the allowlist is still invisible to a chief admin', _ca,
    'select 1 from role_allowlist');
end $$;

-- ---------------------------------------------------------------------------
-- 6. The sign-up admission queue.
--
--    The claim is arithmetic over a shared, deployment-wide budget, so it is
--    tested by setting the budget to a known number and inviting more people than
--    it allows. The fixture budget is restored at the end; a harness that left the
--    live deployment metering at 3 an hour would be worse than no harness.
-- ---------------------------------------------------------------------------

do $$
declare
  _w1  uuid := 'a3000000-0000-4000-8000-000000000001';
  _ca  uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _e1  uuid := 'a3000000-0000-4000-8000-0000000000e1';
  _prior jsonb;
  _hours numeric[];
begin
  select value into _prior from platform_setting where key = 'signup_budget_per_hour';

  -- A budget of 2, and five fresh invitations. Existing pending rows from the
  -- sections above occupy windows too, which is the point: the queue is
  -- deployment-wide and this counts them.
  update platform_setting set value = to_jsonb(2) where key = 'signup_budget_per_hour';
  perform tl11_assert('the budget reads back as it was set',
    signup_budget_per_hour() = 2, format('%s per hour', signup_budget_per_hour()));

  delete from workshop_invitation where email like 'tl11-queue-%';

  perform invite_to_workshop(_w1, 'tl11-queue-1@example.org', 'evaluator');
  perform invite_to_workshop(_w1, 'tl11-queue-2@example.org', 'evaluator');
  perform invite_to_workshop(_w1, 'tl11-queue-3@example.org', 'evaluator');
  perform invite_to_workshop(_w1, 'tl11-queue-4@example.org', 'evaluator');
  perform invite_to_workshop(_w1, 'tl11-queue-5@example.org', 'evaluator');

  -- No hour anywhere in the deployment may hold more than the budget.
  select array_agg(n) into _hours from (
    select count(*) as n from workshop_invitation
     where status = 'pending' group by date_trunc('hour', opens_at)) c;
  perform tl11_assert('no hour is scheduled above the budget',
    (select bool_and(n <= 2) from unnest(_hours) as n),
    format('per-hour counts: %s', _hours));

  perform tl11_assert('five invitations were spread over more than one hour',
    (select count(distinct date_trunc('hour', opens_at)) from workshop_invitation
      where email like 'tl11-queue-%') > 1,
    format('%s distinct hour(s)',
      (select count(distinct date_trunc('hour', opens_at)) from workshop_invitation
        where email like 'tl11-queue-%')));

  perform tl11_assert('no window is in the past',
    not exists (select 1 from workshop_invitation
                 where email like 'tl11-queue-%' and opens_at < date_trunc('hour', now())),
    'all windows are now or later');

  -- An address that already has an account is added outright, creates no signup,
  -- and so must consume no window at all.
  perform tl11_assert('adding an existing account took no window',
    (select opens_at <= now() from workshop_invitation
      where email = 'tl11-existing@example.org'),
    'immediate');

  -- The anonymous check: a wait for an address it holds, and NOTHING for one it
  -- does not. The second assertion is the privacy claim, not a nicety.
  perform tl11_assert('the anonymous check reports a wait for a queued address',
    (invitation_window('tl11-queue-5@example.org')->>'status') = 'waiting',
    invitation_window('tl11-queue-5@example.org')::text);

  perform tl11_assert('and says open for an address it is holding nothing for',
    (invitation_window('tl11-nobody-at-all@example.org')->>'status') = 'open',
    invitation_window('tl11-nobody-at-all@example.org')::text);

  perform tl11_assert('and is case-insensitive, like every other address path here',
    (invitation_window('TL11-Queue-5@Example.ORG')->>'status') = 'waiting',
    invitation_window('TL11-Queue-5@Example.ORG')::text);

  -- Raising the budget must open windows for invitations issued from then on.
  update platform_setting set value = to_jsonb(100) where key = 'signup_budget_per_hour';
  perform invite_to_workshop(_w1, 'tl11-queue-6@example.org', 'evaluator');
  perform tl11_assert('raising the budget opens the next window immediately',
    (select opens_at <= now() + interval '1 minute' from workshop_invitation
      where email = 'tl11-queue-6@example.org'),
    'immediate');

  update platform_setting set value = coalesce(_prior, to_jsonb(2)) where key = 'signup_budget_per_hour';
  perform tl11_assert('the harness restored the deployment budget it found',
    (select value from platform_setting where key = 'signup_budget_per_hour') = coalesce(_prior, to_jsonb(2)),
    (select value::text from platform_setting where key = 'signup_budget_per_hour'));
end $$;

do $$
declare
  _ca uuid := 'a3000000-0000-4000-8000-0000000000c1';
  _e1 uuid := 'a3000000-0000-4000-8000-0000000000e1';
begin
  -- The budget is a platform power, not a workshop one: an admin of one workshop
  -- must not be able to widen a budget every other workshop draws on.
  perform tl11_try('blocked', 'a chief admin cannot change the deployment budget', _ca,
    'select set_platform_setting(''signup_budget_per_hour'', to_jsonb(50))');
  perform tl11_slug('tl11.platform_owner_only', 'and is told it is the deployment owner''s', _ca,
    'select set_platform_setting(''signup_budget_per_hour'', to_jsonb(50))');

  perform tl11_try('blocked', 'nor write the settings table directly', _ca,
    'update platform_setting set value = to_jsonb(50) where key = ''signup_budget_per_hour''');

  perform tl11_try('blocked', 'nor invent a setting', _ca,
    'select set_platform_setting(''disable_everything'', to_jsonb(true))');

  -- Readable, though: an administrator has to be able to see why somebody waits.
  perform tl11_try('permitted', 'an evaluator can read the budget', _e1,
    'select 1 from platform_setting where key = ''signup_budget_per_hour''');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Report.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome from tl11_results order by seq;
select
  count(*) filter (where verdict = 'PASS') as passed,
  count(*) filter (where verdict = 'FAIL') as failed,
  count(*)                                  as total
from tl11_results;
