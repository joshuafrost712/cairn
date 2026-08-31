-- tl-38 acceptance clauses 1 and 2: who may read the briefing, and what a refusal does.
--
--   node scripts/apply-migration.mjs scripts/tl38-health-rls.sql
--
-- Shape borrowed from scripts/tl30-verify.sql, including its hardest-won lesson:
-- a blocked case that returns nothing for the WRONG reason is a false green. That
-- lesson bites differently here. `workshop_health` is `security definer`, so RLS
-- is not filtering anything and a refusal is an exception rather than zero rows.
-- The danger is the mirror image: a function that refuses EVERYBODY would pass a
-- file that only asserted refusals, and one that refuses NOBODY would pass a file
-- that only asserted successes. So both directions run here, in one file, and
-- neither verdict is reported without the other.
--
-- THE SHARPEST TEST IN THE FILE is not evaluator-versus-admin. It is
-- `tl38-otherws`, an administrator of the OTHER live workshop asking about this one.
-- `has_workshop_role` takes a workshop id, so the wrong implementation is not one
-- that forgets to check a role, it is one that asks whether the caller holds that
-- role ANYWHERE. Every real chief on this project is a chief on both workshops,
-- so no real account can tell those two implementations apart and a fixture must.
--
-- Groups:
--   A. REAL ACCOUNTS on the live Psalms workshop. Joshua (chief_admin), Katie
--      (chief_evaluator) and Angie (evaluator) are the actual configuration
--      rather than a model of it.
--   B. FIXTURES for the shapes no live account holds: the `admin` arm of the role
--      array, a signed-in non-member, and the cross-workshop administrator.
--   C. STATE. The grants, and the payload's own shape.
--
-- Read-only with respect to real data. The only rows it writes are its own
-- fixtures, prefixed `tl38-`, deleted at the bottom of this same file on that
-- prefix alone. It never truncates a table.

-- TEMP, in `pg_temp` rather than `public`, and that is a fix rather than a style
-- choice. The first version of this file created a real table in `public` and
-- never dropped it. Supabase grants all privileges on `public` to `anon` by
-- default and a bare `create table` has RLS off, so a scratch table of test
-- verdicts became an unauthenticated read AND write endpoint on the deployed
-- project, reachable by anyone holding the anon key that ships inside the client
-- bundle. The teardown at the bottom removed every fixture ROW and left the table
-- itself, and the file's own header still claimed it wrote nothing but fixtures.
-- A temp table cannot outlive the session that made it, which is the property
-- this always wanted. Two older harnesses left the same object behind
-- (`tl30_results`, `tl26_teardown_log`); both now have RLS enabled with no
-- policies, so they are readable by nobody but `postgres`.
drop table if exists tl38_results;
create temp table tl38_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl38_try(text, text, uuid, text);
create or replace function tl38_try(_expect text, _label text, _uid uuid, _sql text)
returns void
language plpgsql
as $$
declare
  _count   bigint;
  _outcome text;
  _errored boolean := false;
begin
  if _uid is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
                       json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  end if;
  begin
    execute _sql;
    get diagnostics _count = row_count;
    _outcome := format('%s row(s)', _count);
  exception when others then
    _errored := true;
    _count := 0;
    _outcome := format('error [%s] %s', sqlstate, sqlerrm);
  end;
  reset role;

  insert into tl38_results (verdict, expect, label, outcome)
  values (case
            when _expect = 'blocked' then case when _errored or _count = 0 then 'PASS' else 'FAIL' end
            else case when not _errored and _count > 0 then 'PASS' else 'FAIL' end
          end,
          _expect, _label, _outcome);
end $$;

-- The refusal must RAISE, not return an empty report. `tl38_try` would score a
-- raised exception and a zero-filled payload identically, and the difference is
-- the whole reason this spec exists: a health surface that answers a refusal with
-- zeros tells an unauthorized reader the workshop is fine.
drop function if exists tl38_raises(text, uuid, text, text);
create or replace function tl38_raises(_label text, _uid uuid, _sql text, _expect_slug text)
returns void
language plpgsql
as $$
declare
  _msg text;
begin
  if _uid is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
                       json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  end if;
  begin
    execute _sql;
    reset role;
    insert into tl38_results (verdict, expect, label, outcome)
    values ('FAIL', 'raises', _label, 'the statement succeeded, so a refusal returned data');
    return;
  exception when others then
    _msg := sqlerrm;
  end;
  reset role;
  insert into tl38_results (verdict, expect, label, outcome)
  values (case when _msg like '%' || _expect_slug || '%' then 'PASS' else 'FAIL' end,
          'raises', _label, _msg);
end $$;

drop function if exists tl38_assert(text, boolean, text);
create or replace function tl38_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl38_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures. Three accounts, all prefixed tl38-, all removed at the bottom.
-- ---------------------------------------------------------------------------

-- Provisioned through tl-11's real invite-only path rather than by writing the
-- rows directly: `handle_new_user()` refuses an uninvited signup, and it is the
-- trigger that creates `app_user` and `workshop_member` from the invitation. A
-- fixture that bypassed it would be testing a shape the app cannot produce.
do $$
declare
  _psalms  uuid := '11111111-1111-1111-1111-111111111111';
  _cc      uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _admin   uuid := gen_random_uuid();
  _out     uuid := gen_random_uuid();
  _other   uuid := gen_random_uuid();
  _joshapp uuid;
begin
  select id into _joshapp from app_user where email = 'josh_frost@sil.org';

  insert into workshop_invitation (workshop_id, email, role, invited_by, invited_by_email, status)
  values (_psalms, 'tl38-admin@example.org',   'admin',        _joshapp, 'josh_frost@sil.org', 'pending'),
         -- Invited to the Crash Course only. The membership this creates is what
         -- makes B3 a real question rather than a second outsider test.
         -- `admin` rather than `chief_admin`: tl-02 deliberately forbids inviting
         -- straight to chief, and an admin of the other workshop asks this test's
         -- question just as sharply.
         (_cc,     'tl38-otherws@example.org', 'admin',        _joshapp, 'josh_frost@sil.org', 'pending'),
         -- Invited so the signup is permitted at all; the membership it creates
         -- is deleted immediately below, leaving a signed-in account that belongs
         -- to no workshop. That is a real state: an invitation revoked after
         -- signup produces exactly it.
         (_cc,     'tl38-outsider@example.org', 'evaluator',   _joshapp, 'josh_frost@sil.org', 'pending');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl38-admin@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL38 Admin"}'::jsonb, now(), now()),
         (_out, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl38-outsider@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL38 Outsider"}'::jsonb, now(), now()),
         (_other, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl38-otherws@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL38 Other Workshop Chief"}'::jsonb, now(), now());

  delete from workshop_member
   where app_user_id = (select id from app_user where email = 'tl38-outsider@example.org');
end $$;

-- The fixtures are asserted before they are used. A membership the trigger did
-- not create the way this file assumes would otherwise turn every result below
-- into a statement about nothing.
do $$
declare
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _cc     uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
begin
  perform tl38_assert('F1 tl38-admin holds admin on Psalms and nothing else',
    (select array_agg(wm.workshop_id::text || ':' || wm.role) from workshop_member wm
      join app_user u on u.id = wm.app_user_id where u.email = 'tl38-admin@example.org')
    = array[_psalms::text || ':admin'],
    coalesce((select string_agg(wm.workshop_id::text || ':' || wm.role, ', ') from workshop_member wm
      join app_user u on u.id = wm.app_user_id where u.email = 'tl38-admin@example.org'), 'none'));
  perform tl38_assert('F2 tl38-otherws holds admin on the Crash Course only',
    (select array_agg(wm.workshop_id::text || ':' || wm.role) from workshop_member wm
      join app_user u on u.id = wm.app_user_id where u.email = 'tl38-otherws@example.org')
    = array[_cc::text || ':admin'],
    coalesce((select string_agg(wm.workshop_id::text || ':' || wm.role, ', ') from workshop_member wm
      join app_user u on u.id = wm.app_user_id where u.email = 'tl38-otherws@example.org'), 'none'));
  perform tl38_assert('F3 tl38-outsider holds no membership anywhere',
    not exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
                 where u.email = 'tl38-outsider@example.org'),
    'a signed-in account with nothing');
end $$;

-- ---------------------------------------------------------------------------
-- A. REAL ACCOUNTS on the live Psalms workshop.
-- ---------------------------------------------------------------------------

do $$
declare
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _josh   uuid := '3aea7d0d-133b-43ee-b5d0-a7a80374a87f';  -- chief_admin
  _katie  uuid := '43bd8e1d-4fcc-4f3f-9d94-b0c013a47413';  -- chief_evaluator
  _angie  uuid := '8fe77019-d115-44d2-84c9-eebf046ed0b6';  -- evaluator
  _populated text := format(
    'select 1 from (select workshop_health(%L::uuid) as h) t
       where t.h ? ''volume'' and t.h ? ''pipeline'' and t.h ? ''coverage''
         and (t.h->''volume''->>''captures'')::int > 0', _psalms);
  _call text := format('select workshop_health(%L::uuid)', _psalms);
begin
  perform tl38_try('allowed', 'A1 chief_admin (Joshua) reads a populated report', _josh, _populated);
  perform tl38_try('allowed', 'A2 chief_evaluator (Katie) reads a populated report', _katie, _populated);
  perform tl38_raises('A3 evaluator (Angie) is refused, and it raises', _angie, _call,
                      'tl38.not_permitted_for_this_workshop');
  -- The both-directions pair the acceptance clause asks for is A1/A2 against A3:
  -- asserting only A3 would pass against a function that refuses everybody, and
  -- asserting only A1 would pass against one that refuses nobody.
end $$;

-- ---------------------------------------------------------------------------
-- B. FIXTURES for the shapes no live account holds.
-- ---------------------------------------------------------------------------

do $$
declare
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _admin  uuid;
  _out    uuid;
  _other  uuid;
  _populated text := format(
    'select 1 from (select workshop_health(%L::uuid) as h) t
       where t.h ? ''volume'' and (t.h->''volume''->>''captures'')::int > 0', _psalms);
  _call text := format('select workshop_health(%L::uuid)', _psalms);
begin
  select auth_user_id into _admin from app_user where email = 'tl38-admin@example.org';
  select auth_user_id into _out   from app_user where email = 'tl38-outsider@example.org';
  select auth_user_id into _other from app_user where email = 'tl38-otherws@example.org';

  perform tl38_try('allowed', 'B1 the admin arm of the role array is permitted', _admin, _populated);
  perform tl38_raises('B2 a signed-in non-member is refused (clause 2)', _out, _call,
                      'tl38.not_permitted_for_this_workshop');
  perform tl38_raises('B3 an admin of the OTHER workshop is refused for this one', _other, _call,
                      'tl38.not_permitted_for_this_workshop');
  perform tl38_raises('B4 no JWT at all is refused', null, _call,
                      'tl38.not_permitted_for_this_workshop');
end $$;

-- ---------------------------------------------------------------------------
-- C. STATE. Grants, and the payload's own shape.
-- ---------------------------------------------------------------------------

do $$
declare
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _josh   uuid := '3aea7d0d-133b-43ee-b5d0-a7a80374a87f';
  _h      jsonb;
  _raw    text;
begin
  perform tl38_assert('C1 anon holds no execute grant',
    not has_function_privilege('anon', 'public.workshop_health(uuid, integer)', 'execute'),
    'revoking from public alone would leave this true only by accident');
  perform tl38_assert('C2 authenticated holds the execute grant',
    has_function_privilege('authenticated', 'public.workshop_health(uuid, integer)', 'execute'),
    'the app calls this as the signed-in user');
  perform tl38_assert('C3 the function is security definer',
    (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'workshop_health'),
    'it must read rows the caller''s RLS would filter');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
  _h := workshop_health(_psalms);
  reset role;
  _raw := _h::text;

  perform tl38_assert('C4 every top-level section is present',
    _h ?& array['workshop','generated_at','stale_hours','volume','pipeline','coverage','by_goal'],
    left(_raw, 120));
  perform tl38_assert('C5 the stale_hours default is 24',
    (_h->>'stale_hours')::int = 24, _h->>'stale_hours');
  perform tl38_assert('C6 unresolved_scope_names is capped at 20',
    jsonb_array_length(_h->'coverage'->'unresolved_scope_names') <= 20,
    (jsonb_array_length(_h->'coverage'->'unresolved_scope_names'))::text);

  -- Clause 3, asserted in SQL as well as in the parity harness, because this is
  -- the guarantee the whole spec was shaped around and one assertion of it is not
  -- enough. Every observation's text and excerpt, and every capture's source_text
  -- and answer value, must be absent from the payload.
  perform tl38_assert('C7 no observation text appears in the payload',
    not exists (
      select 1 from observation
      where workshop_id = _psalms and length(btrim(text)) > 20
        and strpos(_raw, btrim(substring(text from 1 for 30))) > 0),
    'checked every observation on this workshop');
  perform tl38_assert('C8 no observation source_excerpt appears in the payload',
    not exists (
      select 1 from observation
      where workshop_id = _psalms and length(btrim(source_excerpt)) > 20
        and strpos(_raw, btrim(substring(source_excerpt from 1 for 30))) > 0),
    'checked every observation on this workshop');
  perform tl38_assert('C9 no capture source_text appears in the payload',
    not exists (
      select 1 from evaluation
      where workshop_id = _psalms and length(btrim(coalesce(source_text, ''))) > 20
        and strpos(_raw, btrim(substring(source_text from 1 for 30))) > 0),
    'checked every capture on this workshop, submitted and not');
  perform tl38_assert('C10 no capture answer text appears in the payload',
    not exists (
      select 1 from evaluation e, lateral jsonb_each_text(e.answers) je(k, v)
      where e.workshop_id = _psalms and length(btrim(v)) > 20
        and strpos(_raw, btrim(substring(v from 1 for 30))) > 0),
    'checked every answer on this workshop, submitted and not');
end $$;

-- ---------------------------------------------------------------------------
-- Teardown, on the prefix alone.
-- ---------------------------------------------------------------------------

delete from workshop_member
 where app_user_id in (select id from app_user where email like 'tl38-%@example.org');
delete from workshop_invitation where email like 'tl38-%@example.org';
delete from app_user where email like 'tl38-%@example.org';
delete from auth.users where email like 'tl38-%@example.org';

drop function if exists tl38_try(text, text, uuid, text);
drop function if exists tl38_raises(text, uuid, text, text);
drop function if exists tl38_assert(text, boolean, text);

select verdict, label, outcome from tl38_results order by seq;
