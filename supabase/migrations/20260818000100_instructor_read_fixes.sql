-- tl-30 review fixes: the routed half of instructor feedback was wider than the
-- raw half, and three tables beside it were never narrowed at all.
--
-- 20260817000100 narrowed `evaluation` correctly: an instructor capture is
-- readable by its author, its subject, or an administrator. It then routed
-- `observation` through `may_read_instructor_subject()`, whose FIRST arm is
-- `may_review_instructor()` — holding a pair for that instructor. Holding a pair
-- is not the same as being the author, so every co-reviewer of one instructor
-- could read every other co-reviewer's routed words about them. In the live Bali
-- matrix each instructor carries three or four reviewers, so this was the normal
-- case rather than an edge one, and it defeats the sentence the whole spec is
-- graded against: "a named reviewer can evaluate a named instructor and read
-- nobody else's words about them."
--
-- The verify script's 72 assertions did not catch it because every negative it
-- states is about a DIFFERENT instructor (Nikki must not read what Mathew wrote
-- about Irene). The shape it never tried is two reviewers of the SAME instructor.
--
-- Four fixes, and each names the hole it closes.
--
--   1. `observation_select` stops admitting co-reviewers.
--   2. `evaluation_update` stops being an insert-then-relabel path around the
--      pair gate that `evaluation_insert` enforces.
--   3. `observation_insert` and `observation_update` stop letting a
--      chief_evaluator flip `subject_kind` and publish an instructor's evidence
--      to every evaluating member.
--   4. `verification_verdict_select` stops handing every member the free-text
--      `note` on a verdict about an instructor.
--
-- Written 2026-08-18, before the branch merged, so no instructor evidence exists
-- under the wider rules: the client that can write it has never been deployed.

-- ---------------------------------------------------------------------------
-- 1. The read rule for instructor EVIDENCE, which is narrower than the read rule
--    for an instructor's roster ROW.
--
--    `may_read_instructor_subject()` is kept exactly as it is, because
--    `participant_select` is right to use it: a reviewer must see the roster row
--    of the person they are reviewing. What a reviewer must NOT see is what
--    another reviewer said. That is a different question and it now has a
--    different function, so no policy can answer one by reaching for the other.
-- ---------------------------------------------------------------------------

create or replace function may_read_instructor_evidence(_workshop_id uuid, _participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_instructor_subject(_participant_id)
      or has_workshop_role(_workshop_id, array['chief_admin','admin']);
$$;

comment on function may_read_instructor_evidence(uuid, uuid) is
  'Who may read EVIDENCE about this instructor, excluding its author (each policy tests authorship on its own row): the subject, or an administrator. Deliberately NOT a co-reviewer.';

-- The text overload exists for the same reason it does on
-- `may_read_instructor_subject`: `observation.participant_id` is TEXT and a bare
-- cast inside a security predicate would error a whole page on one malformed id
-- rather than deny one row.
create or replace function may_read_instructor_evidence(_workshop_id uuid, _participant_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _participant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then may_read_instructor_evidence(_workshop_id, _participant_id::uuid)
    else has_workshop_role(_workshop_id, array['chief_admin','admin'])
  end;
$$;

comment on function may_read_instructor_evidence(uuid, text) is
  'Text overload for observation.participant_id, which is TEXT. An unresolvable id is readable by an administrator only.';

-- ---------------------------------------------------------------------------
-- 2. observation_select: the routed text now has the same audience as the raw
--    capture it came from, which is what 20260817000100 said it was doing.
-- ---------------------------------------------------------------------------

drop policy if exists observation_select on observation;
create policy observation_select on observation for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then
            lower(coalesce(evaluator_email, '')) = my_email()
            or may_read_instructor_evidence(workshop_id, participant_id)
          else has_evaluating_role(workshop_id)
        end
  );

-- ---------------------------------------------------------------------------
-- 3. evaluation_update: the pair gate was on INSERT only.
--
--    A member with any evaluating role could insert a row as a trainee capture
--    (which `evaluation_insert` permits) and then PATCH `subject_kind` to
--    'instructor'. USING sees the OLD row and passes on the trainee arm; the old
--    WITH CHECK saw the NEW row and asked only for authorship, which the attacker
--    holds because they wrote it. So the row the insert policy would have refused
--    could be created in two statements. WITH CHECK now asks for the pair as well,
--    which is the same question `evaluation_insert` asks.
-- ---------------------------------------------------------------------------

drop policy if exists evaluation_update on evaluation;
create policy evaluation_update on evaluation for update to authenticated
  using (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then
            lower(coalesce(evaluator_email, '')) = my_email()
            or has_workshop_role(workshop_id, array['chief_admin','admin'])
          else has_evaluating_role(workshop_id)
        end
  )
  with check (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then
            (
              lower(coalesce(evaluator_email, '')) = my_email()
              and may_review_instructor(focus_participant_id)
            )
            or has_workshop_role(workshop_id, array['chief_admin','admin'])
          else has_evaluating_role(workshop_id)
        end
  );

-- ---------------------------------------------------------------------------
-- 4. observation writes: `subject_kind` is a permission fact, so the role that
--    may set it is not the role that may write ordinary evidence.
--
--    20260730001200 gave insert and update to chief_admin, admin and
--    chief_evaluator, and 20260817000100 narrowed neither. A chief_evaluator could
--    therefore PATCH an instructor observation's `subject_kind` to 'participant'
--    and publish it to every evaluating member in one statement. USING tests the
--    OLD row, so an instructor observation is now untouchable by that role in
--    either direction; an administrator can still fix one, and reads them all
--    anyway.
--
--    Routing is admin-only since tl-03, so no real import path loses a capability
--    here.
-- ---------------------------------------------------------------------------

drop policy if exists observation_insert on observation;
create policy observation_insert on observation for insert to authenticated
  with check (
    case subject_kind
      when 'instructor' then has_workshop_role(workshop_id, array['chief_admin','admin'])
      else has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator'])
    end
  );

drop policy if exists observation_update on observation;
create policy observation_update on observation for update to authenticated
  using (
    case subject_kind
      when 'instructor' then has_workshop_role(workshop_id, array['chief_admin','admin'])
      else has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator'])
    end
  )
  with check (
    case subject_kind
      when 'instructor' then has_workshop_role(workshop_id, array['chief_admin','admin'])
      else has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator'])
    end
  );

-- ---------------------------------------------------------------------------
-- 5. verification_verdict: narrowed for instructor evidence only.
--
--    The table carries a free-text `note`, and its SELECT policy has been
--    `is_workshop_member(workshop_id)` since 20260730001200 for a good reason:
--    seeing that a colleague confirmed is the entire point of a multi-evaluator
--    gate. 20260817000100 narrowed the evaluation and the observation and left
--    the verdict sitting beside them, so "I disagree, his handover was worse than
--    a 2" was readable by every member of the workshop, trainees included.
--
--    A verdict whose observation this database does not hold stays readable, which
--    is the pre-existing behaviour for a verdict that arrives before its
--    observation and is not something an unprivileged caller can arrange.
-- ---------------------------------------------------------------------------

create or replace function may_read_instructor_verdict(_observation_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
      select 1 from observation o
       where o.id = _observation_id
         and o.subject_kind = 'instructor'
    )
    or exists (
      select 1 from observation o
       where o.id = _observation_id
         and o.subject_kind = 'instructor'
         and (
           lower(coalesce(o.evaluator_email, '')) = my_email()
           or may_read_instructor_evidence(o.workshop_id, o.participant_id)
         )
    );
$$;

comment on function may_read_instructor_verdict(text) is
  'True for any verdict on trainee evidence, and for a verdict on instructor evidence only where the caller may read that evidence.';

drop policy if exists verification_verdict_select on verification_verdict;
create policy verification_verdict_select on verification_verdict for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and (
      lower(coalesce(evaluator_email, '')) = my_email()
      or may_read_instructor_verdict(observation_id)
    )
  );

-- Write-side, for the same reason: a verdict is a sentence about somebody, and a
-- caller who may not read the evidence has no business recording one against it.
drop policy if exists verification_verdict_insert on verification_verdict;
create policy verification_verdict_insert on verification_verdict for insert to authenticated
  with check (
    is_workshop_member(workshop_id)
    and lower(evaluator_email) = current_app_user_email()
    and coalesce(workshop_of_observation(observation_id) = workshop_id, true)
    and may_read_instructor_verdict(observation_id)
  );

-- ---------------------------------------------------------------------------
-- 6. One consequence, recorded here rather than discovered later.
--
--    Instructor evidence is now readable by its author, its subject and an
--    administrator, so the two-confirmation verification gate cannot be reached
--    on an instructor observation by two co-reviewers: the second confirmer
--    cannot see the row. That is the price of the confidentiality decision rather
--    than a defect in it, and administrators can still verify. If a workshop ever
--    wants peer-confirmed instructor feedback, it needs a deliberate design, not a
--    widened policy.
-- ---------------------------------------------------------------------------
