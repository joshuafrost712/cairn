-- tl-04 acceptance harness: is a verdict actually a signature, or only labelled
-- as one?
--
-- The new tables introduce the schema's first per-ROW author check. Everything
-- before this asked "what role do you hold in this workshop"; a verdict asks "is
-- this yours". So the interesting attack is not cross-workshop, it is
-- cross-evaluator inside one workshop: B writing a verdict under C's name, or
-- editing the verdict C already cast. Both would corrupt the multi-evaluator gate
-- while leaving every screen looking normal, because two confirmations is two
-- confirmations regardless of who really made them.
--
-- Same conventions as scripts/tl01-rls-tests.sql, and the same reason for them:
-- under RLS a denied read and an empty table are indistinguishable, so every check
-- DECLARES its expectation and the state assertions at the end confirm that
-- nothing an attacker attempted actually landed.
--
-- Run against the linked project as `postgres`, then run the teardown:
--
--   node scripts/apply-migration.mjs scripts/tl04-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl04-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl04_results;
create table tl04_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl04_try(text, text, uuid, text);
create or replace function tl04_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl04_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl04_assert(text, boolean, text);
create or replace function tl04_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl04_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Three accounts, because the cross-evaluator attack needs three parties: the
-- attacker, the victim whose signature is forged, and somebody outside the
-- workshop entirely.
--
--   B (attacker)   tl04-b@example.org   evaluator in the pilot workshop
--   C (victim)     tl04-c@example.org   evaluator in the pilot workshop
--   O (outsider)   tl04-o@example.org   evaluator in a second workshop only
--
-- Provisioned through the real signup path (allowlist + handle_new_user), so the
-- app_user row and the membership come from the trigger rather than by hand.
-- ---------------------------------------------------------------------------

do $$
declare
  _pilot uuid := '11111111-1111-1111-1111-111111111111';
  _other uuid := '55555555-5555-5555-5555-555555555555';
  _b     uuid := '5b000000-0000-4000-8000-000000000001';
  _c     uuid := '5c000000-0000-4000-8000-000000000002';
  _o     uuid := '50000000-0000-4000-8000-000000000003';
  _part  uuid;
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from verification_verdict where id like 'tl04-%';
  delete from observation where id like 'tl04-%';
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl04-%@example.org';
  delete from app_user where email like 'tl04-%@example.org';
  delete from auth.users where id in (_b, _c, _o);
  delete from role_allowlist where email like 'tl04-%@example.org';
  delete from workshop where id = _other;

  insert into workshop (id, name, start_date, location)
  values (_other, 'TL04 Fixture Workshop (outsider''s)', '2027-02-01', 'Nowhere');

  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values
    ('tl04-b@example.org', array['evaluator'], 'evaluator', 'tl-04 test fixture', _pilot),
    ('tl04-c@example.org', array['evaluator'], 'evaluator', 'tl-04 test fixture', _pilot),
    ('tl04-o@example.org', array['evaluator'], 'evaluator', 'tl-04 test fixture', _other);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  )
  select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         v.email, 'not-a-real-password-hash', now(), now(), now(),
         '{"provider":"email"}'::jsonb, json_build_object('name', v.name)::jsonb
  from (values
    (_b, 'tl04-b@example.org', 'TL04 Evaluator B'),
    (_c, 'tl04-c@example.org', 'TL04 Evaluator C'),
    (_o, 'tl04-o@example.org', 'TL04 Outsider')
  ) as v(id, email, name);

  -- One observation in the pilot workshop for everybody to argue about, and one
  -- in the outsider's workshop so the cross-workshop read has something real to
  -- fail to find (an empty table would pass a badly written check for free).
  select id into _part from participant where workshop_id = _pilot order by name limit 1;

  insert into observation (
    id, capture_client_id, workshop_id, participant_id, participant_name,
    ksa_code, text, source_excerpt, evidence_designation,
    sentiment_flag, confidence, needs_review, origin, evaluator_email
  ) values (
    'tl04-obs::0', 'tl04-capture', _pilot, _part::text, 'TL04 Fixture Subject',
    'K1.1', 'fixture observation', 'fixture excerpt', 2,
    'neutral', 'high', false, 'individual', 'tl04-b@example.org'
  ), (
    'tl04-obs-other::0', 'tl04-capture-other', _other, null, 'TL04 Outsider Subject',
    'K1.1', 'fixture observation in the other workshop', 'fixture excerpt', 1,
    'neutral', 'high', false, 'individual', 'tl04-o@example.org'
  );

  -- C's genuine verdict, the one B will try to edit.
  insert into verification_verdict (
    id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at
  ) values (
    'tl04-obs::0::tl04-c@example.org', 'tl04-obs::0', 'tl04-capture',
    _pilot, 'tl04-c@example.org', 'confirm', now()
  );

  perform tl04_assert(
    'fixtures provisioned three accounts through the real signup path',
    (select count(*) from app_user where email like 'tl04-%@example.org') = 3
      and (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
            where u.email like 'tl04-%@example.org') = 3,
    format('%s account(s), %s membership(s)',
           (select count(*) from app_user where email like 'tl04-%@example.org'),
           (select count(*) from workshop_member wm join app_user u on u.id = wm.app_user_id
             where u.email like 'tl04-%@example.org')));
end $$;

-- ---------------------------------------------------------------------------
-- The four negative checks this spec names, plus the ones its policies imply.
--
--   B  5b000000-0000-4000-8000-000000000001  evaluator, pilot workshop
--   C  5c000000-0000-4000-8000-000000000002  evaluator, pilot workshop
--   O  50000000-0000-4000-8000-000000000003  evaluator, other workshop
--   Josh 3aea7d0d-133b-43ee-b5d0-a7a80374a87f  chief_admin, pilot workshop
-- ---------------------------------------------------------------------------

-- 1. B signing as C. The forgery that would corrupt the gate invisibly.
select tl04_try('blocked', 'B inserts a verdict under C''s email',
  '5b000000-0000-4000-8000-000000000001',
  $q$insert into verification_verdict
       (id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at)
     values ('tl04-forged-1', 'tl04-obs::0', 'tl04-capture',
             '11111111-1111-1111-1111-111111111111', 'tl04-c@example.org', 'confirm', now())$q$);

-- 2. B editing the verdict C already cast.
select tl04_try('blocked', 'B updates C''s existing verdict',
  '5b000000-0000-4000-8000-000000000001',
  $q$update verification_verdict set decision = 'reject'
      where id = 'tl04-obs::0::tl04-c@example.org'$q$);

select tl04_try('blocked', 'B deletes C''s verdict',
  '5b000000-0000-4000-8000-000000000001',
  $q$delete from verification_verdict where id = 'tl04-obs::0::tl04-c@example.org'$q$);

-- 3. A non-member reading the workshop's observations. The whole reason the table
--    carries a workshop_id rather than trusting the client's selection.
select tl04_try('blocked', 'outsider reads the pilot workshop''s observations',
  '50000000-0000-4000-8000-000000000003',
  $q$select 1 from observation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl04_try('blocked', 'outsider reads the pilot workshop''s verdicts',
  '50000000-0000-4000-8000-000000000003',
  $q$select 1 from verification_verdict
      where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

-- 4. An evaluator inserting an observation. Routing is an administrator's act, so
--    this is somebody putting evidence into a participant's record with no
--    capture behind it.
select tl04_try('blocked', 'evaluator B inserts an observation',
  '5b000000-0000-4000-8000-000000000001',
  $q$insert into observation
       (id, capture_client_id, workshop_id, participant_name, ksa_code, text,
        source_excerpt, evidence_designation, sentiment_flag, confidence,
        needs_review, origin)
     values ('tl04-forged-obs::0', 'tl04-forged-capture',
             '11111111-1111-1111-1111-111111111111', 'Someone', 'K1.1',
             'evidence with no capture', '', 3, 'strong', 'high', false, 'individual')$q$);

select tl04_try('blocked', 'evaluator B edits an observation''s designation',
  '5b000000-0000-4000-8000-000000000001',
  $q$update observation set evidence_designation = 0 where id = 'tl04-obs::0'$q$);

-- 5. Mislabelling: a verdict whose workshop_id names a workshop the caller
--    belongs to, but which is not the observation's. Would hide the verdict from
--    the gate that needs it while looking perfectly valid in its own workshop.
select tl04_try('blocked', 'O files a verdict on a pilot observation under their own workshop',
  '50000000-0000-4000-8000-000000000003',
  $q$insert into verification_verdict
       (id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at)
     values ('tl04-mislabelled', 'tl04-obs::0', 'tl04-capture',
             '55555555-5555-5555-5555-555555555555', 'tl04-o@example.org', 'confirm', now())$q$);

-- 6. The unauthenticated case. The anon key ships in the client bundle, so this
--    is the check that matters most for a public deployment.
select tl04_try('blocked', 'anon reads observations', null,
  $q$select 1 from observation$q$);

select tl04_try('blocked', 'anon reads verdicts', null,
  $q$select 1 from verification_verdict$q$);

-- The `observation_legacy` check that used to sit here is deliberately gone
-- rather than left to pass. tl-18 dropped the table (migration
-- 20260730001300), and a "blocked" check against a table that no longer exists
-- passes on the error alone — which is a green line that has stopped measuring
-- anything. A retired assertion is better deleted than left looking healthy.

-- ---------------------------------------------------------------------------
-- The permitted half. A permission spec that only proves refusals has proved the
-- app is broken.
-- ---------------------------------------------------------------------------

select tl04_try('permitted', 'B reads the pilot workshop''s observations',
  '5b000000-0000-4000-8000-000000000001',
  $q$select 1 from observation where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);

select tl04_try('permitted', 'B reads C''s verdict (a shared gate, not a leak)',
  '5b000000-0000-4000-8000-000000000001',
  $q$select 1 from verification_verdict where id = 'tl04-obs::0::tl04-c@example.org'$q$);

select tl04_try('permitted', 'B casts their own verdict',
  '5b000000-0000-4000-8000-000000000001',
  $q$insert into verification_verdict
       (id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at)
     values ('tl04-obs::0::tl04-b@example.org', 'tl04-obs::0', 'tl04-capture',
             '11111111-1111-1111-1111-111111111111', 'tl04-b@example.org', 'confirm', now())$q$);

select tl04_try('permitted', 'B re-casts the same verdict (upsert is idempotent)',
  '5b000000-0000-4000-8000-000000000001',
  $q$update verification_verdict set decision = 'adjust', adjusted_designation = 1
      where id = 'tl04-obs::0::tl04-b@example.org'$q$);

select tl04_try('permitted', 'B withdraws their own verdict',
  '5b000000-0000-4000-8000-000000000001',
  $q$delete from verification_verdict where id = 'tl04-obs::0::tl04-b@example.org'$q$);

select tl04_try('permitted', 'the chief admin writes an observation',
  '3aea7d0d-133b-43ee-b5d0-a7a80374a87f',
  $q$insert into observation
       (id, capture_client_id, workshop_id, participant_name, ksa_code, text,
        source_excerpt, evidence_designation, sentiment_flag, confidence,
        needs_review, origin)
     values ('tl04-admin-obs::0', 'tl04-admin-capture',
             '11111111-1111-1111-1111-111111111111', 'Someone', 'K1.1',
             'routed observation', '', 2, 'neutral', 'high', false, 'individual')$q$);

-- ---------------------------------------------------------------------------
-- State assertions. Under RLS "0 rows" is the denial, so the checks above cannot
-- by themselves prove nothing landed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform tl04_assert('C''s verdict still says what C said',
    (select decision from verification_verdict where id = 'tl04-obs::0::tl04-c@example.org') = 'confirm',
    format('decision = %s', coalesce((select decision from verification_verdict
                                       where id = 'tl04-obs::0::tl04-c@example.org'), 'GONE')));

  perform tl04_assert('no verdict was forged under another evaluator''s name',
    not exists (select 1 from verification_verdict where id = 'tl04-forged-1'),
    format('%s forged verdict(s)',
           (select count(*) from verification_verdict where id = 'tl04-forged-1')));

  perform tl04_assert('no mislabelled verdict landed',
    not exists (select 1 from verification_verdict where id = 'tl04-mislabelled'),
    format('%s mislabelled verdict(s)',
           (select count(*) from verification_verdict where id = 'tl04-mislabelled')));

  perform tl04_assert('no observation was forged by an evaluator',
    not exists (select 1 from observation where id = 'tl04-forged-obs::0'),
    format('%s forged observation(s)',
           (select count(*) from observation where id = 'tl04-forged-obs::0')));

  perform tl04_assert('the fixture observation''s designation was not lowered',
    (select evidence_designation from observation where id = 'tl04-obs::0') = 2,
    format('designation = %s', coalesce((select evidence_designation from observation
                                          where id = 'tl04-obs::0'), -1)));

  perform tl04_assert('the administrator''s observation did land',
    exists (select 1 from observation where id = 'tl04-admin-obs::0'),
    'tl04-admin-obs::0 present');

  perform tl04_assert('B''s own verdict was withdrawn, not merely hidden',
    not exists (select 1 from verification_verdict where id = 'tl04-obs::0::tl04-b@example.org'),
    'no row for B');
end $$;

-- ---------------------------------------------------------------------------
-- Report. Failures first, because that is what wants reading.
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome
from tl04_results
order by (verdict = 'PASS'), seq;
