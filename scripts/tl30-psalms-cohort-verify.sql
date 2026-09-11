-- tl-30, 2026-09-11: proves the Psalms cohort can actually SUBMIT instructor
-- feedback on Joshua, not merely see the event.
--
--   node scripts/apply-migration.mjs scripts/tl30-psalms-cohort-verify.sql
--
-- Read-only in effect: every write happens inside a transaction that ROLLS BACK,
-- so no fabricated evaluation survives. Safe to re-run against the live project.
--
-- Why this file exists beside tl30-verify.sql. That harness proves the READ
-- rules. Nine pairs were granted on 2026-09-11 and the first check asked only
-- whether a new reviewer could SEE the instructor-feedback event and Joshua's
-- roster row. Seeing the event is a different question from being allowed to
-- write through it: `activity_select` reveals the event on
-- `reviews_any_instructor()`, while `evaluation_insert` demands
-- `may_review_instructor(focus_participant_id)`. A grant could satisfy one and
-- not the other, and the failure would appear only after somebody had dictated a
-- whole review. So this runs the real capture-screen insert as the evaluator.
--
-- Two newly-granted evaluators are exercised, not one: a single fixture cannot
-- tell "the grant works" from "that one row happened to be written correctly".
--
-- Every check lands in ONE final result set, because the Supabase management API
-- returns only the last one and an earlier PASS would otherwise be invisible.
-- Each negative is paired with the positive that proves the query shape works,
-- since RLS denies by returning zero rows and a typo looks identical.
begin;
select set_config('request.jwt.claims',
  '{"sub":"26a866ca-c14e-43c0-9d1c-cf3b5288939c","role":"authenticated"}', true);
set local role authenticated;

create temp table result (seq int, check_name text, outcome text) on commit drop;

-- A. The real insert the capture screen would make: Matt Menger reviews Joshua.
do $$
begin
  insert into evaluation (
    client_id, evaluator_email, activity_id, workshop_id, subject_kind,
    source_language, answers, quick_ratings, focus_participant_id,
    source_text, participant_scope, attestation, created_at, updated_at
  ) values (
    'writetest-pos', 'matt_menger@sil.org',
    '30300000-0000-4000-8000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'instructor', 'English', '{}'::jsonb, '{}'::jsonb,
    '30400000-0000-4000-8000-000000000021',
    'WRITE TEST positive - rolled back', '[]'::jsonb, true, now(), now()
  );
  insert into result values (1, 'A. Menger submits a review of Joshua', 'PASS - accepted');
exception when others then
  insert into result values (1, 'A. Menger submits a review of Joshua',
    'FAIL - refused: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- B. He can read back his own row (author arm of evaluation_select).
insert into result
select 2, 'B. Author reads back his own review',
       case when count(*) = 1 then 'PASS - 1 row' else 'FAIL - ' || count(*) || ' rows' end
  from evaluation where client_id = 'writetest-pos';

-- C. The negative: the same insert naming Viji, whom he holds no pair on.
do $$
begin
  insert into evaluation (
    client_id, evaluator_email, activity_id, workshop_id, subject_kind,
    source_language, answers, quick_ratings, focus_participant_id,
    source_text, participant_scope, attestation, created_at, updated_at
  ) values (
    'writetest-neg', 'matt_menger@sil.org',
    '30300000-0000-4000-8000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'instructor', 'English', '{}'::jsonb, '{}'::jsonb,
    '30400000-0000-4000-8000-000000000022',
    'WRITE TEST negative - must never persist', '[]'::jsonb, true, now(), now()
  );
  insert into result values (3, 'C. Menger reviews Viji (must refuse)',
    'FAIL - the insert was ACCEPTED');
exception when others then
  insert into result values (3, 'C. Menger reviews Viji (must refuse)',
    'PASS - refused ' || sqlstate);
end $$;

insert into result
select 4, 'D. No Viji row persisted',
       case when count(*) = 0 then 'PASS - 0 rows' else 'FAIL - ' || count(*) || ' rows' end
  from evaluation where client_id = 'writetest-neg';

-- E. A co-reviewer must NOT read Menger's words. Switch to June Rumthe, who was
--    granted a pair on Joshua in this same change.
select set_config('request.jwt.claims',
  '{"sub":"505b6612-225f-4d24-a518-b18c40ffe7db","role":"authenticated"}', true);
insert into result
select 5, 'E. Co-reviewer June cannot read Menger''s review',
       case when count(*) = 0 then 'PASS - 0 rows' else 'FAIL - ' || count(*) || ' rows' end
  from evaluation where client_id = 'writetest-pos';

-- F. June can nevertheless write her own review of Joshua: the grant works for
--    a second newly-granted evaluator, not just the one already checked.
do $$
begin
  insert into evaluation (
    client_id, evaluator_email, activity_id, workshop_id, subject_kind,
    source_language, answers, quick_ratings, focus_participant_id,
    source_text, participant_scope, attestation, created_at, updated_at
  ) values (
    'writetest-june', 'june_rumthe@sil.org',
    '30300000-0000-4000-8000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'instructor', 'English', '{}'::jsonb, '{}'::jsonb,
    '30400000-0000-4000-8000-000000000021',
    'WRITE TEST june - rolled back', '[]'::jsonb, true, now(), now()
  );
  insert into result values (6, 'F. June submits her own review of Joshua', 'PASS - accepted');
exception when others then
  insert into result values (6, 'F. June submits her own review of Joshua',
    'FAIL - refused: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- G. Joshua, the subject, reads what was written about him.
select set_config('request.jwt.claims',
  '{"sub":"3aea7d0d-133b-43ee-b5d0-a7a80374a87f","role":"authenticated"}', true);
insert into result
select 7, 'G. Joshua (subject) reads both reviews of himself',
       case when count(*) = 2 then 'PASS - 2 rows' else 'FAIL - ' || count(*) || ' rows' end
  from evaluation where client_id in ('writetest-pos', 'writetest-june');

-- H. A trainee-side member with no pair must not read them. Peter Seow was also
--    granted a pair, so use an account that holds none: Katie is granted too...
--    use the songs-workshop outsider instead: Mathew Thomas (Crash Course only).
select set_config('request.jwt.claims',
  '{"sub":"71449b5f-4690-4663-8842-bc9c919ae258","role":"authenticated"}', true);
insert into result
select 8, 'H. Outsider (Mathew, other workshop) reads nothing',
       case when count(*) = 0 then 'PASS - 0 rows' else 'FAIL - ' || count(*) || ' rows' end
  from evaluation where client_id in ('writetest-pos', 'writetest-june');

set local role postgres;
select seq, check_name, outcome from result order by seq;
rollback;
