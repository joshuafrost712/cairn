-- tl-30 amendment, 2026-08-18: an evaluator reviews trainees and nobody else.
--
--   node scripts/apply-migration.mjs scripts/tl30-narrow-instructor-reviewers.sql
--
-- tl-30 shipped the Crash Course matrix as "everyone reviews everyone except
-- themselves", with one deliberate asymmetry for Viji. On day one of the course
-- Joshua narrowed it:
--
--   "I should not be able to provide evaluations for myself. Neither should any
--    of the other evaluators. I should be able to provide evaluations for Irene
--    and Mathew, but they should not be able to evaluate anyone but the
--    participants. Viji should be able to evaluate any of us."
--
-- Instructor feedback now flows one way. The course lead reviews his
-- co-facilitators; the senior consultant and the external reviewer review the
-- facilitators; a facilitator who is also a trainee-side evaluator reviews
-- trainees only. So four grants come out and nothing else moves.
--
--   irene@sall.com           loses Joshua C. Frost and Mathew Thomas
--   mathewtperumal@gmail.com loses Joshua C. Frost and Irene van Riezen
--
-- Eighteen pairs become fourteen.
--
-- WHY THIS IS DATA AND NOT A CONSTRAINT. The tempting shortcut is a rule saying
-- a member holding the `evaluator` role may not hold an instructor pair. It
-- would revoke Viji, who is invited to the Crash Course as an `evaluator` and is
-- the one person Joshua explicitly wants reviewing everyone. tl-30 chose a pair
-- table over a boolean for exactly this reason; do not reduce it to a role.
--
-- Nothing is orphaned: `evaluation` and `observation` held zero rows with
-- `subject_kind = 'instructor'` when this ran, and the block below refuses to
-- proceed if that is ever untrue on a re-run.
--
-- What the revocation does on its own, with no client or policy change:
--   * `activity_select` gates an instructor-audience event on
--     `reviews_any_instructor()`, so the "Instructor feedback" event leaves
--     their schedules.
--   * `participant_select` gates an instructor roster row on
--     `may_read_instructor_subject()`, so each of them still sees their own row
--     and no other instructor's. Reading their OWN feedback is intended and
--     unchanged: `may_read_instructor_evidence()` admits the subject.
--   * `src/db/reference.ts` clears the pair cache before every refresh rather
--     than merging, so their devices drop the revoked pairs when next online.
--   * `evaluation_insert` refuses an instructor capture from a non-pair-holder,
--     so a device that never refreshes still cannot write one.
--
-- Written as plain deletes rather than through `set_instructor_review_pair()`,
-- for the reason the roster script gives about its own inserts: this file runs
-- as `postgres`, the RPC exists so Joshua can fix a pair from the app, and
-- round-tripping through an RLS impersonation block would test the RPC rather
-- than establish the data.

begin;

-- ---------------------------------------------------------------------------
-- 1. Refuse to run if any instructor evidence exists.
--
--    Revoking a pair is safe while nobody has written anything. Once a review
--    exists, revoking its author's pair leaves evidence whose author can no
--    longer read it, which is a decision rather than a data fix. Fail loudly
--    instead of doing it silently.
-- ---------------------------------------------------------------------------

do $$
declare
  _evals int;
  _obs   int;
begin
  select count(*) into _evals from evaluation
   where subject_kind = 'instructor'
     and lower(evaluator_email) in ('irene@sall.com', 'mathewtperumal@gmail.com');
  -- `observation` carries its own `evaluator_email` (the client-shaped table
  -- from 20260730001200 links to a capture by `capture_client_id`, not by an
  -- evaluation id), so this asks the author question directly.
  select count(*) into _obs from observation
   where subject_kind = 'instructor'
     and lower(evaluator_email) in ('irene@sall.com', 'mathewtperumal@gmail.com');
  if _evals > 0 or _obs > 0 then
    raise exception
      'Refusing to revoke: Irene and Mathew hold % instructor evaluation(s) and % routed observation(s). Decide what happens to that evidence first.',
      _evals, _obs;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The four revocations, named rather than swept.
--
--    Matched on the pair, not on the reviewer, so a grant somebody adds later
--    for a different instructor is not quietly taken away by a re-run of this
--    file. `where reviewer_email in (...)` would have been shorter and would
--    have made this file a standing policy rather than one recorded change.
-- ---------------------------------------------------------------------------

delete from instructor_reviewer
 where (workshop_id, reviewer_email, instructor_participant_id) in (
   ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'irene@sall.com',           '30400000-0000-4000-8000-000000000011'),
   ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'irene@sall.com',           '30400000-0000-4000-8000-000000000012'),
   ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'mathewtperumal@gmail.com', '30400000-0000-4000-8000-000000000011'),
   ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'mathewtperumal@gmail.com', '30400000-0000-4000-8000-000000000013')
 );

-- ---------------------------------------------------------------------------
-- 3. Assert the shape that is left, inside the same transaction.
--
--    A delete that matched nothing and a delete that matched everything both
--    return quietly. The assertions below are what tell the two apart, and they
--    roll the whole thing back if the matrix is not the one Joshua described.
-- ---------------------------------------------------------------------------

do $$
declare
  _cc uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _n  int;
begin
  select count(*) into _n from instructor_reviewer;
  if _n <> 14 then
    raise exception 'Expected fourteen pairs after the revocation, found %.', _n;
  end if;

  select count(*) into _n from instructor_reviewer
   where reviewer_email in ('irene@sall.com', 'mathewtperumal@gmail.com');
  if _n <> 0 then
    raise exception 'Irene and Mathew still hold % instructor pair(s).', _n;
  end if;

  -- The positive that proves the delete was narrow. Without it, a `where`
  -- clause that emptied the table would pass the two checks above.
  select count(*) into _n from instructor_reviewer
   where workshop_id = _cc and reviewer_email = 'josh_frost@sil.org';
  if _n <> 2 then
    raise exception 'Joshua should still review two instructors, found %.', _n;
  end if;

  select count(*) into _n from instructor_reviewer
   where workshop_id = _cc and reviewer_email = 'viji_mathew@sil.org';
  if _n <> 3 then
    raise exception 'Viji should still review three instructors, found %.', _n;
  end if;

  select count(*) into _n from instructor_reviewer
   where workshop_id = _cc and reviewer_email = 'nikkicm23@gmail.com';
  if _n <> 4 then
    raise exception 'Nikki should still review all four instructors, found %.', _n;
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- 4. Print the matrix that is left, so the run reports rather than just exits.
-- ---------------------------------------------------------------------------

select jsonb_pretty(jsonb_build_object(
  'total_pairs', (select count(*) from instructor_reviewer),
  'matrix', (select jsonb_agg(row order by row->>'workshop', row->>'reviewer')
             from (select jsonb_build_object(
                     'workshop', case when r.workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
                                      then 'Crash Course' else 'Songs' end,
                     'reviewer', r.reviewer_email,
                     'may_review', p.name) as row
                   from instructor_reviewer r
                   join participant p on p.id = r.instructor_participant_id) s),
  'irene_and_mathew_pairs', (select count(*) from instructor_reviewer
                             where reviewer_email in ('irene@sall.com', 'mathewtperumal@gmail.com')),
  'instructor_evidence', (select count(*) from evaluation where subject_kind = 'instructor')
));
