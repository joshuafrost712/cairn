-- tl-09 acceptance harness: is the scale actually the workshop's, and is the
-- two-to-six rule actually enforceable?
--
-- The arithmetic is unit-tested (test/scale.test.ts, test/scaleContract.test.ts).
-- What those cannot prove is the part this spec rests on: that `scale_point` has
-- exactly one write path, that the path refuses what it says it refuses, and that
-- a 3-point workshop and a 6-point one can hold their own scales side by side in
-- one deployment without either reading the other's.
--
-- The sharpest check is R5/R6. Removing a point that observations sit on must be
-- REFUSED rather than silently remapped, and a remap must mark every observation
-- it moves — because a remapped score is an administrator's translation and a
-- report that presents it as an evaluator's judgement is claiming somebody said
-- something they did not.
--
-- Same conventions as scripts/tl07-rls-tests.sql, and the same reason for them:
-- under RLS a denied read and an empty table are indistinguishable, so every
-- check DECLARES its expectation and the state assertions at the end confirm that
-- nothing an attacker attempted actually landed.
--
-- Run against the linked project as `postgres`, then run the teardown:
--
--   node scripts/apply-migration.mjs scripts/tl09-rls-tests.sql
--   node scripts/apply-migration.mjs scripts/tl09-rls-teardown.sql

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

drop table if exists tl09_results;
create table tl09_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl09_try(text, text, uuid, text);
create or replace function tl09_try(_expect text, _label text, _uid uuid, _sql text)
returns void
language plpgsql
as $$
declare
  _count   bigint;
  _outcome text;
  _errored boolean := false;
  _verdict text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  begin
    execute _sql;
    get diagnostics _count = row_count;
    _outcome := format('no error, %s row(s)', _count);
  exception when others then
    _errored := true;
    _count := 0;
    -- The slug in `detail` is the contract tl-02 established and this reuses:
    -- a refusal a client can branch on without parsing prose.
    _outcome := format('error [%s] %s', sqlstate, coalesce(nullif('', ''), sqlerrm));
  end;
  reset role;

  if _expect = 'blocked' then
    _verdict := case when _errored or _count = 0 then 'PASS' else 'FAIL' end;
  else
    _verdict := case when not _errored and _count > 0 then 'PASS' else 'FAIL' end;
  end if;

  insert into tl09_results (verdict, expect, label, outcome)
  values (_verdict, _expect, _label, _outcome);
end $$;

drop function if exists tl09_assert(text, boolean, text);
create or replace function tl09_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl09_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   THREE (a 3-point workshop)  admin tl09-a@example.org, evaluator tl09-e@example.org
--   SIX   (a 6-point workshop)  admin tl09-b@example.org
--
-- Two workshops with genuinely different scales, because the whole claim is that
-- one deployment can host both. A fixture where both were 0-3 would let every
-- cross-workshop bug in this spec pass.
--
-- THREE's evaluator is a member of THREE only, which is what makes the
-- cross-workshop read check mean something.
-- ---------------------------------------------------------------------------

do $$
declare
  _three uuid := '90900000-0000-4000-8000-000000000001';
  _six   uuid := '90900000-0000-4000-8000-000000000002';
  _a     uuid := '9a000000-0000-4000-8000-000000000001';
  _b     uuid := '9b000000-0000-4000-8000-000000000002';
  _e     uuid := '9e000000-0000-4000-8000-000000000003';
begin
  -- Idempotent: a re-run measures the policies, not accumulated fixtures.
  delete from observation where workshop_id in (_three, _six);
  delete from participant where workshop_id in (_three, _six);
  delete from workshop_member wm using app_user u
    where u.id = wm.app_user_id and u.email like 'tl09-%@example.org';
  delete from app_user where email like 'tl09-%@example.org';
  delete from auth.users where id in (_a, _b, _e);
  delete from role_allowlist where email like 'tl09-%@example.org';
  delete from workshop where id in (_three, _six);

  insert into workshop (id, name, start_date, location)
  values (_three, 'TL09 Three-Point Workshop', '2027-05-01', 'Threeville'),
         (_six,   'TL09 Six-Point Workshop',   '2027-06-01', 'Sixtown');

  insert into participant (id, workshop_id, name)
  values ('90900000-0000-4000-8000-00000000f001'::uuid, _three, 'Three Person');

  -- Accounts, through the real signup path so app_user and the membership come
  -- from the trigger rather than by hand.
  insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
  values ('tl09-a@example.org', array['admin'], 'admin', 'tl-09 fixture', _three),
         ('tl09-b@example.org', array['admin'], 'admin', 'tl-09 fixture', _six),
         ('tl09-e@example.org', array['evaluator'], 'evaluator', 'tl-09 fixture', _three);

  insert into auth.users (id, email, raw_user_meta_data, aud, role,
                          instance_id, encrypted_password, email_confirmed_at,
                          created_at, updated_at)
  values (_a, 'tl09-a@example.org', '{"name":"TL09 A"}'::jsonb, 'authenticated', 'authenticated',
          '00000000-0000-0000-0000-000000000000', '', now(), now(), now()),
         (_b, 'tl09-b@example.org', '{"name":"TL09 B"}'::jsonb, 'authenticated', 'authenticated',
          '00000000-0000-0000-0000-000000000000', '', now(), now(), now()),
         (_e, 'tl09-e@example.org', '{"name":"TL09 E"}'::jsonb, 'authenticated', 'authenticated',
          '00000000-0000-0000-0000-000000000000', '', now(), now(), now());
end $$;

-- ---------------------------------------------------------------------------
-- R0. Every new workshop was born with a scale, by trigger.
-- ---------------------------------------------------------------------------

select tl09_assert(
  'R0  the insert trigger seeded 0-3 on both new workshops',
  (select count(*) from scale_point
    where workshop_id in ('90900000-0000-4000-8000-000000000001',
                          '90900000-0000-4000-8000-000000000002')) = 8,
  (select coalesce(string_agg(distinct workshop_id::text || ':' || value::text, ', '), 'none')
     from scale_point where workshop_id in ('90900000-0000-4000-8000-000000000001',
                                            '90900000-0000-4000-8000-000000000002'))
);

-- ---------------------------------------------------------------------------
-- R1-R2. There is no direct write path, for anybody.
--
-- The missing insert/update/delete policies ARE the enforcement: a scale's
-- invariant spans rows, and the app's offline outbox pushes one row per
-- transaction, so a per-row policy could only ever check the rule against a state
-- that is not the final one.
-- ---------------------------------------------------------------------------

select tl09_try('blocked', 'R1  an ADMIN cannot insert a scale point directly',
  '9a000000-0000-4000-8000-000000000001',
  $$insert into scale_point (workshop_id, value, label, is_low_trigger, sort_order)
    values ('90900000-0000-4000-8000-000000000001', 9, 'smuggled', false, 9)$$);

select tl09_try('blocked', 'R2  an ADMIN cannot update a scale point directly',
  '9a000000-0000-4000-8000-000000000001',
  $$update scale_point set label = 'renamed by hand'
     where workshop_id = '90900000-0000-4000-8000-000000000001' and value = 0$$);

select tl09_try('blocked', 'R3  an ADMIN cannot delete a scale point directly',
  '9a000000-0000-4000-8000-000000000001',
  $$delete from scale_point
     where workshop_id = '90900000-0000-4000-8000-000000000001' and value = 3$$);

-- ---------------------------------------------------------------------------
-- R4. The scale is readable by its own members and by nobody else.
-- ---------------------------------------------------------------------------

select tl09_try('permitted', 'R4  an evaluator reads their own workshop''s scale',
  '9e000000-0000-4000-8000-000000000003',
  $$select 1 from scale_point where workshop_id = '90900000-0000-4000-8000-000000000001'$$);

select tl09_try('blocked', 'R5  the same evaluator reads NOTHING of the other workshop''s scale',
  '9e000000-0000-4000-8000-000000000003',
  $$select 1 from scale_point where workshop_id = '90900000-0000-4000-8000-000000000002'$$);

-- ---------------------------------------------------------------------------
-- R6-R8. The RPC refuses what it says it refuses.
-- ---------------------------------------------------------------------------

select tl09_try('blocked', 'R6  an admin of the OTHER workshop cannot set this one''s scale',
  '9b000000-0000-4000-8000-000000000002',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":0,"label":"a","is_low_trigger":true},{"value":1,"label":"b","is_low_trigger":false}]'::jsonb)$$);

select tl09_try('blocked', 'R7  an EVALUATOR of this workshop cannot set its scale',
  '9e000000-0000-4000-8000-000000000003',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":0,"label":"a","is_low_trigger":true},{"value":1,"label":"b","is_low_trigger":false}]'::jsonb)$$);

select tl09_try('blocked', 'R8  a seven-point scale is refused',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"a","is_low_trigger":true},{"value":2,"label":"b","is_low_trigger":false},
        {"value":3,"label":"c","is_low_trigger":false},{"value":4,"label":"d","is_low_trigger":false},
        {"value":5,"label":"e","is_low_trigger":false},{"value":6,"label":"f","is_low_trigger":false},
        {"value":7,"label":"g","is_low_trigger":false}]'::jsonb)$$);

select tl09_try('blocked', 'R9  an all-trigger scale is refused',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":0,"label":"a","is_low_trigger":true},{"value":1,"label":"b","is_low_trigger":true}]'::jsonb)$$);

-- ---------------------------------------------------------------------------
-- R10-R11. The two workshops hold DIFFERENT scales at the same time.
-- ---------------------------------------------------------------------------

select tl09_try('permitted', 'R10 the first admin sets a 3-point 1-3 scale',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"not yet","is_low_trigger":true},
        {"value":2,"label":"getting there","is_low_trigger":false},
        {"value":3,"label":"there","is_low_trigger":false}]'::jsonb)$$);

select tl09_try('permitted', 'R11 the second admin sets a 6-point 0-5 scale, triggers on 1 and 2',
  '9b000000-0000-4000-8000-000000000002',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000002',
      '[{"value":0,"label":"absent","is_low_trigger":false},
        {"value":1,"label":"weak","is_low_trigger":true},
        {"value":2,"label":"thin","is_low_trigger":true},
        {"value":3,"label":"adequate","is_low_trigger":false},
        {"value":4,"label":"strong","is_low_trigger":false},
        {"value":5,"label":"exemplary","is_low_trigger":false}]'::jsonb)$$);

select tl09_assert(
  'R12 both scales coexist, at their own sizes, with their own triggers',
  (select count(*) from scale_point where workshop_id = '90900000-0000-4000-8000-000000000001') = 3
  and (select count(*) from scale_point where workshop_id = '90900000-0000-4000-8000-000000000002') = 6
  -- The 6-point workshop's triggers are 1 and 2, which is NOT "the bottom N" —
  -- 0 is not a trigger. No threshold rule can express that, which is the whole
  -- reason `is_low_trigger` is a column.
  and (select array_agg(value order by value) from scale_point
        where workshop_id = '90900000-0000-4000-8000-000000000002' and is_low_trigger) = array[1,2]::smallint[],
  (select string_agg(workshop_id::text || '=' || value::text ||
                     case when is_low_trigger then '*' else '' end, ' ' order by workshop_id, value)
     from scale_point where workshop_id in ('90900000-0000-4000-8000-000000000001',
                                            '90900000-0000-4000-8000-000000000002'))
);

-- ---------------------------------------------------------------------------
-- R13-R16. The remap path, which is the sharpest thing in this spec.
-- ---------------------------------------------------------------------------

-- Two observations on point 3 of the 3-point workshop, so removing it costs.
insert into observation (id, capture_client_id, workshop_id, participant_id, participant_name,
                         ksa_code, text, source_excerpt, evidence_designation,
                         sentiment_flag, confidence, needs_review, origin)
values ('tl09-obs-1', 'tl09-cap-1', '90900000-0000-4000-8000-000000000001',
        '90900000-0000-4000-8000-00000000f001', 'Three Person', 'Q1', 'x', 'x', 3,
        'neutral', 'high', false, 'individual'),
       ('tl09-obs-2', 'tl09-cap-1', '90900000-0000-4000-8000-000000000001',
        '90900000-0000-4000-8000-00000000f001', 'Three Person', 'Q1', 'y', 'y', 3,
        'neutral', 'high', false, 'individual');

select tl09_try('blocked', 'R13 removing a point that holds evidence is REFUSED without a mapping',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"not yet","is_low_trigger":true},
        {"value":2,"label":"getting there","is_low_trigger":false}]'::jsonb)$$);

select tl09_assert(
  'R14 the refused save changed nothing: the scale and the evidence both stand',
  (select count(*) from scale_point where workshop_id = '90900000-0000-4000-8000-000000000001') = 3
  and (select count(*) from observation where id in ('tl09-obs-1','tl09-obs-2')
        and evidence_designation = 3 and remapped_from is null) = 2,
  'scale still 3 points; both observations still at 3, unmarked'
);

select tl09_try('blocked', 'R15 a mapping onto a value the NEW scale lacks is refused too',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"not yet","is_low_trigger":true},
        {"value":2,"label":"getting there","is_low_trigger":false}]'::jsonb,
      '{"3": 9}'::jsonb)$$);

select tl09_try('permitted', 'R16 with an explicit mapping the save is accepted',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"not yet","is_low_trigger":true},
        {"value":2,"label":"getting there","is_low_trigger":false}]'::jsonb,
      '{"3": 2}'::jsonb)$$);

select tl09_assert(
  'R17 both observations moved to 2 and BOTH carry the mark saying they were 3',
  (select count(*) from observation where id in ('tl09-obs-1','tl09-obs-2')
    and evidence_designation = 2 and remapped_from = 3) = 2,
  (select string_agg(id || '=' || evidence_designation::text ||
                     ' from ' || coalesce(remapped_from::text, 'null'), ', ' order by id)
     from observation where id in ('tl09-obs-1','tl09-obs-2'))
);

-- Move them again. `remapped_from` must still say 3 — where they STARTED — not 2.
select tl09_try('permitted', 'R18 a second remap is accepted',
  '9a000000-0000-4000-8000-000000000001',
  $$select set_workshop_scale('90900000-0000-4000-8000-000000000001',
      '[{"value":1,"label":"not yet","is_low_trigger":true},
        {"value":4,"label":"renumbered","is_low_trigger":false}]'::jsonb,
      '{"2": 4}'::jsonb)$$);

select tl09_assert(
  'R19 a value moved twice still records where it ORIGINALLY was, not the last hop',
  (select count(*) from observation where id in ('tl09-obs-1','tl09-obs-2')
    and evidence_designation = 4 and remapped_from = 3) = 2,
  (select string_agg(id || '=' || evidence_designation::text ||
                     ' from ' || coalesce(remapped_from::text, 'null'), ', ' order by id)
     from observation where id in ('tl09-obs-1','tl09-obs-2'))
);

-- ---------------------------------------------------------------------------
-- R20. The scale-pinning constraints are gone, which is what lets a 5 be stored.
-- ---------------------------------------------------------------------------

select tl09_assert(
  'R20 no check constraint still pins a designation to 0-3',
  (select count(*) from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and con.contype = 'c'
     and c.relname in ('observation','verification_verdict','mentoring_conversation')
     and pg_get_constraintdef(con.oid) ~ 'designation') = 0,
  'observation, verification_verdict and mentoring_conversation are all un-pinned'
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------

select verdict, expect, label, outcome from tl09_results order by seq;
