-- tl-06 acceptance harness: does the flag belong to the evaluator, and only the flag?
--
-- This spec adds no policy, which is exactly why it needs a harness. tl-05's
-- `mentoring_conversation_guard` is a DENY-list: it names the columns an assignee
-- may not change and lets everything else through, so `follow_up_needed` and
-- `follow_up_note` became assignee-writable by silence. That is what tl-06 wants,
-- and "what the spec wanted happened to be what silence produced" is not a thing
-- to take on trust. So:
--
--   - the assignee can raise the flag, in the same statement as the outcome,
--     which is the shape src/db/sync.ts actually sends;
--   - raising it does NOT smuggle an edit to an admin-owned column through
--     alongside it, and a refused statement leaves the flag alone as well
--     (a BEFORE UPDATE trigger aborts the whole statement, and this proves it
--     rather than assuming it);
--   - a member who is not the assignee cannot raise it on somebody else's row,
--     because that is the boundary tl-05 built and this spec must not have
--     widened;
--   - and the column is `not null`, so the admin's filter has two states and not
--     three.
--
-- Conventions and the reason for them are tl-04's and tl-05's: under RLS a denied
-- read is indistinguishable from an empty table, so every check DECLARES its
-- expectation and the state assertions at the end prove that nothing refused
-- actually landed.
--
--   node scripts/apply-migration.mjs scripts/tl06-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl06-rls-teardown.sql
--
-- The prefix is `tl06-rls-`, which is not a prefix of any other harness's, per the
-- rule tl-05 learned by deleting its own walkthrough's accounts mid-run.

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl06_results;
create table tl06_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl06_try(text, text, uuid, text);
create or replace function tl06_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl06_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl06_assert(text, boolean, text);
create or replace function tl06_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl06_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   ADM  tl06-rls-adm@example.org  admin      in the pilot workshop
--   E1   tl06-rls-e1@example.org   evaluator  in the pilot workshop, holds one conversation
--   E2   tl06-rls-e2@example.org   evaluator  in the pilot workshop, holds nothing
--
-- Two conversations, both in the pilot workshop: one assigned to E1 with guidance
-- on it, one still in the pool. No second workshop this time — tl-05's harness
-- covers the cross-workshop read and nothing here changes it.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _adm   uuid := '6d000000-0000-4000-8000-000000000001';
  _e1    uuid := '6d000000-0000-4000-8000-000000000002';
  _e2    uuid := '6d000000-0000-4000-8000-000000000003';
  _part  uuid;
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from mentoring_conversation where id like 'tl06-rls-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl06-rls-%@example.org';
  delete from app_user where email like 'tl06-rls-%@example.org';
  delete from auth.users where id in (_adm, _e1, _e2);
  delete from role_allowlist where email like 'tl06-rls-%@example.org';

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl06-rls-adm@example.org', array['admin'],     'admin',     'tl-06 test fixture', _pilot),
    ('tl06-rls-e1@example.org',  array['evaluator'], 'evaluator', 'tl-06 test fixture', _pilot),
    ('tl06-rls-e2@example.org',  array['evaluator'], 'evaluator', 'tl-06 test fixture', _pilot);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_adm, 'tl06-rls-adm@example.org', 'TL06 Administrator'),
    (_e1,  'tl06-rls-e1@example.org',  'TL06 Evaluator One'),
    (_e2,  'tl06-rls-e2@example.org',  'TL06 Evaluator Two')
  ) as v(id, email, name);

  select id into _part from participant where workshop_id = _pilot order by name limit 1;

  -- Neither row names follow_up_needed, on purpose: the state assertions below
  -- read the column's default off them.
  insert into mentoring_conversation (
    id, participant_id, participant_name, workshop_id,
    trigger_observation_id, trigger_ksa_code, trigger_designation,
    status, assigned_to, assigned_by, assigned_at,
    admin_guidance, admin_guidance_updated_at
  ) values (
    'tl06-rls-assigned', _part, 'TL06 Fixture Subject', _pilot,
    'tl06-rls-obs::0', 'K1.1', 1,
    'needed', 'tl06-rls-e1@example.org', 'tl06-rls-adm@example.org', now(),
    'Open with what improved before naming the gap.', now()
  ), (
    'tl06-rls-pooled', _part, 'TL06 Fixture Subject', _pilot,
    'tl06-rls-obs::1', 'K1.2', 0,
    'needed', null, null, null, null, null
  );

  perform tl06_assert(
    'fixtures provisioned three accounts through the real signup path',
    (select count(*) from app_user where email like 'tl06-rls-%@example.org') = 3
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl06-rls-%@example.org') = 3,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl06-rls-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl06-rls-%@example.org')));

  perform tl06_assert(
    'the flag defaults to false rather than null on a row that never named it',
    (select follow_up_needed from mentoring_conversation where id = 'tl06-rls-assigned') = false,
    format('follow_up_needed = %s',
           coalesce((select follow_up_needed::text from mentoring_conversation
                      where id = 'tl06-rls-assigned'), 'NULL')));

  perform tl06_assert(
    'the column is NOT NULL, so the admin''s filter has two states and not three',
    (select is_nullable from information_schema.columns
      where table_name = 'mentoring_conversation' and column_name = 'follow_up_needed') = 'NO',
    coalesce((select is_nullable from information_schema.columns
               where table_name = 'mentoring_conversation'
                 and column_name = 'follow_up_needed'), 'NO SUCH COLUMN'));
end $$;

-- ---------------------------------------------------------------------------
-- The permitted half: what this spec exists to make possible.
--
--   ADM 6d000000-0000-4000-8000-000000000001  admin,     pilot
--   E1  6d000000-0000-4000-8000-000000000002  evaluator, pilot, assignee
--   E2  6d000000-0000-4000-8000-000000000003  evaluator, pilot
-- ---------------------------------------------------------------------------

-- The real write shape. src/db/sync.ts sends these seven columns as ONE update,
-- so testing the flag on its own would test a statement the app never issues.
select tl06_try('permitted', 'E1 logs the outcome and raises the follow-up flag in one update',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set status = 'completed',
            scheduled_for = current_date,
            summary = 'Talked it through; he wants to revisit after the next session.',
            participant_response = 'Defensive at first, then asked two good questions.',
            recorded_by = 'tl06-rls-e1@example.org',
            follow_up_needed = true,
            follow_up_note = 'Not finished. I would not close this yet.',
            updated_at = now()
      where id = 'tl06-rls-assigned'$q$);

select tl06_try('permitted', 'E1 lowers their own flag again, having been wrong about it',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set follow_up_needed = false, follow_up_note = null
      where id = 'tl06-rls-assigned'$q$);

select tl06_try('permitted', 'E1 raises it once more, so the state assertions have something to read',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set follow_up_needed = true,
            follow_up_note = 'Wants to talk again after the next session.'
      where id = 'tl06-rls-assigned'$q$);

select tl06_try('permitted', 'the admin reads the flag and the note',
  '6d000000-0000-4000-8000-000000000001',
  $q$select 1 from mentoring_conversation
      where workshop_id = '11111111-1111-1111-1111-111111111111'
        and follow_up_needed$q$);

select tl06_try('permitted', 'the admin clears a flag they have acted on',
  '6d000000-0000-4000-8000-000000000001',
  $q$update mentoring_conversation set follow_up_needed = false
      where id = 'tl06-rls-pooled'$q$);

-- ---------------------------------------------------------------------------
-- The blocked half. The new grant must not have widened anything else.
-- ---------------------------------------------------------------------------

-- The one that matters most. A guard that fired but let the rest of the statement
-- through would mean an evaluator could rewrite their guidance and lose only the
-- flag, which is the failure that would look like success on the page.
select tl06_try('blocked', 'E1 tries to rewrite the guidance in the same update as the flag',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set follow_up_needed = false,
            follow_up_note = 'nothing to see here',
            admin_guidance = 'The admin said to be blunt about it.'
      where id = 'tl06-rls-assigned'$q$);

select tl06_try('blocked', 'E1 tries to reassign while raising the flag',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation
        set follow_up_needed = true, assigned_to = 'tl06-rls-e2@example.org'
      where id = 'tl06-rls-assigned'$q$);

-- Dismissal is not an evaluator's power, and the flag is why it does not need to
-- be. Writing this check is what found that the rule was UI-only: `status` is not
-- frozen by tl-05's guard (the assignee sets it to 'scheduled' and 'completed'
-- constantly), so an evaluator's own session could dismiss. The second trigger
-- this migration adds is the fix, and this is the test that would have caught it.
select tl06_try('blocked', 'E1 dismisses their own conversation instead of flagging it',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set status = 'dismissed'
      where id = 'tl06-rls-assigned'$q$);

-- The transition, not the state: an assignee updating an already-dismissed row
-- must not be refused for a value the admin set.
select tl06_try('permitted', 'the admin dismisses the pooled conversation',
  '6d000000-0000-4000-8000-000000000001',
  $q$update mentoring_conversation set status = 'dismissed'
      where id = 'tl06-rls-pooled'$q$);

select tl06_try('blocked', 'E2 raises the flag on the conversation assigned to E1',
  '6d000000-0000-4000-8000-000000000003',
  $q$update mentoring_conversation set follow_up_needed = true, follow_up_note = 'not mine'
      where id = 'tl06-rls-assigned'$q$);

-- Passes by tl-05's read policy rather than by anything tl-06 added, and is here
-- as a regression guard on the sentence "the note is for the admin": the note is
-- the first column on this table written for a third party to read, so a later
-- spec that loosens the read to make an admin's life easier should fail here.
select tl06_try('blocked', 'E2 reads the note E1 left for the admin',
  '6d000000-0000-4000-8000-000000000003',
  $q$select 1 from mentoring_conversation
      where id = 'tl06-rls-assigned' and follow_up_note is not null$q$);

select tl06_try('blocked', 'E1 raises the flag on a conversation still in the pool',
  '6d000000-0000-4000-8000-000000000002',
  $q$update mentoring_conversation set follow_up_needed = true
      where id = 'tl06-rls-pooled'$q$);

select tl06_try('blocked', 'anon reads the follow-up notes', null,
  $q$select 1 from mentoring_conversation where follow_up_note is not null$q$);

-- ---------------------------------------------------------------------------
-- State assertions. "0 rows" is the denial, so the checks above cannot by
-- themselves prove that nothing refused actually landed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl06_assert('E1''s flag and note are on the row',
    (select follow_up_needed from mentoring_conversation where id = 'tl06-rls-assigned') = true
      and (select follow_up_note from mentoring_conversation where id = 'tl06-rls-assigned')
          = 'Wants to talk again after the next session.',
    format('flag = %s, note = %s',
           coalesce((select follow_up_needed::text from mentoring_conversation
                      where id = 'tl06-rls-assigned'), 'GONE'),
           coalesce((select follow_up_note from mentoring_conversation
                      where id = 'tl06-rls-assigned'), 'null')));

  -- The refused statement above set the flag to false AND rewrote the guidance.
  -- Both halves must have been thrown away together.
  perform tl06_assert('the refused statement changed neither the guidance nor the flag',
    (select admin_guidance from mentoring_conversation where id = 'tl06-rls-assigned')
      = 'Open with what improved before naming the gap.'
      and (select follow_up_needed from mentoring_conversation
            where id = 'tl06-rls-assigned') = true,
    format('guidance = %s, flag = %s',
           coalesce((select admin_guidance from mentoring_conversation
                      where id = 'tl06-rls-assigned'), 'GONE'),
           coalesce((select follow_up_needed::text from mentoring_conversation
                      where id = 'tl06-rls-assigned'), 'GONE')));

  perform tl06_assert('E1''s outcome landed, so the guard did not cost them their write',
    (select status from mentoring_conversation where id = 'tl06-rls-assigned') = 'completed'
      and (select recorded_by from mentoring_conversation where id = 'tl06-rls-assigned')
          = 'tl06-rls-e1@example.org',
    format('status = %s', coalesce((select status::text from mentoring_conversation
                                     where id = 'tl06-rls-assigned'), 'GONE')));

  perform tl06_assert('E1 did not manage to dismiss it',
    (select status from mentoring_conversation where id = 'tl06-rls-assigned') <> 'dismissed',
    format('status = %s', coalesce((select status::text from mentoring_conversation
                                     where id = 'tl06-rls-assigned'), 'GONE')));

  perform tl06_assert('E1 is still the assignee',
    (select assigned_to from mentoring_conversation where id = 'tl06-rls-assigned')
      = 'tl06-rls-e1@example.org',
    coalesce((select assigned_to from mentoring_conversation
               where id = 'tl06-rls-assigned'), 'null'));

  perform tl06_assert('nobody raised a flag on the pooled conversation',
    (select follow_up_needed from mentoring_conversation where id = 'tl06-rls-pooled') = false
      and (select follow_up_note from mentoring_conversation where id = 'tl06-rls-pooled') is null,
    format('flag = %s',
           coalesce((select follow_up_needed::text from mentoring_conversation
                      where id = 'tl06-rls-pooled'), 'GONE')));

  perform tl06_assert('the admin''s own dismissal did land, so the new guard is not too wide',
    (select status from mentoring_conversation where id = 'tl06-rls-pooled') = 'dismissed',
    format('status = %s', coalesce((select status::text from mentoring_conversation
                                     where id = 'tl06-rls-pooled'), 'GONE')));

  perform tl06_assert('both guards are on the table, tl-05''s and this spec''s',
    (select count(*) from pg_trigger
      where tgrelid = 'mentoring_conversation'::regclass
        and tgname in ('mentoring_conversation_guard', 'mentoring_conversation_dismiss_guard')) = 2,
    format('%s of 2 present',
           (select count(*) from pg_trigger
             where tgrelid = 'mentoring_conversation'::regclass
               and tgname in ('mentoring_conversation_guard',
                              'mentoring_conversation_dismiss_guard'))));

  perform tl06_assert('the partial index the admin''s filter reads exists',
    exists (select 1 from pg_indexes
             where tablename = 'mentoring_conversation'
               and indexname = 'mentoring_conversation_followup_idx'),
    coalesce((select indexdef from pg_indexes
               where indexname = 'mentoring_conversation_followup_idx'), 'MISSING'));
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl06_results
order by (verdict = 'PASS'), seq;

select
  count(*) filter (where verdict = 'PASS') as passed,
  count(*) filter (where verdict = 'FAIL') as failed,
  count(*)                                 as total
from tl06_results;
