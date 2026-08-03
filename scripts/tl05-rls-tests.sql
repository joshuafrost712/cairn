-- tl-05 acceptance harness: is an assignment a boundary, or only a label?
--
-- This table gets the schema's first rule about which COLUMNS a caller may
-- change, so the interesting attacks are not cross-workshop (tl-01 and tl-04
-- already cover that ground) but inside one workshop, between two evaluators and
-- the admin who is directing them:
--
--   - reading a hard conversation about a participant you were not given;
--   - handing your own conversation to somebody else;
--   - rewriting the guidance you were handed, so the record shows the admin
--     agreeing with how you chose to open it.
--
-- The last two are what the guard trigger exists for, and neither is expressible
-- in a policy: `with check` sees only NEW, and the rule is about what CHANGED.
--
-- Same conventions as scripts/tl04-rls-tests.sql, and the same reason for them:
-- under RLS a denied read and an empty table are indistinguishable, so every
-- check DECLARES its expectation and the state assertions at the end confirm
-- that nothing an attacker attempted actually landed.
--
--   node scripts/apply-migration.mjs scripts/tl05-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl05-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl05_results;
create table tl05_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl05_try(text, text, uuid, text);
create or replace function tl05_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl05_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl05_assert(text, boolean, text);
create or replace function tl05_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl05_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   ADM  tl05-rls-adm@example.org  admin      in the pilot workshop
--   E1   tl05-rls-e1@example.org   evaluator  in the pilot workshop, holds one conversation
--   E2   tl05-rls-e2@example.org   evaluator  in the pilot workshop, holds nothing
--   O    tl05-rls-o@example.org    evaluator  in a second workshop only
--
-- Three conversations: one assigned to E1 with guidance on it, one still in the
-- pool, and one in the other workshop so a cross-workshop read has something real
-- to fail to find. A "blocked" check against an empty table passes for free.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _other uuid := '55555555-5555-5555-5555-555555555555';
  _adm   uuid := '5d000000-0000-4000-8000-000000000001';
  _e1    uuid := '5d000000-0000-4000-8000-000000000002';
  _e2    uuid := '5d000000-0000-4000-8000-000000000003';
  _o     uuid := '5d000000-0000-4000-8000-000000000004';
  _part      uuid;
  _partother uuid := '5d000000-0000-4000-8000-0000000000aa';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from mentoring_conversation where id like 'tl05-rls-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl05-rls-%@example.org';
  delete from app_user where email like 'tl05-rls-%@example.org';
  delete from auth.users where id in (_adm, _e1, _e2, _o);
  delete from role_allowlist where email like 'tl05-rls-%@example.org';
  delete from participant where id = _partother;
  delete from workshop where id = _other;

  insert into workshop (id, name, start_date, location)
  values (_other, 'TL05 Fixture Workshop (outsider''s)', '2027-03-01', 'Nowhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl05-rls-adm@example.org', array['admin'],     'admin',     'tl-05 test fixture', _pilot),
    ('tl05-rls-e1@example.org',  array['evaluator'], 'evaluator', 'tl-05 test fixture', _pilot),
    ('tl05-rls-e2@example.org',  array['evaluator'], 'evaluator', 'tl-05 test fixture', _pilot),
    ('tl05-rls-o@example.org',   array['evaluator'], 'evaluator', 'tl-05 test fixture', _other);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_adm, 'tl05-rls-adm@example.org', 'TL05 Administrator'),
    (_e1,  'tl05-rls-e1@example.org',  'TL05 Evaluator One'),
    (_e2,  'tl05-rls-e2@example.org',  'TL05 Evaluator Two'),
    (_o,   'tl05-rls-o@example.org',   'TL05 Outsider')
  ) as v(id, email, name);

  select id into _part from participant where workshop_id = _pilot order by name limit 1;

  insert into participant (id, workshop_id, name)
  values (_partother, _other, 'TL05 Outsider Subject');

  insert into mentoring_conversation (
    id, participant_id, participant_name, workshop_id,
    trigger_observation_id, trigger_ksa_code, trigger_designation,
    status, assigned_to, assigned_by, assigned_at,
    admin_guidance, admin_guidance_updated_at
  ) values (
    'tl05-rls-assigned', _part, 'TL05 Fixture Subject', _pilot,
    'tl05-rls-obs::0', 'K1.1', 1,
    'needed', 'tl05-rls-e1@example.org', 'tl05-rls-adm@example.org', now(),
    'Open with what improved before naming the gap.', now()
  ), (
    'tl05-rls-pooled', _part, 'TL05 Fixture Subject', _pilot,
    'tl05-rls-obs::1', 'K1.2', 0,
    'needed', null, null, null,
    null, null
  ), (
    'tl05-rls-other-workshop', _partother, 'TL05 Outsider Subject', _other,
    'tl05-rls-obs::2', 'K1.1', 1,
    'needed', 'tl05-rls-o@example.org', null, null,
    null, null
  );

  perform tl05_assert(
    'fixtures provisioned four accounts through the real signup path',
    (select count(*) from app_user where email like 'tl05-rls-%@example.org') = 4
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl05-rls-%@example.org') = 4,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl05-rls-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl05-rls-%@example.org')));

  perform tl05_assert(
    'the fixture admin really holds the admin role, not the evaluator one',
    exists (select 1 from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email = 'tl05-rls-adm@example.org' and wm.role = 'admin'),
    coalesce((select wm.role from workshop_member wm join app_user u on u.id = wm.app_user_id
               where u.email = 'tl05-rls-adm@example.org'), 'NO MEMBERSHIP'));
end $$;

-- ---------------------------------------------------------------------------
-- The four negative checks this spec names, plus the ones its policies imply.
--
--   ADM 5d000000-0000-4000-8000-000000000001  admin,     pilot
--   E1  5d000000-0000-4000-8000-000000000002  evaluator, pilot, assignee
--   E2  5d000000-0000-4000-8000-000000000003  evaluator, pilot
--   O   5d000000-0000-4000-8000-000000000004  evaluator, other workshop
-- ---------------------------------------------------------------------------

-- 1. An evaluator reading a conversation assigned to somebody else. This is the
--    line of Joshua's feedback the whole spec starts from, and it used to be
--    permitted: tl-01's policy was `is_workshop_member(workshop_id)`, so every
--    member could read every follow-up about every participant.
select tl05_try('blocked', 'E2 reads the conversation assigned to E1',
  '5d000000-0000-4000-8000-000000000003',
  $q$select 1 from mentoring_conversation where id = 'tl05-rls-assigned'$q$);

select tl05_try('blocked', 'E1 reads a conversation still in the pool',
  '5d000000-0000-4000-8000-000000000002',
  $q$select 1 from mentoring_conversation where id = 'tl05-rls-pooled'$q$);

-- 2. The assignee handing their own conversation on. Not a hypothetical: the
--    hardest conversations are the ones somebody would rather pass along, and a
--    reassignment made without the admin is one nobody is tracking.
select tl05_try('blocked', 'E1 reassigns their own conversation to E2',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set assigned_to = 'tl05-rls-e2@example.org'
      where id = 'tl05-rls-assigned'$q$);

select tl05_try('blocked', 'E1 unassigns themselves',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set assigned_to = null where id = 'tl05-rls-assigned'$q$);

-- 3. The assignee editing the guidance they were given. The one edit that would
--    read, afterwards, as the administrator having agreed with it.
select tl05_try('blocked', 'E1 rewrites the admin guidance',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set admin_guidance = 'The admin said to be blunt about it.'
      where id = 'tl05-rls-assigned'$q$);

select tl05_try('blocked', 'E1 clears the admin guidance',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set admin_guidance = null where id = 'tl05-rls-assigned'$q$);

select tl05_try('blocked', 'E1 backdates the guidance stamp tl-06 reads',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set admin_guidance_updated_at = now() - interval '30 days'
      where id = 'tl05-rls-assigned'$q$);

-- 4. A non-member reading the workshop's conversations at all.
select tl05_try('blocked', 'the outsider reads the pilot workshop''s conversations',
  '5d000000-0000-4000-8000-000000000004',
  $q$select 1 from mentoring_conversation
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- 5. Moving the evidence. An assignee who could rewrite the trigger fields would
--    be moving somebody else's low score onto a record while the row still looks
--    like the one the admin handed over.
select tl05_try('blocked', 'E1 rewrites which observation triggered their conversation',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set trigger_observation_id = 'tl05-rls-obs::9'
      where id = 'tl05-rls-assigned'$q$);

-- 0, not 3. Written as `= 3` first, and it passed for the wrong reason: the
-- table has carried `check (trigger_designation in (0, 1))` since 2026-07-06, so
-- the error came from that constraint and the check would have passed with the
-- guard trigger dropped entirely. Caught by mutation-testing this harness rather
-- than by reading it. A designation of 0 is legal, so only the guard can refuse
-- it, and moving a 1 to a 0 is the edit worth blocking anyway: it makes the
-- conversation look more serious than the evidence two evaluators confirmed.
select tl05_try('blocked', 'E1 lowers the designation that triggered it',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set trigger_designation = 0 where id = 'tl05-rls-assigned'$q$);

-- 6. Creating a conversation. Insert is an administrator's act because every
--    device derives the same deterministic ids from the same observations; an
--    evaluator inserting is either a race or a follow-up nothing triggered.
select tl05_try('blocked', 'E1 creates a conversation',
  '5d000000-0000-4000-8000-000000000002',
  $q$insert into mentoring_conversation
       (id, participant_id, participant_name, workshop_id, status, assigned_to)
     select 'tl05-rls-forged', p.id, 'TL05 Fixture Subject',
            '11111111-1111-1111-1111-111111111111', 'needed', 'tl05-rls-e1@example.org'
       from participant p
      where p.workshop_id = '11111111-1111-1111-1111-111111111111'
      order by p.name limit 1$q$);

select tl05_try('blocked', 'E1 assigns themselves the pooled conversation',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set assigned_to = 'tl05-rls-e1@example.org'
      where id = 'tl05-rls-pooled'$q$);

select tl05_try('blocked', 'E1 deletes their own conversation rather than logging it',
  '5d000000-0000-4000-8000-000000000002',
  $q$delete from mentoring_conversation where id = 'tl05-rls-assigned'$q$);

-- 7. The unauthenticated case. The anon key ships in the client bundle.
select tl05_try('blocked', 'anon reads conversations', null,
  $q$select 1 from mentoring_conversation$q$);

-- ---------------------------------------------------------------------------
-- The permitted half. A permission spec that only proves refusals has proved the
-- app is broken.
-- ---------------------------------------------------------------------------

select tl05_try('permitted', 'the admin reads the whole workshop''s queue',
  '5d000000-0000-4000-8000-000000000001',
  $q$select 1 from mentoring_conversation
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl05_try('permitted', 'E1 reads the conversation assigned to them',
  '5d000000-0000-4000-8000-000000000002',
  $q$select 1 from mentoring_conversation where id = 'tl05-rls-assigned'$q$);

select tl05_try('permitted', 'E1 logs how their conversation went',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set status = 'completed',
            summary = 'Talked it through; he had already spotted it.',
            participant_response = 'Took it well.',
            recorded_by = 'tl05-rls-e1@example.org'
      where id = 'tl05-rls-assigned'$q$);

select tl05_try('permitted', 'E1 sets a date on their conversation',
  '5d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set scheduled_for = current_date + 2
      where id = 'tl05-rls-assigned'$q$);

select tl05_try('permitted', 'the admin writes guidance on the pooled conversation',
  '5d000000-0000-4000-8000-000000000001',
  $q$update mentoring_conversation
        set admin_guidance = 'She has heard this from two people already.',
            admin_guidance_updated_at = now()
      where id = 'tl05-rls-pooled'$q$);

select tl05_try('permitted', 'the admin assigns the pooled conversation to E2',
  '5d000000-0000-4000-8000-000000000001',
  $q$update mentoring_conversation
        set assigned_to = 'tl05-rls-e2@example.org',
            assigned_by = 'tl05-rls-adm@example.org',
            assigned_at = now()
      where id = 'tl05-rls-pooled'$q$);

select tl05_try('permitted', 'the admin reassigns E1''s conversation to E2',
  '5d000000-0000-4000-8000-000000000001',
  $q$update mentoring_conversation
        set assigned_to = 'tl05-rls-e2@example.org',
            assigned_by = 'tl05-rls-adm@example.org',
            assigned_at = now()
      where id = 'tl05-rls-assigned'$q$);

select tl05_try('permitted', 'E2 now reads the conversation that was reassigned to them',
  '5d000000-0000-4000-8000-000000000003',
  $q$select 1 from mentoring_conversation where id = 'tl05-rls-assigned'$q$);

select tl05_try('blocked', 'E1 no longer reads the conversation taken off them',
  '5d000000-0000-4000-8000-000000000002',
  $q$select 1 from mentoring_conversation where id = 'tl05-rls-assigned'$q$);

select tl05_try('permitted', 'the admin creates a conversation',
  '5d000000-0000-4000-8000-000000000001',
  $q$insert into mentoring_conversation
       (id, participant_id, participant_name, workshop_id, status)
     select 'tl05-rls-admin-made', p.id, 'TL05 Fixture Subject',
            '11111111-1111-1111-1111-111111111111', 'needed'
       from participant p
      where p.workshop_id = '11111111-1111-1111-1111-111111111111'
      order by p.name limit 1$q$);

-- ---------------------------------------------------------------------------
-- State assertions. Under RLS "0 rows" is the denial, so the checks above cannot
-- by themselves prove that nothing an attacker attempted landed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl05_assert('the guidance still says what the admin wrote',
    (select admin_guidance from mentoring_conversation where id = 'tl05-rls-assigned')
      = 'Open with what improved before naming the gap.',
    coalesce((select admin_guidance from mentoring_conversation where id = 'tl05-rls-assigned'), 'GONE'));

  perform tl05_assert('the triggering observation was not moved',
    (select trigger_observation_id from mentoring_conversation where id = 'tl05-rls-assigned')
      = 'tl05-rls-obs::0',
    coalesce((select trigger_observation_id from mentoring_conversation
               where id = 'tl05-rls-assigned'), 'GONE'));

  perform tl05_assert('the triggering designation was not raised',
    (select trigger_designation from mentoring_conversation where id = 'tl05-rls-assigned') = 1,
    format('designation = %s', coalesce((select trigger_designation from mentoring_conversation
                                          where id = 'tl05-rls-assigned'), -1)));

  perform tl05_assert('E1''s outcome did land, so the guard did not cost them their write',
    (select status from mentoring_conversation where id = 'tl05-rls-assigned') = 'completed'
      and (select summary from mentoring_conversation where id = 'tl05-rls-assigned') is not null,
    format('status = %s', coalesce((select status::text from mentoring_conversation
                                     where id = 'tl05-rls-assigned'), 'GONE')));

  perform tl05_assert('E1''s scheduled date landed too',
    (select scheduled_for from mentoring_conversation where id = 'tl05-rls-assigned') is not null,
    coalesce((select scheduled_for::text from mentoring_conversation
               where id = 'tl05-rls-assigned'), 'null'));

  perform tl05_assert('no conversation was forged by an evaluator',
    not exists (select 1 from mentoring_conversation where id = 'tl05-rls-forged'),
    format('%s forged row(s)',
           (select count(*) from mentoring_conversation where id = 'tl05-rls-forged')));

  perform tl05_assert('the pooled conversation was not self-assigned by E1',
    (select assigned_to from mentoring_conversation where id = 'tl05-rls-pooled')
      = 'tl05-rls-e2@example.org',
    coalesce((select assigned_to from mentoring_conversation where id = 'tl05-rls-pooled'), 'null'));

  perform tl05_assert('the admin''s reassignment did land',
    (select assigned_to from mentoring_conversation where id = 'tl05-rls-assigned')
      = 'tl05-rls-e2@example.org',
    coalesce((select assigned_to from mentoring_conversation where id = 'tl05-rls-assigned'), 'null'));

  perform tl05_assert('the admin''s own insert did land',
    exists (select 1 from mentoring_conversation where id = 'tl05-rls-admin-made'),
    'tl05-admin-made present');

  perform tl05_assert('the conversation E1 tried to delete is still there',
    exists (select 1 from mentoring_conversation where id = 'tl05-rls-assigned'),
    'tl05-assigned present');
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl05_results
order by (verdict = 'PASS'), seq;

-- One more state assertion, added after the fix above: prove the designation is
-- still the one the evidence carried, not merely that the attempt errored.
do $$
begin
  perform tl05_assert('the triggering designation is still 1, not lowered to 0',
    (select trigger_designation from mentoring_conversation where id = 'tl05-rls-assigned') = 1,
    format('designation = %s', coalesce((select trigger_designation from mentoring_conversation
                                          where id = 'tl05-rls-assigned'), -1)));
end $$;

select verdict, expect, label, outcome
from tl05_results
order by (verdict = 'PASS'), seq;
