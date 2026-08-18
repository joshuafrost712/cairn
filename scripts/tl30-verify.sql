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
--   A. STATE. Are the fourteen pairs the ones Joshua asked for? No auth needed,
--      and this is the half that would catch a data entry error in the roster
--      script.
--   B. THE REAL ACCOUNTS. Joshua, Mathew Thomas and Irene van Riezen have signed
--      up, so their reads are exercised as themselves against the real pairs.
--      This is the highest-value group: it is the actual configuration, not a
--      model of it.
--   C. FIXTURES. Nikki, Viji and Angie have not signed up as of 2026-08-17, so
--      the behaviours only they exercise — a reviewer-only `participant` account,
--      an evaluator with no pair, a second reviewer of the same instructor, the
--      write path — are proved with throwaway accounts. Everything created here
--      is prefixed `tl30-` and removed at the bottom of this same file.
--
-- AMENDED 2026-08-18, when Joshua narrowed the matrix so that Mathew and Irene,
-- who evaluate the trainees, review no instructor at all. Two things that change
-- about this file and are worth reading before editing it again.
--
-- Mathew and Irene now hold a shape no fixture had: a trainee-side evaluator who
-- is ALSO an instructor subject. Group B is rewritten around that, in both
-- directions — the instructor half closes, the trainee half must not.
--
-- And the sharpest question in the file, "may another reviewer of the same person
-- read this?", was asked with Mathew as the co-reviewer. He is not one any more,
-- so asking it of him would still pass while testing nothing but the outsider
-- case that is already covered. A `tl30-coreviewer` fixture now holds the second
-- pair on Joshua and asks it properly. Narrowing a matrix can quietly downgrade
-- an assertion from the question it was written for to one that is merely true.
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
  perform tl30_assert('fourteen pairs in total', _n = 14, format('%s', _n));

  -- Each reviewer's list, compared as a sorted string so a missing or extra grant
  -- shows up as the actual value rather than as a count.
  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.workshop_id = _cc and r.reviewer_email = 'josh_frost@sil.org';
  perform tl30_assert('Crash Course: Joshua reviews Irene and Mathew',
                      _got = 'Irene van Riezen, Mathew Thomas', coalesce(_got, '(none)'));

  -- The 2026-08-18 narrowing, as state. Mathew and Irene teach and also evaluate
  -- the trainees, and Joshua's rule is that the second job costs them the first
  -- one's reciprocity. Asserted as an aggregate over BOTH workshops rather than
  -- over the Crash Course alone, so a grant added somewhere else does not slip
  -- past a check that only looked where the grants used to be.
  select string_agg(p.name, ', ' order by p.name) into _got
    from instructor_reviewer r join participant p on p.id = r.instructor_participant_id
   where r.reviewer_email in ('mathewtperumal@gmail.com', 'irene@sall.com');
  perform tl30_assert('Mathew and Irene review no instructor, in any workshop',
                      _got is null, coalesce(_got, '(none)'));

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
  perform tl30_assert('Songs: Angeline Foo reviews Joshua and Viji',
                      _got = 'Joshua C. Frost, Viji Mathew', coalesce(_got, '(none)'));

  -- Joshua confirmed 2026-08-17: "Nikki is never evaluated. She is only an
  -- evaluator." She facilitates two Crash Course lessons and co-leads the songs
  -- workshop, so adding her to the instructor roster is the plausible, wrong
  -- tidy-up. This is the assertion that would fail if somebody made it.
  select count(*) into _n from participant
   where category = 'instructor' and lower(coalesce(registered_email, '')) = 'nikkicm23@gmail.com';
  perform tl30_assert('Nikki is an evaluator only and is never a subject', _n = 0, format('%s', _n));

  -- Angeline has no roster row either (she reviews, she is not reviewed), so the
  -- only thing carrying her name before she signs up is her `person` row. An
  -- administrator opening the grid should see a name, not an address.
  select p.display_name into _got from person p where p.primary_email = 'angeline_foo@sil.org';
  perform tl30_assert('Angeline Foo has a person row naming her before sign-up',
                      _got = 'Angeline Foo (Angie)', coalesce(_got, '(no person row)'));
  select pr.headline into _got from person p join person_profile pr on pr.person_id = p.id
   where p.primary_email = 'angeline_foo@sil.org';
  perform tl30_assert('and her SIL role is on file', _got like '%Senior Translation Consultant%',
                      coalesce(_got, '(no profile)'));

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
  --
  -- Amended 2026-08-18. This read `_n = 4` and failed on the first morning of the
  -- course at 8, because four more trainees had legitimately arrived. A count is
  -- the wrong assertion for a roster that is allowed to grow: it scores the
  -- workshop filling up as a defect, and the next reader's cheapest fix is to bump
  -- the number, which quietly retires the invariant. What tl-30 must not do is
  -- REMOVE a trainee or relabel one as an instructor, so that is what is asserted:
  -- every one of tl-25's four is still on file and still a trainee.
  --
  -- Amended again 2026-08-18, and NOT by this spec: commit 8e6e643 took Sibaji
  -- Digal out of the Crash Course after he cancelled, and put Jael and Jillian
  -- into Psalms. Both assertions below went red on a roster change that was
  -- deliberate and correct. They are moved to the roster as that commit left it
  -- rather than loosened, because the invariant is still worth having and a
  -- harness nobody trusts is a harness nobody reads. `...000003` is Sibaji and
  -- is deliberately absent from the list.
  select count(*) into _n from participant
   where workshop_id = _cc and category = 'participant'
     and id in ('cc400000-0000-4000-8000-000000000001','cc400000-0000-4000-8000-000000000002',
                'cc400000-0000-4000-8000-000000000004');
  perform tl30_assert('tl-25''s trainees, less the one who cancelled, are all still trainees',
    _n = 3, format('%s of 3', _n));
  select count(*) into _n from participant where workshop_id = _cc and category = 'participant';
  perform tl30_assert('and the roster has only grown since', _n >= 3, format('%s now', _n));
  select count(*) into _n from participant where workshop_id = _psalms and category = 'participant';
  perform tl30_assert('the songs workshop has 24 trainees', _n = 24, format('%s', _n));

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

  -- Mathew Thomas, since 2026-08-18: a trainee-side evaluator who is also an
  -- instructor SUBJECT and holds no pair. Being written about grants a read of
  -- your own row and of what is written about you, and nothing else. Every
  -- negative below is paired with the positive of the same shape, because a
  -- reviewer who has just lost two grants returns zero rows for a great many
  -- wrong reasons as well as the right one.
  perform tl30_try('blocked', 'Mathew CANNOT read Joshua''s instructor row any more', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000011'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read Irene''s instructor row any more', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000013'$q$);
  perform tl30_try('allowed', 'Mathew reads his OWN instructor row (he is its subject)', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000012'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read Viji''s instructor row', _mathew,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000014'$q$);
  -- The event leaves his schedule with the pairs: activity_select gates an
  -- instructor-audience event on reviews_any_instructor(), which is now false for
  -- him. This is what makes the narrowing visible on his phone rather than only
  -- at submit time.
  perform tl30_try('blocked', 'Mathew no longer sees the Crash Course Instructor feedback event', _mathew,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000001'$q$);
  perform tl30_try('allowed', 'Mathew still reads the Crash Course trainees', _mathew,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'participant'$q$);
  perform tl30_try('allowed', 'and still sees the teaching events he evaluates them at', _mathew,
    $q$select 1 from activity where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and audience = 'participant'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read the songs workshop''s instructor event', _mathew,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000002'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read the songs workshop''s trainees', _mathew,
    $q$select 1 from participant where workshop_id = '11111111-1111-1111-1111-111111111111'$q$);
  -- He holds no pair of his own, and still sees the ones naming him as subject.
  -- The pair he can read is the evidence that the empty result above is about the
  -- grants being gone rather than about instructor_reviewer being unreadable.
  perform tl30_try('blocked', 'Mathew holds no reviewer pair at all', _mathew,
    $q$select 1 from instructor_reviewer where reviewer_email = 'mathewtperumal@gmail.com'$q$);
  perform tl30_try('allowed', 'but reads the pairs naming HIM, so he knows who may review him', _mathew,
    $q$select 1 from instructor_reviewer
        where instructor_participant_id = '30400000-0000-4000-8000-000000000012'$q$);
  perform tl30_try('blocked', 'Mathew CANNOT read who reviews Viji', _mathew,
    $q$select 1 from instructor_reviewer
        where instructor_participant_id = '30400000-0000-4000-8000-000000000014'$q$);

  -- Irene: the mirror case, which catches a policy that happens to work for one
  -- person because of something else they hold.
  perform tl30_try('blocked', 'Irene CANNOT read Mathew''s instructor row any more', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000012'$q$);
  perform tl30_try('blocked', 'Irene CANNOT read Joshua''s instructor row any more', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000011'$q$);
  perform tl30_try('allowed', 'Irene reads her OWN instructor row', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000013'$q$);
  perform tl30_try('blocked', 'Irene CANNOT read Viji''s instructor row', _irene,
    $q$select 1 from participant where id = '30400000-0000-4000-8000-000000000014'$q$);
  perform tl30_try('blocked', 'Irene no longer sees the Instructor feedback event', _irene,
    $q$select 1 from activity where id = '30300000-0000-4000-8000-000000000001'$q$);
  perform tl30_try('allowed', 'Irene still reads the Crash Course trainees', _irene,
    $q$select 1 from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
        and category = 'participant'$q$);

  -- The write half of the same rule. A capture is refused by the insert policy
  -- even from a device that never refreshed and still offers the screen.
  perform tl30_try('blocked', 'Mathew CANNOT write an instructor capture about Joshua', _mathew,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind, focus_participant_id)
        values ('tl30-cap-mathew-denied', 'mathewtperumal@gmail.com', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'instructor',
                '30400000-0000-4000-8000-000000000011') returning 1$q$);
  perform tl30_try('blocked', 'Irene CANNOT write an instructor capture about Mathew', _irene,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind, focus_participant_id)
        values ('tl30-cap-irene-denied', 'irene@sall.com', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'instructor',
                '30400000-0000-4000-8000-000000000012') returning 1$q$);
  -- The control. Both refusals above must be about the KIND of capture, not about
  -- these two having lost the ability to record anything.
  perform tl30_try('allowed', 'but Mathew CAN still write an ordinary trainee capture', _mathew,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind)
        values ('tl30-cap-mathew-trainee', 'mathewtperumal@gmail.com', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'participant') returning 1$q$);

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
--    Four throwaways on the CRASH COURSE, all prefixed tl30-:
--      reviewer   — `participant` role plus one pair. Stands in for Angie.
--      coreviewer — `participant` role plus the SAME pair. Stands in for Nikki or
--                   Viji, and exists only to ask whether two people who both
--                   review Joshua can read each other's words about him.
--      outsider   — `evaluator` role and no pair. The person the feature must
--                   be invisible to.
--      subject    — an instructor with no reviewer pairs at all, to prove that
--                   being written about grants a read and nothing else.
-- ---------------------------------------------------------------------------

do $$
declare
  _cc      uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _josh_cc uuid := '30400000-0000-4000-8000-000000000011';
  _josh    uuid;
  _joshapp uuid;
  _rev     uuid := gen_random_uuid();
  _co      uuid := gen_random_uuid();
  _out     uuid := gen_random_uuid();
  _chf     uuid := gen_random_uuid();
begin
  select auth_user_id, id into _josh, _joshapp from app_user where email = 'josh_frost@sil.org';

  insert into workshop_invitation (workshop_id, email, role, invited_by, invited_by_email, status)
  values (_cc, 'tl30-reviewer@example.org', 'participant',      _joshapp, 'josh_frost@sil.org', 'pending'),
         -- Added 2026-08-18 with the narrowing. Mathew used to be the second
         -- reviewer of Joshua and is not any more, so the co-reviewer question
         -- needed a holder or it would have gone on passing while testing the
         -- outsider case instead.
         (_cc, 'tl30-coreviewer@example.org', 'participant',    _joshapp, 'josh_frost@sil.org', 'pending'),
         (_cc, 'tl30-outsider@example.org', 'evaluator',        _joshapp, 'josh_frost@sil.org', 'pending'),
         -- Added 2026-08-18 by the review fixes. The chief evaluator is the role
         -- that could flip an observation's `subject_kind`, and no fixture held it,
         -- so the write policies on `observation` were never exercised by anyone
         -- entitled to write one.
         (_cc, 'tl30-chief@example.org',    'chief_evaluator',  _joshapp, 'josh_frost@sil.org', 'pending');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (_rev, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-reviewer@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Reviewer Only"}'::jsonb, now(), now()),
         (_co, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-coreviewer@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Co-Reviewer"}'::jsonb, now(), now()),
         (_out, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-outsider@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Outsider"}'::jsonb, now(), now()),
         (_chf, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'tl30-chief@example.org', crypt('never-used', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"TL30 Chief Evaluator"}'::jsonb, now(), now());

  -- One pair each for the two reviewer-only accounts, both naming Joshua. Two
  -- rows, one instructor: that is the whole point of the second account.
  insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id, granted_by)
  values (_cc, 'tl30-reviewer@example.org',   _josh_cc, _joshapp),
         (_cc, 'tl30-coreviewer@example.org', _josh_cc, _joshapp);
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
  _co     uuid;
  _out    uuid;
begin
  select auth_user_id into _josh   from app_user where email = 'josh_frost@sil.org';
  select auth_user_id into _mathew from app_user where email = 'mathewtperumal@gmail.com';
  select auth_user_id into _rev    from app_user where email = 'tl30-reviewer@example.org';
  select auth_user_id into _co     from app_user where email = 'tl30-coreviewer@example.org';
  select auth_user_id into _out    from app_user where email = 'tl30-outsider@example.org';

  perform tl30_try('allowed', 'the author reads their own instructor capture', _rev,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  perform tl30_try('allowed', 'the SUBJECT reads it (Joshua, and he is also chief admin)', _josh,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  -- The co-reviewer holds a pair on Joshua, so he may WRITE about him. He may not
  -- read what somebody else wrote. This is the distinction the whole read policy
  -- turns on, and it needs somebody who actually holds the pair: asking it of a
  -- non-reviewer tests the outsider case twice and this one not at all.
  perform tl30_try('blocked', 'another reviewer of the same person CANNOT read it', _co,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  perform tl30_try('blocked', 'an outsider evaluator CANNOT read it', _out,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
  -- Mathew is now a SUBJECT and not a reviewer, so his exclusion here is a
  -- different fact from the one above and worth keeping separately.
  perform tl30_try('blocked', 'an instructor subject CANNOT read a capture about somebody else', _mathew,
    $q$select 1 from evaluation where client_id = 'tl30-cap-ok'$q$);
end $$;

-- ---------------------------------------------------------------------------
-- D. THE ROUTED HALF, added 2026-08-18 by the second-AI review.
--
--    The block above asks the sharpest question in this file — "may another
--    reviewer of the same person read it?" — and asks it of `evaluation`, where
--    the answer was already no. It never asked it of `observation`, which holds
--    the same sentences after routing, and the answer there was YES: the policy
--    reached for `may_read_instructor_subject()`, whose first arm is holding a
--    pair. In the live matrix every instructor has three or four reviewers, so
--    this was the ordinary case.
--
--    Three more shapes go with it, each one a way to reach the same rows without
--    ever asking a SELECT policy: relabel a capture after inserting it, relabel an
--    observation as being about a trainee, or read the verdict instead of the
--    observation it is about.
-- ---------------------------------------------------------------------------

do $$
declare
  _cc      uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _josh_cc uuid := '30400000-0000-4000-8000-000000000011';
  _josh    uuid;
  _trainee text;
begin
  select auth_user_id into _josh from app_user where email = 'josh_frost@sil.org';
  select id::text into _trainee from participant
   where workshop_id = _cc and category = 'participant' limit 1;

  -- The routed instructor observation, written by the administrator who routes
  -- (tl-03), carrying the reviewer as its author. And a trainee observation beside
  -- it, which is the control for every negative below: without it, a `blocked`
  -- result could just mean the query shape is wrong.
  perform tl30_try('allowed', 'the chief admin CAN write an instructor observation', _josh,
    format($q$insert into observation (id, capture_client_id, workshop_id, participant_id,
              participant_name, ksa_code, text, source_excerpt, evidence_designation,
              sentiment_flag, confidence, origin, evaluator_email, subject_kind)
            values ('tl30-obs-instructor', 'tl30-cap-ok', %L, %L, 'TL30 Instructor',
                    'CC-INS1', 'routed sentence about a colleague', 'x', 2,
                    'neutral', 'medium', 'individual',
                    'tl30-reviewer@example.org', 'instructor')$q$, _cc, _josh_cc));

  perform tl30_try('allowed', 'and a trainee observation beside it, as the control', _josh,
    format($q$insert into observation (id, capture_client_id, workshop_id, participant_id,
              participant_name, ksa_code, text, source_excerpt, evidence_designation,
              sentiment_flag, confidence, origin, evaluator_email, subject_kind)
            values ('tl30-obs-trainee', 'tl30-cap-ok', %L, %L, 'TL30 Trainee',
                    'CC-EX1', 'routed sentence about a trainee', 'x', 2,
                    'neutral', 'medium', 'individual',
                    'tl30-outsider@example.org', 'participant')$q$, _cc, _trainee));
end $$;

do $$
declare
  _cc     uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _josh   uuid;
  _mathew uuid;
  _rev    uuid;
  _co     uuid;
  _out    uuid;
  _chf    uuid;
begin
  select auth_user_id into _josh   from app_user where email = 'josh_frost@sil.org';
  select auth_user_id into _mathew from app_user where email = 'mathewtperumal@gmail.com';
  select auth_user_id into _rev    from app_user where email = 'tl30-reviewer@example.org';
  select auth_user_id into _co     from app_user where email = 'tl30-coreviewer@example.org';
  select auth_user_id into _out    from app_user where email = 'tl30-outsider@example.org';
  select auth_user_id into _chf    from app_user where email = 'tl30-chief@example.org';

  -- The read rule on the routed row, in the same order as the capture block above,
  -- so the two can be compared line by line. They must now agree.
  perform tl30_try('allowed', 'the author reads their own routed instructor observation', _rev,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  perform tl30_try('allowed', 'the subject reads it (Joshua, also chief admin)', _josh,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  -- THE ONE THIS FILE WAS MISSING. The co-reviewer holds a pair on Joshua, so he
  -- may write about him; he may not read what Angie wrote about him.
  perform tl30_try('blocked', 'another reviewer of the SAME instructor CANNOT read it', _co,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  perform tl30_try('blocked', 'and an instructor subject cannot read it either', _mathew,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  perform tl30_try('blocked', 'an outsider evaluator CANNOT read it', _out,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  perform tl30_try('blocked', 'a chief evaluator CANNOT read it', _chf,
    $q$select 1 from observation where id = 'tl30-obs-instructor'$q$);
  perform tl30_try('allowed', 'and all three read the trainee observation, so the shape works', _out,
    $q$select 1 from observation where id = 'tl30-obs-trainee'$q$);
  perform tl30_try('allowed', 'the chief evaluator too', _chf,
    $q$select 1 from observation where id = 'tl30-obs-trainee'$q$);

  -- Relabelling, which is how you reach a row without a SELECT policy ever being
  -- asked. USING sees the OLD row, so an instructor observation is untouchable by
  -- the role that could previously publish it in one statement.
  perform tl30_try('blocked', 'a chief evaluator CANNOT flip an instructor observation to trainee', _chf,
    $q$update observation set subject_kind = 'participant'
        where id = 'tl30-obs-instructor' returning 1$q$);
  perform tl30_try('allowed', 'but CAN still edit a trainee observation, so the block is about the kind', _chf,
    $q$update observation set needs_review = true
        where id = 'tl30-obs-trainee' returning 1$q$);

  -- The same move on the capture: insert as a trainee capture, which any evaluating
  -- member may do, then PATCH it into an instructor review the pair gate would have
  -- refused. WITH CHECK now asks for the pair, which is what the insert policy asks.
  perform tl30_try('allowed', 'an outsider evaluator CAN write an ordinary trainee capture', _out,
    $q$insert into evaluation (client_id, evaluator_email, activity_id, workshop_id,
          source_language, answers, source_text, participant_scope, attestation,
          edit_history, created_at, updated_at, subject_kind)
        values ('tl30-cap-flip', 'tl30-outsider@example.org', null,
                '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'English', '{}'::jsonb, '', '[]'::jsonb,
                true, '[]'::jsonb, now(), now(), 'participant') returning 1$q$);
  perform tl30_raises('...and CANNOT then relabel it as an instructor review', _out,
    $q$update evaluation
          set subject_kind = 'instructor',
              focus_participant_id = '30400000-0000-4000-8000-000000000011'
        where client_id = 'tl30-cap-flip'$q$,
    'row-level security');

  -- The verdict, which carries a free-text note and was readable by every member.
  perform tl30_try('allowed', 'the author of the evidence CAN record a verdict on it', _rev,
    format($q$insert into verification_verdict (id, observation_id, capture_client_id,
              workshop_id, evaluator_email, decision, note)
            values ('tl30-vv-instructor', 'tl30-obs-instructor', 'tl30-cap-ok', %L,
                    'tl30-reviewer@example.org', 'confirm',
                    'a sentence about a colleague that nobody else may read')
            returning 1$q$, _cc));
  perform tl30_try('allowed', 'and reads it back', _rev,
    $q$select 1 from verification_verdict where id = 'tl30-vv-instructor'$q$);
  perform tl30_try('blocked', 'another reviewer of the same instructor CANNOT read that verdict', _co,
    $q$select 1 from verification_verdict where id = 'tl30-vv-instructor'$q$);
  perform tl30_try('blocked', 'nor can an instructor subject who is not this one', _mathew,
    $q$select 1 from verification_verdict where id = 'tl30-vv-instructor'$q$);
  perform tl30_try('blocked', 'nor can an outsider evaluator', _out,
    $q$select 1 from verification_verdict where id = 'tl30-vv-instructor'$q$);
  perform tl30_try('allowed', 'a verdict on TRAINEE evidence stays readable by every member', _out,
    format($q$insert into verification_verdict (id, observation_id, capture_client_id,
              workshop_id, evaluator_email, decision, note)
            values ('tl30-vv-trainee', 'tl30-obs-trainee', 'tl30-cap-ok', %L,
                    'tl30-outsider@example.org', 'confirm', 'ordinary verification')
            returning 1$q$, _cc));
  perform tl30_try('allowed', 'read by a colleague, which is the whole point of the gate', _mathew,
    $q$select 1 from verification_verdict where id = 'tl30-vv-trainee'$q$);
end $$;

-- ---------------------------------------------------------------------------
-- Teardown. On the tl30- prefix only, and before the report so a failure in the
-- middle of the file still leaves the database clean.
-- ---------------------------------------------------------------------------

delete from verification_verdict where id like 'tl30-vv-%';
delete from observation where id like 'tl30-obs-%';

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
