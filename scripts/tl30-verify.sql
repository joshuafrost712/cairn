-- tl-30 acceptance harness: is the matrix right, and does it actually hold?
--
--   node scripts/apply-migration.mjs scripts/tl30-verify.sql
--
-- Shape borrowed wholesale from scripts/tl25-verify.sql, including its
-- hardest-won lesson: **a `blocked` case that returns nothing for the WRONG
-- reason is a false green.** RLS denies by returning zero rows rather than by
-- erroring, so a typo in a table name and a policy working correctly look
-- identical from here. Every negative below is therefore paired with the
-- positive that proves the same query shape works when it should.
--
-- Three groups of checks, and they answer different questions:
--
--   A. STATE. Are the eighteen pairs the ones Joshua asked for? No auth needed,
--      and this is the half that would catch a data entry error in the roster
--      script.
--   B. THE REAL ACCOUNTS. Joshua, Mathew Thomas and Irene van Riezen have signed
--      up, so their reads are exercised as themselves against the real pairs.
--      This is the highest-value group: it is the actual configuration, not a
--      model of it.
--   C. FIXTURES. Nikki, Viji and Angie have not signed up as of 2026-08-17, so
--      the behaviours only they exercise — a reviewer-only `participant` account,
--      an evaluator with no pair, the write path — are proved with throwaway
--      accounts. Everything created here is prefixed `tl30-` and removed at the
--      bottom of this same file.
--
-- The file is read-only with respect to real data. The only rows it writes are
-- its own fixtures, and the last block deletes them on the prefix alone.

drop table if exists tl30_results;
create table tl30_results (
  seq     serial primary key,
  verdict text,
  expect  text,
  label   text,
  outcome text
);

drop function if exists tl30_try(text, text, uuid, text);
create or replace function tl30_try(_expect text, _label text, _uid uuid, _sql text)
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

  insert into tl30_results (verdict, expect, label, outcome)
  values (case
            when _expect = 'blocked' then case when _errored or _count = 0 then 'PASS' else 'FAIL' end
            else case when not _errored and _count > 0 then 'PASS' else 'FAIL' end
          end,
          _expect, _label, _outcome);
end $$;

-- For a write that must RAISE rather than return nothing. `tl30_try` would score a
-- refused insert and a silently-filtered one the same way, and for the guard
-- trigger and the RPC the difference is the whole point.
drop function if exists tl30_raises(text, uuid, text, text);
create or replace function tl30_raises(_label text, _uid uuid, _sql text, _expect_slug text)
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
    insert into tl30_results (verdict, expect, label, outcome)
    values ('FAIL', 'raises', _label, 'the statement succeeded');
    return;
  exception when others then
    _msg := sqlerrm;
  end;
  reset role;
  insert into tl30_results (verdict, expect, label, outcome)
  values (case when _msg like '%' || _expect_slug || '%' then 'PASS' else 'FAIL' end,
          'raises', _label, _msg);
end $$;

drop function if exists tl30_assert(text, boolean, text);
create or replace function tl30_assert(_label text, _condition boolean, _detail text)
returns void
language plpgsql
as $$
begin
  insert into tl30_results (verdict, expect, label, outcome)
  values (case when _condition then 'PASS' else 'FAIL' end, 'state', _label, _detail);
end $$;

-- ---------------------------------------------------------------------------
-- A. STATE. The matrix Joshua asked for, asserted row by row.
-- ---------------------------------------------------------------------------

do $$
declare
  _cc     uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _psalms uuid := '11111111-1111-1111-1111-111111111111';
  _josh_cc   uuid := '30400000-0000-4000-8000-000000000011';
  _mathew_cc uuid := '30400000-0000-4000-8000-000000000012';
  _irene_cc  uuid := '30400000-0000-4000-8000-000000000013';
  _viji_cc   uuid := '30400000-0000-4000-8000-000000000014';
  _josh_ps   uuid := '30400000-0000-4000-8000-000000000021';
  _viji_ps   uuid := '30400000-0000-4000-8000-000000000022';
  _n int;
  _got text;
begin
  select count(*) into _n from instructor_reviewer;
  perform tl30_assert('eighteen pairs in total', _n = 18, format('%s', _n));

  -- Each reviewer's list, compared as a sorted string so a missing or extra grant
  -- shows up as the actual value rather than as a count.
  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'josh_frost@sil.org';
  perform tl30_assert('Crash Course: Joshua reviews Irene and Mathew',
                      _got = 'Irene van Riezen, Mathew Thomas', coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'mathewtperumal@gmail.com';
  perform tl30_assert('Crash Course: Mathew reviews Irene and Joshua',
                      _got = 'Irene van Riezen, Joshua C. Frost', coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'irene@sall.com';
  perform tl30_assert('Crash Course: Irene reviews Joshua and Mathew',
                      _got = 'Joshua C. Frost, Mathew Thomas', coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'nikkicm23@gmail.com';
  perform tl30_assert('Crash Course: Nikki reviews all four',
                      _got = 'Irene van Riezen, Joshua C. Frost, Mathew Thomas, Viji Mathew',
                      coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'viji_mathew@sil.org';
  perform tl30_assert('Crash Course: Viji reviews the three co-facilitators',
                      _got = 'Irene van Riezen, Joshua C. Frost, Mathew Thomas',
                      coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _psalms and r.reviewer_email = 'nikkicm23@gmail.com';
  perform tl30_assert('Songs: Nikki reviews Joshua and Viji',
                      _got = 'Joshua C. Frost, Viji Mathew', coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _psalms and r.reviewer_email = 'angeline_foo@sil.org';
  perform tl30_assert('Songs: Angie reviews Joshua and Viji',
                      _got = 'Joshua C. Frost, Viji Mathew', coalesce(_got, '(none)'));

  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _psalms and r.reviewer_email = 'viji_mathew@sil.org';
  perform tl30_assert('Songs: Viji reviews Joshua', _got = 'Joshua C. Frost', coalesce(_got, '(none)'));

  -- THE ASYMMETRY, asserted from the other side. Joshua's instruction was that
  -- Viji is reviewed only by Nikki and Angie, and a later edit that "tidied" the
  -- matrix into everyone-reviews-everyone would pass every check above.
  select string_agg(r.reviewer_email, ', ' order by r.reviewer_email) into _got
    from instructor_reviewer r where r.instructor_participant_id = _viji_cc;
  perform tl30_assert('Viji is reviewed by Nikki alone on the Crash Course (Angie is not there)',
                      _got = 'nikkicm23@gmail.com', coalesce(_got, '(none)'));

  select string_agg(r.reviewer_email, ', ' order by r.reviewer_email) into _got
    from instructor_reviewer r where r.instructor_participant_id = _viji_ps;
  perform tl30_assert('Viji is reviewed by Nikki and Angie on the songs workshop',
                      _got = 'angeline_foo@sil.org, nikkicm23@gmail.com', coalesce(_got, '(none)'));

  -- Nobody reviews themselves. Belt and braces over the trigger, because a row
  -- inserted before the trigger existed would not have been caught by it.
  select count(*) into _n
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where lower(coalesce(p.registered_email, '')) = r.reviewer_email;
  perform tl30_assert('no self-review pair exists', _n = 0, format('%s', _n));

  -- Every pair names an instructor, in the workshop it claims.
  select count(*) into _n
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where p.category <> 'instructor' or p.workshop_id <> r.workshop_id;
  perform tl30_assert('every pair names an instructor of its own workshop', _n = 0, format('%s', _n));

  -- The rosters this spec must not have disturbed.
  select count(*) into _n from participant where workshop_id = _cc and category = 'participant';
  perform tl30_assert('the Crash Course still has four trainees', _n = 4, format('%s', _n));
  select count(*) into _n from participant where workshop_id = _psalms and category = 'participant';
  perform tl30_assert('the songs workshop still has 22 trainees', _n = 22, format('%s', _n));

  select count(*) into _n from activity where audience = 'instructor';
  perform tl30_assert('exactly two instructor events, one per workshop', _n = 2, format('%s', _n));
  select count(*) into _n from activity_ksa ak
    join activity a on a.id = ak.activity_id where a.audience = 'instructor';
  perform tl30_assert('three questions wired to each of them', _n = 6, format('%s', _n));

  -- Joshua asked for Mathew and Irene to have no songs-workshop access.
  select count(*) into _n from workshop_member m join app_user u on u.id = m.app_user_id
   where m.workshop_id = _psalms and lower(u.email) in ('mathewtperumal@gmail.com','irene@sall.com');
  perform tl30_assert('Mathew and Irene hold no songs-workshop membership', _n = 0, format('%s', _n));

  -- ...and they are still on its trainee roster, which is the half Joshua chose
  -- to keep. Losing this quietly would be the plausible over-correction.
  select count(*) into _n from participant
   where workshop_id = _psalms and category = 'participant'
     and lower(coalesce(registered_email, '')) in ('mathewtperumal@gmail.com','irene@sall.com');
  perform tl30_assert('and are still evaluated there as trainees', _n = 2, format('%s', _n));

  -- Angie is invited, and only to the songs workshop.
  select count(*) into _n from workshop_invitation
   where lower(email) = 'angeline_foo@sil.org' and workshop_id = _psalms and role = 'participant';
  perform tl30_assert('Angie is invited to the songs workshop as `participant`', _n = 1, format('%s', _n));
  select count(*) into _n from workshop_invitation
   where lower(email) = 'angeline_foo@sil.org' and workshop_id = _cc;
  perform tl30_assert('and is not invited to the Crash Course', _n = 0, format('%s', _n));

  perform tl30_assert('unused fixture ids are referenced', _josh_cc is not null and _mathew_cc is not null
                      and _irene_cc is not null and _josh_ps is not null, 'ids resolved');
end $$;

-- ---------------------------------------------------------------------------
-- B. THE REAL ACCOUNTS. Read-only, as themselves.
-- ---------------------------------------------------------------------------

do $$
declare
  _josh   uuid;
  _mathew uuid;
  _irene  uuid;
begin
  select auth_user_id into _josh   from app_user where email = 'josh_frost@sil.org';
  select auth_user_id into _mathew from app_user where email = 'mathewtperumal@gmail.com';
  select auth_user_id into _irene  from app_user where email = 'irene@sall.com';

  -- Mathew Thomas: an evaluator holding two pairs.
  perform tl30_try('allowed', 'Mathew reads Joshua''s instructor row', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000011'$q$);
  perform tl30_try('allowed', 'Mathew reads Irene''s instructor row', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000013'$q$);
  perform tl30_try('allowed', 'Mathew reads his OWN instructor row (he is its subject)', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000012'$q$);
  -- The asymmetry, enforced rather than merely configured.
  perform tl30_try('blocked', 'Mathew CANNOT read Viji''s instructor row', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000014'$q$);
  perform tl30_try('allowed', 'Mathew sees the Crash Course Instructor feedback event', _mathew,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000001'$q$);
  perform tl30_try('allowed', 'Mathew still reads the Crash Course trainees', _mathew,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'participant'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read the songs workshop''s instructor event', _mathew,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000002'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read the songs workshop''s trainees', _mathew,
    $q$select 1 from participant where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);
  -- He sees the pairs that name him, and not the rest of the matrix.
  perform tl30_try('allowed', 'Mathew reads his own reviewer pairs', _mathew,
    $q$select 1 from instructor_reviewer where reviewer_email = 'mathewtperumal@gmail.com'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read who reviews Viji', _mathew,
    $q$select 1 from instructor_reviewer
        where instructor_participant_id = '30400000-0000-4000-8000-000000000014'$q$);

  -- Irene: the mirror case, which catches a policy that happens to work for one
  -- person because of something else they hold.
  perform tl30_try('allowed', 'Irene reads Mathew''s instructor row', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000012'$q$);
  perform tl30_try('blocked', 'Irene CANNOT read Viji''s instructor row', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000014'$q$);

  -- Joshua is chief_admin of both, so he reads everything including Viji.
  perform tl30_try('allowed', 'Joshua reads Viji''s instructor row (chief admin)', _josh,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000014'$q$);
  perform tl30_try('allowed', 'Joshua reads the whole Crash Course matrix', _josh,
    $q$select 1 from instructor_reviewer
        where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);
  perform tl30_try('allowed', 'Joshua reads both instructor events', _josh,
    $q$select 1 from activity where audience = 'instructor'$q$);

  -- Joshua holds no pair naming himself, in either workshop. The UI derives the
  -- roster from the pairs, so this is what keeps his own name off his grid.
  perform tl30_try('blocked', 'Joshua holds no pair to review HIMSELF', _josh,
    $q$select 1 from instructor_reviewer
        where reviewer_email = 'josh_frost@sil.org'
          and instructor_participant_id in ('30400000-0000-4000-8000-000000000011',
                                            '30400000-0000-4000-8000-000000000021')$q$);
  perform tl30_try('blocked', 'and none to review Viji', _josh,
    $q$select 1 from instructor_reviewer
        where reviewer_email = 'josh_frost@sil.org'
          and instructor_participant_id in ('30400000-0000-4000-8000-000000000014',
                                            '30400000-0000-4000-8000-000000000022')$q$);
end $$;

-- ---------------------------------------------------------------------------
-- C. FIXTURES. The accounts that do not exist yet, and the write paths.
--
--    Three throwaways on the CRASH COURSE, all prefixed tl30-:
--      reviewer  — `participant` role plus one pair. Stands in for Angie.
--      outsider  — `evaluator` role and no pair. The person the feature must
--                  be invisible to.
--      subject   — an instructor with no reviewer pairs at all, to prove that
--                  being written about grants a read and nothing else.
-- ---------------------------------------------------------------------------

do $$
declare
  _cc      uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _josh_cc uuid := '30400000-0000-4000-8000-000000000011';
  _josh    uuid;
  _joshapp uuid;
  _rev     uuid := gen_random_uuid();
  _out     uuid := gen_random_uuid();
begin
  select auth_user_id, id into _josh, _joshapp from app_user where email = 'josh_frost@sil.org';

  insert into workshop_invitation (workshop_id, email, role, invited_by, invited_by_email, status)
  values (_cc, 'tl30-reviewer@example.org', 'participant', _joshapp, 'josh_frost@sil.org', 'pending'),
         (_cc, 'tl30-outsider@example.org', 'evaluator',   _joshapp, 'josh_frost@sil.org', 'pending');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (_rev, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-reviewer@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Reviewer Only"}'::jsonb, now(), now()),
         (_out, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-outsider@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Outsider"}'::jsonb, now(), now());

  -- One pair for the reviewer-only account: Joshua, on the Crash Course.
  insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id, granted_by)
  values (_cc, 'tl30-reviewer@example.org', _josh_cc, _joshapp);
end $$;

-- The guard trigger and the write path. Run as `postgres` where the actor does not
-- matter, and as a real account where it does.
do $$
declare
  _cc      uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _psalms  uuid := '11111111-1111-1111-1111-111111111111';
  _mathew  uuid;
  _josh    uuid;
begin
  select auth_user_id into _mathew from app_user where email = 'mathewtperumal@gmail.com';
  select auth_user_id into _josh   from app_user where email = 'josh_frost@sil.org';

  -- The trigger. Three ways a bad pair can be written, each refused by slug.
  perform tl30_raises('a self-review pair is refused (matched on the roster address)', null,
    format($q$insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id)
             values (%L, 'josh_frost@sil.org', '30400000-0000-4000-8000-000000000011')$q$, _cc),
    'tl30.self_review');

  perform tl30_raises('a self-review pair is refused (matched through person_id)', null,
    format($q$insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id)
             values (%L, 'mathewtperumal@gmail.com', '30400000-0000-4000-8000-000000000012')$q$, _cc),
    'tl30.self_review');

  perform tl30_raises('a pair naming a TRAINEE is refused', null,
    format($q$insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id)
             select %L, 'tl30-outsider@example.org', id from participant
              where workshop_id = %L and category = 'participant' limit 1$q$, _cc, _cc),
    'tl30.not_an_instructor');

  perform tl30_raises('a pair pointing at another workshop''s instructor is refused', null,
    format($q$insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id)
             values (%L, 'tl30-outsider@example.org', '30400000-0000-4000-8000-000000000021')$q$, _cc),
    'tl30.participant_is_in_another_workshop');

  -- The uppercase check constraint, which is what keeps one grant from becoming
  -- two rows that only one of them is ever matched against.
  perform tl30_raises('a non-lowercased address is refused', null,
    format($q$insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id)
             values (%L, 'Tl30-Outsider@Example.org', '30400000-0000-4000-8000-000000000011')$q$, _cc),
    'instructor_reviewer');

  -- The RPC. Mathew is an evaluator, not the chief admin.
  perform tl30_raises('a non-chief-admin cannot grant a pair', _mathew,
    format($q$select set_instructor_review_pair(%L, 'tl30-outsider@example.org',
             '30400000-0000-4000-8000-000000000011', true)$q$, _cc),
    'tl30.not_the_chief_admin_of_this_workshop');

  -- ...and the positive, so the refusal above is known to be about the role.
  perform tl30_try('allowed', 'the chief admin CAN grant a pair', _josh,
    format($q$select set_instructor_review_pair(%L, 'tl30-outsider@example.org',
             '30400000-0000-4000-8000-000000000011', true)$q$, _cc));
  perform tl30_try('allowed', 'and revoke it again', _josh,
    format($q$select set_instructor_review_pair(%L, 'tl30-outsider@example.org',
             '30400000-0000-4000-8000-000000000011', false)$q$, _cc));

  -- The RPC refuses a self-pair too, through the same trigger, so the app cannot
  -- be used to write what the script may not.
  perform tl30_raises('the RPC cannot be used to grant a self-review', _josh,
    format($q$select set_instructor_review_pair(%L, 'josh_frost@sil.org',
             '30400000-0000-4000-8000-000000000011', true)$q$, _cc),
    'tl30.self_review');

  perform tl30_assert('psalms id referenced', _psalms is not null, 'ok');
end $$;

-- What each throwaway may read and write.
do $$
declare
  _cc  uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _rev uuid;
  _out uuid;
begin
  select auth_user_id into _rev from app_user where email = 'tl30-reviewer@example.org';
  select auth_user_id into _out from app_user where email = 'tl30-outsider@example.org';

  -- The reviewer-only account: Angie's shape. One instructor, one event, nothing else.
  perform tl30_try('allowed', 'reviewer-only reads the instructor they were named for', _rev,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000011'$q$);
  perform tl30_try('allowed', 'reviewer-only sees the Instructor feedback event', _rev,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000001'$q$);
  perform tl30_try('blocked', 'reviewer-only CANNOT read a single trainee', _rev,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'participant'$q$);
  perform tl30_try('blocked', 'reviewer-only CANNOT read another instructor', _rev,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000013'$q$);
  -- The same query shape as the ALLOWED case two lines up, with only the audience
  -- changed. Written that way on purpose: a `blocked` result proves nothing unless
  -- the identical shape is known to return rows when it should.
  perform tl30_try('blocked', 'reviewer-only CANNOT read a teaching event', _rev,
    $q$select 1 from activity
        where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
          and audience = 'participant'$q$);
  perform tl30_try('blocked', 'reviewer-only CANNOT read any observation about a trainee', _rev,
    $q$select 1 from observation
        where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
          and subject_kind = 'participant'$q$);
  perform tl30_try('blocked', 'reviewer-only CANNOT read the assignment rota', _rev,
    $q$select 1 from report_assignment
        where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'$q$);

  -- An ordinary Crash Course evaluator with no pair. The feature does not exist
  -- for them, which is Joshua's "it doesn't pop up for anything else".
  perform tl30_try('allowed', 'outsider evaluator reads the trainees, as before', _out,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'participant'$q$);
  perform tl30_try('blocked', 'outsider evaluator sees NO instructor row', _out,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'instructor'$q$);
  perform tl30_try('blocked', 'outsider evaluator sees NO instructor event', _out,
    $q$select 1 from activity where audience = 'instructor'$q$);
  perform tl30_try('blocked', 'outsider evaluator sees NO pair', _out,
    $q$select 1 from instructor_reviewer$q$);
end $$;

-- Writing a capture: the insert policy, in both directions.
do $$
declare
  _cc  uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _rev uuid;
  _out uuid;
begin
  select auth_user_id into _rev from app_user where email = 'tl30-reviewer@example.org';
  select auth_user_id into _out from app_user where email = 'tl30-outsider@example.org';

  perform tl30_try('allowed', 'a pair holder CAN write an instructor capture', _rev,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind, focus_participant_id)
        values ('tl30-cap-ok', 'tl30-reviewer@example.org',
                '30300000-0000-4000-8000-000000000001',
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'instructor',
                '30400000-0000-4000-8000-000000000011')$q$);

  -- The same insert, by somebody holding no pair for that instructor. This is the
  -- single most important negative in the file.
  perform tl30_raises('a non-pair-holder CANNOT write an instructor capture', _out,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind, focus_participant_id)
        values ('tl30-cap-refused', 'tl30-outsider@example.org',
                '30300000-0000-4000-8000-000000000001',
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'instructor',
                '30400000-0000-4000-8000-000000000011')$q$,
    'row-level security');

  -- And the reviewer-only account may not write a TRAINEE capture, which is the
  -- other half of the same policy.
  perform tl30_raises('a reviewer-only account CANNOT write a trainee capture', _rev,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind)
        values ('tl30-cap-trainee', 'tl30-reviewer@example.org', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'participant')$q$,
    'row-level security');

  -- The check constraint: an instructor capture must name its subject.
  perform tl30_raises('an instructor capture with no focus participant is refused', null,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind)
        values ('tl30-cap-nofocus', 'tl30-reviewer@example.org', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'instructor')$q$,
    'evaluation_instructor_needs_focus');
  perform tl30_assert('cc id referenced', _cc is not null, 'ok');
end $$;

-- Who can READ the capture just written. The subject, its author, and the chief
-- admin; not a chief evaluator and not another reviewer.
do $$
declare
  _josh   uuid;
  _mathew uuid;
  _rev    uuid;
  _out    uuid;
begin
  select auth_user_id into _josh   from app_user where email = 'josh_frost@sil.org';
  select auth_user_id into _mathew from app_user where email = 'mathewtperumal@gmail.com';
  select auth_user_id into _rev    from app_user where email = 'tl30-reviewer@example.org';
  select auth_user_id into _out    from app_user where email = 'tl30-outsider@example.org';

  perform tl30_try('allowed', 'the author reads their own instructor capture', _rev,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  perform tl30_try('allowed', 'the SUBJECT reads it (Joshua, and he is also chief admin)', _josh,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  -- Mathew holds a pair on Joshua, so he may WRITE about him. He may not read what
  -- somebody else wrote. This is the distinction the whole read policy turns on.
  perform tl30_try('blocked', 'another reviewer of the same person CANNOT read it', _mathew,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  perform tl30_try('blocked', 'an outsider evaluator CANNOT read it', _out,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
end $$;

-- ---------------------------------------------------------------------------
-- Teardown. On the tl30- prefix only, and before the report so a failure in the
-- middle of the file still leaves the database clean.
-- ---------------------------------------------------------------------------

delete from evaluation where client_id like 'tl30-cap-%';
delete from instructor_reviewer where reviewer_email like 'tl30-%@example.org';
delete from workshop_member where app_user_id in
  (select id from app_user where email like 'tl30-%@example.org');
delete from workshop_invitation where email like 'tl30-%@example.org';
delete from person_profile where person_id in
  (select id from person where primary_email like 'tl30-%@example.org');
delete from app_user where email like 'tl30-%@example.org';
delete from person where primary_email like 'tl30-%@example.org';
delete from auth.users where email like 'tl30-%@example.org';

select jsonb_pretty(jsonb_build_object(
  'summary', (select jsonb_object_agg(verdict, n) from (select verdict, count(*) n from tl30_results group by verdict) s),
  'failures', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'expect', expect, 'outcome', outcome) order by seq)
                        from tl30_results where verdict = 'FAIL'), '[]'::jsonb),
  'all', (select jsonb_agg(jsonb_build_object('v', verdict, 'label', label, 'outcome', outcome) order by seq)
          from tl30_results)
));
