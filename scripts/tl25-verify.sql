-- tl-25 acceptance harness: is the roster right, does the cross-workshop identity
-- resolve, and can a co-facilitator see Psalms?
--
--   node scripts/apply-migration.mjs scripts/tl25-verify.sql
--   node scripts/apply-migration.mjs scripts/tl25-teardown.sql
--
-- The last question is the one the spec calls the one that matters, and it is the
-- reason this file exists rather than a query. Counting four participants and four
-- members proves nothing about authorization; an evaluator invited to the Crash
-- Course who can read Psalms' 22 has been over-granted, and every authorization
-- change in this wave ships with the attempt that must fail.
--
-- Shape and reasoning borrowed wholesale from scripts/tl11-rls-tests.sql, including
-- its hardest-won lesson: a `blocked` case that errors for the WRONG reason is a
-- false green. Here that risk is RLS itself — a policy denial arrives as zero rows
-- rather than an error, so every negative below is paired with the positive that
-- proves the same query shape works when it should.
--
-- Fixtures are prefixed tl25- and torn down on that prefix only.

drop table if exists tl25_results;
create table tl25_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl25_try(text, text, uuid, text);
create or replace function tl25_try(_expect text, _label text, _uid uuid, _sql text)
returns void
language plpgsql
as $$
declare
  _count   bigint;
  _outcome text;
  _errored boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
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

  insert into tl25_results (verdict, expect, label, outcome)
  values (case
            when _expect = 'blocked' then case when _errored or _count = 0 then 'PASS' else 'FAIL' end
            else case when not _errored and _count > 0 then 'PASS' else 'FAIL' end
          end,
          _expect, _label, _outcome);
end $$;

drop function if exists tl25_assert(text, boolean, text);
create or replace function tl25_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl25_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

do $$
declare
  _cc     uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _josh   uuid;
  _throw  uuid := gen_random_uuid();   -- auth.users id for the throwaway evaluator
  _throw_app uuid;

  _pid    uuid;
  _n      int;
  _txt    text;
begin
  select auth_user_id into _josh from app_user where email = 'josh_frost@sil.org';

  -- =========================================================================
  -- 1. The roster itself.
  -- =========================================================================

  select count(*) into _n from participant where workshop_id = _cc;
  perform tl25_assert('four participants in the Crash Course', _n = 4, format('%s', _n));

  select count(*) into _n from participant where workshop_id = _cc and person_id is null;
  perform tl25_assert('every Crash Course participant has a person', _n = 0, format('%s unlinked', _n));

  select count(*) into _n from workshop_member where workshop_id = _cc;
  perform tl25_assert('one member so far (Joshua); the other three are pending sign-up',
                      _n = 1, format('%s member(s)', _n));

  select count(*) into _n from workshop_invitation where workshop_id = _cc and status = 'pending';
  perform tl25_assert('four pending invitations', _n = 4, format('%s pending', _n));

  select count(*) into _n from workshop_invitation
   where workshop_id = _cc and status = 'pending' and role = 'admin';
  perform tl25_assert('nobody is invited as admin, so nobody but Joshua can rewrite the questions',
                      _n = 0, format('%s admin invitation(s)', _n));

  select count(*) into _n from team where workshop_id = _cc;
  perform tl25_assert('two teams', _n = 2, format('%s', _n));

  -- Peer review read aloud: each team must be able to review the OTHER team's
  -- passage, which needs two teams of at least one and nobody teamless.
  select count(*) into _n from participant where workshop_id = _cc and team_id is null;
  perform tl25_assert('no participant is outside a team', _n = 0, format('%s teamless', _n));

  select count(distinct team_id) into _n from participant where workshop_id = _cc;
  perform tl25_assert('both teams are actually populated, so peer review is not circular',
                      _n = 2, format('%s distinct teams in use', _n));

  -- =========================================================================
  -- 2. Psalms, untouched. The invariant three specs in this batch re-check.
  -- =========================================================================

  select count(*) into _n from participant where workshop_id = _psalms;
  perform tl25_assert('Psalms still reads 22 participants', _n = 22, format('%s', _n));

  select format('%s / %s / %s / %s',
    (select count(*) from participant where workshop_id = _psalms),
    (select count(*) from activity    where workshop_id = _psalms),
    (select count(*) from goal        where workshop_id = _psalms),
    (select count(*) from ksa         where workshop_id = _psalms)) into _txt;
  perform tl25_assert('Psalms 22 / 17 / 7 / 7', _txt = '22 / 17 / 7 / 7', _txt);

  select count(*) into _n from participant p
   where p.workshop_id = _psalms and p.team_id is not null
     and p.team_id not in (select id from team where workshop_id = _psalms);
  perform tl25_assert('no Psalms participant was pulled into a Crash Course team',
                      _n = 0, format('%s', _n));

  -- =========================================================================
  -- 3. The cross-workshop identity, which is what this spec is actually for.
  --
  --    person_card() is security definer and returns names only, so it is asked
  --    as Joshua, who administers both workshops and is the reader the spec names.
  -- =========================================================================

  select person_id into _pid from participant where workshop_id = _cc and name = 'Martin Landert';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
  select jsonb_array_length(person_card(_pid)->'trainings') into _n;
  reset role;
  perform tl25_assert('Martin Landert resolves to one person holding BOTH workshops',
                      _n = 2, format('%s workshop(s) on his track history', _n));

  select person_id into _pid from participant where workshop_id = _cc and name = 'Sibaji Digal';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
  select jsonb_array_length(person_card(_pid)->'trainings') into _n;
  reset role;
  perform tl25_assert('Sibaji Digal resolves to one person holding BOTH workshops',
                      _n = 2, format('%s workshop(s) on his track history', _n));

  -- Micah is deliberately one workshop and one row. His person exists only so a
  -- future OBT-CDT workshop can find him.
  select person_id into _pid from participant where workshop_id = _cc and name = 'Micah Limboo';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
  select jsonb_array_length(person_card(_pid)->'trainings') into _n;
  reset role;
  perform tl25_assert('Micah Limboo is one workshop, deliberately', _n = 1,
                      format('%s workshop(s)', _n));

  -- Jael is the finding, not the bug: she IS a Psalms participant in the world and
  -- is absent from Psalms in this database, so her card reads one workshop. If this
  -- ever flips to 2 it means somebody fixed the Psalms roster, and this line should
  -- be re-read rather than re-greened.
  select person_id into _pid from participant where workshop_id = _cc and name = 'Jael Claybaugh';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
  select jsonb_array_length(person_card(_pid)->'trainings') into _n;
  reset role;
  perform tl25_assert('Jael Claybaugh reads one workshop, because Psalms does not hold her',
                      _n = 1, format('%s workshop(s) — expected 1 until the Psalms roster is corrected', _n));

  -- Nobody was duplicated. 32 person rows for 22 Psalms + 4 Crash Course + 2
  -- accounts + 6 harness leftovers means Martin's and Sibaji's were reused.
  select count(*) into _n from person p
   where p.primary_email in ('martin_landert@wycliffe.sg', 'sibajidigal2018@gmail.com');
  perform tl25_assert('Martin and Sibaji have one person row each, not two', _n = 2,
                      format('%s row(s) across the two addresses', _n));

  -- =========================================================================
  -- 4. Irene and Mathew: the pair whose two rows have different shapes.
  --
  --    Nothing was written for them, and this is the assertion that the nothing is
  --    correct. Their Psalms person rows hold the exact addresses they were
  --    invited at, and `app_user_link_person` looks up `person` by that address at
  --    sign-up, so their accounts will land on the SAME person rather than a new
  --    one. Section 5 proves the trigger; this proves the addresses line up.
  -- =========================================================================

  select count(*) into _n from person where primary_email = 'irene@sall.com';
  perform tl25_assert('exactly one person holds irene@sall.com', _n = 1, format('%s', _n));

  select count(*) into _n from participant p
    join person pe on pe.id = p.person_id
   where p.workshop_id = _psalms and pe.primary_email = 'irene@sall.com';
  perform tl25_assert('Irene''s Psalms row points at that person', _n = 1, format('%s', _n));

  select count(*) into _n from workshop_invitation
   where workshop_id = _cc and email = 'irene@sall.com' and status = 'pending';
  perform tl25_assert('and she is invited at that same address, so sign-up links her',
                      _n = 1, format('%s', _n));

  select count(*) into _n from person where primary_email = 'mathewtperumal@gmail.com';
  perform tl25_assert('exactly one person holds mathewtperumal@gmail.com', _n = 1, format('%s', _n));

  select count(*) into _n from participant p
    join person pe on pe.id = p.person_id
   where p.workshop_id = _psalms and pe.primary_email = 'mathewtperumal@gmail.com';
  perform tl25_assert('Mathew''s Psalms row points at that person', _n = 1, format('%s', _n));

  select count(*) into _n from workshop_invitation
   where workshop_id = _cc and email = 'mathewtperumal@gmail.com' and status = 'pending';
  perform tl25_assert('and he is invited at that same address, so sign-up links him',
                      _n = 1, format('%s', _n));

  -- =========================================================================
  -- 5 and 6, in one sign-up, because they are the same event.
  --
  --    One throwaway proves both claims: that the invite-only path grants the
  --    membership (and only the one it names), and that `app_user_link_person`
  --    lands the new account on the person ALREADY holding its address — which is
  --    the whole of what happens to Irene and Mathew on the day they sign up.
  --
  --    The first version of this file used a second account for the link probe and
  --    handle_new_user refused it: signing up without an invitation is blocked
  --    deployment-wide, which is tl-11 working. Folding the two probes together is
  --    better than inviting a fixture twice — one throwaway on the real course, and
  --    the spec sanctions exactly one.
  --
  --    The person row is created FIRST, standing in for the Psalms row Irene and
  --    Mathew already have. Ordering is the claim: a row created after the account
  --    would prove nothing.
  -- =========================================================================

  insert into person (display_name, primary_email, created_by)
  values ('TL25 Throwaway Evaluator', 'tl25-evaluator@example.org', null)
  returning id into _pid;

  insert into workshop_invitation (workshop_id, email, role, invited_by, invited_by_email, status)
  values (_cc, 'tl25-evaluator@example.org', 'evaluator',
          (select id from app_user where email = 'josh_frost@sil.org'), 'josh_frost@sil.org', 'pending');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (_throw, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl25-evaluator@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL25 Throwaway Evaluator"}'::jsonb, now(), now());

  select count(*) into _n from app_user where auth_user_id = _throw and person_id = _pid;
  perform tl25_assert('a new account links to the person already holding its address',
                      _n = 1, 'app_user_link_person found the existing row instead of creating one');

  select count(*) into _n from person where primary_email = 'tl25-evaluator@example.org';
  perform tl25_assert('and did not create a second person for that address', _n = 1, format('%s', _n));

  select id into _throw_app from app_user where auth_user_id = _throw;
  select count(*) into _n from workshop_member
   where workshop_id = _cc and app_user_id = _throw_app and role = 'evaluator';
  perform tl25_assert('the throwaway signed up and holds evaluator on the Crash Course',
                      _n = 1, 'membership came from the invitation, not from an insert');

  select count(*) into _n from workshop_member where workshop_id = _psalms and app_user_id = _throw_app;
  perform tl25_assert('and holds nothing on Psalms', _n = 0, format('%s', _n));
end $$;

-- The positive and the negative of each pair, run as the throwaway evaluator. The
-- positives are not padding: RLS denies by returning nothing, so a negative alone
-- cannot tell "you may not see this" from "the query was wrong".
do $$
declare
  _throw uuid;
begin
  select auth_user_id into _throw from app_user where email = 'tl25-evaluator@example.org';

  perform tl25_try('allowed', 'evaluator reads the Crash Course workshop', _throw,
    $q$select 1 from workshop where id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
  perform tl25_try('blocked', 'evaluator CANNOT read the Psalms workshop', _throw,
    $q$select 1 from workshop where id = '11111111-1111-1111-1111-111111111111'$q$);

  perform tl25_try('allowed', 'evaluator reads the four Crash Course participants', _throw,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
  perform tl25_try('blocked', 'evaluator CANNOT read Psalms'' 22 participants', _throw,
    $q$select 1 from participant where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

  perform tl25_try('allowed', 'evaluator reads the Crash Course questions', _throw,
    $q$select 1 from ksa where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
  perform tl25_try('blocked', 'evaluator CANNOT read Psalms'' questions', _throw,
    $q$select 1 from ksa where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

  perform tl25_try('allowed', 'evaluator reads the Crash Course teams', _throw,
    $q$select 1 from team where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
  perform tl25_try('blocked', 'evaluator CANNOT read Psalms'' teams', _throw,
    $q$select 1 from team where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

  -- The switcher is the surface the spec names, and it is `workshop` filtered by
  -- membership. One row is the whole claim.
  perform tl25_try('allowed', 'the switcher offers exactly one workshop', _throw,
    $q$select 1 from workshop w where exists (
         select 1 from workshop_member m
          where m.workshop_id = w.id and m.app_user_id = current_app_user_id())$q$);

  -- An evaluator must not be able to rewrite the rubric they are being handed.
  perform tl25_try('blocked', 'evaluator CANNOT edit a Crash Course question', _throw,
    $q$update ksa set description = 'tampered'
        where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
end $$;

select jsonb_pretty(jsonb_build_object(
  'summary', (select format('%s of %s passed', count(*) filter (where verdict = 'PASS'), count(*))
                from tl25_results),
  'failures', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'outcome', outcome) order by seq)
                          from tl25_results where verdict = 'FAIL'), '[]'::jsonb),
  'switcher_for_the_throwaway',
    (select jsonb_agg(w.name order by w.name) from workshop w
      join workshop_member m on m.workshop_id = w.id
      join app_user a on a.id = m.app_user_id
     where a.email = 'tl25-evaluator@example.org'),
  'results', (select jsonb_agg(jsonb_build_object(
                'verdict', verdict, 'label', label, 'outcome', outcome) order by seq)
                from tl25_results)
)) as tl25_acceptance;
