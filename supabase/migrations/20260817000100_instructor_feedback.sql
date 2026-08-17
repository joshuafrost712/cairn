-- tl-30: instructor feedback, and the surface that must not widen to carry it.
--
-- Honest Eval evaluates trainees. Nikki Mustin, Angie Seow and the facilitators
-- themselves need to evaluate the people TEACHING, on three dimensions Joshua
-- named: adult learning, teamwork, collaborative leadership. This migration is
-- the whole mechanism, and it is deliberately small: an instructor is a
-- `participant` row wearing a category, the review is an `activity` wearing an
-- audience, and the three prompts are ordinary questions under an ordinary goal.
-- Routing, observations, verification and reports therefore work unchanged.
--
-- What is genuinely new is one table and one rule.
--
-- ## Why permission is a pair table and not a flag
--
-- The obvious design is a boolean on `workshop_member` plus "you may review every
-- instructor except yourself". It fits every case Joshua gave except one, and the
-- exception is not a corner: **Viji Mathew is reviewed only by Nikki and Angie**,
-- while himself reviewing all the other facilitators. A flag cannot say that. A
-- flag bent to say it (a second flag, an exception list, a role check smuggled
-- into a view) is how the wrong person ends up reading a colleague's assessment
-- of them, silently, with nothing in the schema that ever claimed otherwise.
--
-- So the grant is stated per pair. One row means one named person may review one
-- named instructor. Self-review is prevented by not writing that row, and again
-- by a trigger, because a stray self-pair would otherwise be perfectly valid.
--
-- ## Why the pair is keyed on email, not app_user_id
--
-- Three of the five reviewers have no account yet: Nikki and Viji hold pending
-- invitations, and Angie has not been invited at all as of 2026-08-17. An
-- app_user_id column would be un-fillable for exactly the people this spec is
-- for, and would have to be back-filled by hand at the moment each of them signs
-- up, during the workshop, by somebody who has to notice. Email is already this
-- codebase's identity currency across accounts (`evaluation.evaluator_email`,
-- `observation.evaluator_email`, `report_assignment`, `role_allowlist`,
-- `workshop_invitation`), it is what `handle_new_user` matches on, and a pair
-- written today simply starts working the moment its holder signs in.
--
-- Stored lowercase, with a check constraint rather than a trigger, because
-- `citext` is not installed on this project and a normalization that a writer can
-- skip is not a normalization.
--
-- ## Why four SELECT policies get narrower, not just the new ones
--
-- Before this migration, every table below was readable by any workshop member,
-- and that was safe only because the lowest role in use was `evaluator`. Angie
-- arrives holding `participant`, the role nobody has held until now, and her
-- entire app is meant to be one button. Leaving `is_workshop_member` on
-- `participant`, `evaluation`, `observation` and `report_assignment` would hand a
-- songs-workshop attendee the whole trainee roster and every assessment written
-- about it.
--
-- So the trainee half of each policy now asks `has_evaluating_role()` rather than
-- `is_workshop_member()`. No current member loses anything: every existing
-- membership in this database is chief_admin, chief_evaluator or evaluator, all
-- of which that helper admits. What changes is only what a future `participant`
-- may see, which is the point.

begin;

-- ---------------------------------------------------------------------------
-- 1. The four columns.
--
--    All defaulted and NOT NULL, so every existing row reads 'participant' and
--    every pre-tl-30 client keeps writing rows that mean what they used to.
-- ---------------------------------------------------------------------------

alter table participant
  add column if not exists category text not null default 'participant'
    check (category in ('participant', 'instructor'));

alter table activity
  add column if not exists audience text not null default 'participant'
    check (audience in ('participant', 'instructor'));

alter table evaluation
  add column if not exists subject_kind text not null default 'participant'
    check (subject_kind in ('participant', 'instructor'));

alter table observation
  add column if not exists subject_kind text not null default 'participant'
    check (subject_kind in ('participant', 'instructor'));

-- An instructor review names exactly one subject. `participant_scope` is a jsonb
-- array and a fine thing for a trainee capture, where an evaluator watches a room
-- and tags four people; it is the wrong shape here, and it is unusable as an RLS
-- predicate. `focus_participant_id` already exists (20260608000200) and already
-- means "this capture is about this one person", so the constraint just makes it
-- mandatory for the new kind.
alter table evaluation drop constraint if exists evaluation_instructor_needs_focus;
alter table evaluation add constraint evaluation_instructor_needs_focus
  check (subject_kind = 'participant' or focus_participant_id is not null);

-- The RLS predicates below filter on these on every read.
create index if not exists participant_workshop_category_idx on participant (workshop_id, category);
create index if not exists activity_workshop_audience_idx on activity (workshop_id, audience);
create index if not exists evaluation_subject_kind_idx on evaluation (workshop_id, subject_kind);
create index if not exists observation_subject_kind_idx on observation (workshop_id, subject_kind);

-- ---------------------------------------------------------------------------
-- 2. The pair table.
-- ---------------------------------------------------------------------------

create table if not exists instructor_reviewer (
  workshop_id               uuid not null references workshop(id) on delete cascade,
  reviewer_email            text not null check (reviewer_email = lower(reviewer_email)),
  instructor_participant_id uuid not null references participant(id) on delete cascade,
  granted_by                uuid references app_user(id) on delete set null,
  granted_at                timestamptz not null default now(),
  primary key (workshop_id, reviewer_email, instructor_participant_id)
);

-- "what may I review here" runs on every home-screen paint for a reviewer.
create index if not exists instructor_reviewer_email_idx
  on instructor_reviewer (reviewer_email, workshop_id);
create index if not exists instructor_reviewer_subject_idx
  on instructor_reviewer (instructor_participant_id);

alter table instructor_reviewer enable row level security;

-- Same posture as workshop_member: no client write path at all. Supabase's
-- default privileges grant everything on a new public table to anon and
-- authenticated, so the writes are revoked by role name rather than left to RLS.
-- An attempt to insert a pair fails at the grant, before a policy is consulted.
revoke all on public.instructor_reviewer from anon, authenticated;
grant select on public.instructor_reviewer to authenticated;

-- The row must name an instructor, in the workshop it claims, and must not grant
-- somebody power over their own assessment. The first two are integrity the
-- foreign keys cannot express (they reference `participant`, not "an instructor
-- of THIS workshop"); the third is the rule this whole spec exists to hold.
create or replace function instructor_reviewer_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _p record;
begin
  select p.id, p.workshop_id, p.category, p.person_id, lower(coalesce(p.registered_email, '')) as email
    into _p
    from participant p
   where p.id = new.instructor_participant_id;

  if _p.id is null then
    raise exception 'tl30.no_such_participant: %', new.instructor_participant_id
      using errcode = 'foreign_key_violation';
  end if;

  if _p.workshop_id <> new.workshop_id then
    raise exception 'tl30.participant_is_in_another_workshop: % is not in %',
      new.instructor_participant_id, new.workshop_id
      using errcode = 'check_violation';
  end if;

  if _p.category <> 'instructor' then
    raise exception 'tl30.not_an_instructor: % has category %', _p.id, _p.category
      using errcode = 'check_violation';
  end if;

  -- Two ways the reviewer can turn out to BE the subject: the participant row
  -- carries their address, or it links to the person their account links to.
  -- Both are checked, because tl-12 made the second the durable one while the
  -- first is what a hand-written roster row actually holds.
  if _p.email = new.reviewer_email then
    raise exception 'tl30.self_review: % may not review themselves', new.reviewer_email
      using errcode = 'check_violation';
  end if;

  if _p.person_id is not null and exists (
    select 1 from app_user u
     where lower(u.email) = new.reviewer_email
       and u.person_id = _p.person_id
  ) then
    raise exception 'tl30.self_review: % may not review themselves', new.reviewer_email
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists instructor_reviewer_guard_trg on instructor_reviewer;
create trigger instructor_reviewer_guard_trg
  before insert or update on instructor_reviewer
  for each row execute function instructor_reviewer_guard();

-- ---------------------------------------------------------------------------
-- 3. Helpers.
--
--    Security-definer and stable, matching is_workshop_member/has_workshop_role
--    (20260728000700): a policy that consults them must not re-enter RLS on the
--    table it is protecting, and the planner must be free to hoist them.
-- ---------------------------------------------------------------------------

-- The caller's address, lowercased. Resolved from `app_user`, never from the JWT
-- claim: the claim is what the client sent, and this decides what they may read.
create or replace function my_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(u.email) from app_user u where u.auth_user_id = auth.uid();
$$;

-- Everyone whose job is to look at trainees. Deliberately every role EXCEPT
-- `participant`, which is the role a reviewer-only account holds.
create or replace function has_evaluating_role(_workshop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_workshop_role(_workshop_id,
    array['chief_admin','admin','chief_evaluator','consultant','evaluator']);
$$;

-- May the caller write and read feedback about this one instructor?
create or replace function may_review_instructor(_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from instructor_reviewer r
     where r.instructor_participant_id = _participant_id
       and r.reviewer_email = my_email()
  );
$$;

-- Does the caller hold any pair in this workshop? This, and nothing else, is what
-- reveals the Instructor feedback event on the home screen. There is no separate
-- flag, so there is nothing that can drift out of step with the pairs.
create or replace function reviews_any_instructor(_workshop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from instructor_reviewer r
     where r.workshop_id = _workshop_id
       and r.reviewer_email = my_email()
  );
$$;

-- Is this instructor row the caller? The subject reads their own feedback, per
-- Joshua's decision of 2026-08-17. Matched on `person_id`, the cross-workshop
-- identity tl-12 exists to provide, and falling back to the address on the roster
-- row for an instructor whose person link has not been made yet.
create or replace function is_instructor_subject(_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from participant p
      join app_user u on u.auth_user_id = auth.uid()
     where p.id = _participant_id
       and (
         (p.person_id is not null and p.person_id = u.person_id)
         or lower(coalesce(p.registered_email, '')) = lower(u.email)
       )
  );
$$;

-- The whole read rule for one instructor row, in one place, so the four policies
-- below cannot come to disagree about it: its author, its subject, or an
-- administrator of the workshop. NOT chief_evaluator, on purpose. Nikki writes
-- feedback on Joshua and must not read what Mathew wrote about Irene.
create or replace function may_read_instructor_subject(_workshop_id uuid, _participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select may_review_instructor(_participant_id)
      or is_instructor_subject(_participant_id)
      or has_workshop_role(_workshop_id, array['chief_admin','admin']);
$$;

-- `observation.participant_id` is TEXT, not uuid: the router writes it from a
-- client-generated capture file, and the foundation schema never constrained it.
-- A bare `::uuid` in the policy would therefore be a cast on unvalidated data
-- inside a security predicate, and Postgres is free to evaluate a CASE arm it did
-- not have to — so one malformed id would not deny a row, it would error the
-- whole query and take the page down. The guard is here instead, once.
create or replace function may_read_instructor_subject(_workshop_id uuid, _participant_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _participant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then may_read_instructor_subject(_workshop_id, _participant_id::uuid)
    -- An instructor observation whose subject cannot be resolved is readable by
    -- the administrator who has to go and fix it, and by nobody else.
    else has_workshop_role(_workshop_id, array['chief_admin','admin'])
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Policies.
--
--    Every one is dropped and rewritten rather than added beside the old one:
--    Postgres ORs multiple permissive policies for the same command, so an
--    `is_workshop_member` policy left in place would defeat every narrowing here
--    while looking, in the migration diff, like it had been superseded.
-- ---------------------------------------------------------------------------

-- participant: trainees to the people who evaluate them; instructors only to the
-- people entitled to that one instructor.
drop policy if exists participant_select on participant;
create policy participant_select on participant for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and case category
          when 'instructor' then may_read_instructor_subject(workshop_id, id)
          else has_evaluating_role(workshop_id)
        end
  );

-- activity: the Instructor feedback event appears for its reviewers and for
-- administrators. Everything else stays as it was, minus the `participant` role.
drop policy if exists activity_select on activity;
create policy activity_select on activity for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and case audience
          when 'instructor' then
            reviews_any_instructor(workshop_id)
            or has_workshop_role(workshop_id, array['chief_admin','admin'])
          else has_evaluating_role(workshop_id)
        end
  );

-- evaluation: the raw dictated capture. For an instructor review this is the most
-- sensitive row in the database, because it is the unrouted text.
drop policy if exists evaluation_select on evaluation;
create policy evaluation_select on evaluation for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then
            lower(coalesce(evaluator_email, '')) = my_email()
            or is_instructor_subject(focus_participant_id)
            or has_workshop_role(workshop_id, array['chief_admin','admin'])
          else has_evaluating_role(workshop_id)
        end
  );

-- An instructor review may only be written by somebody holding the pair for its
-- subject. This is the negative half of the whole spec and the one policy most
-- worth reading twice.
drop policy if exists evaluation_insert on evaluation;
create policy evaluation_insert on evaluation for insert to authenticated
  with check (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then may_review_instructor(focus_participant_id)
          else has_evaluating_role(workshop_id)
        end
  );

-- Update is narrowed to the author for an instructor row. It stays open to any
-- evaluating member for a trainee row, which is the pre-tl-30 behaviour and out
-- of scope to change here.
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
            lower(coalesce(evaluator_email, '')) = my_email()
            or has_workshop_role(workshop_id, array['chief_admin','admin'])
          else has_evaluating_role(workshop_id)
        end
  );

-- observation: the routed, scored unit. Same audience as the capture it came
-- from, keyed on its own subject_kind so a policy never has to join back.
drop policy if exists observation_select on observation;
create policy observation_select on observation for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and case subject_kind
          when 'instructor' then
            lower(coalesce(evaluator_email, '')) = my_email()
            or may_read_instructor_subject(workshop_id, participant_id)
          else has_evaluating_role(workshop_id)
        end
  );

-- report_assignment: the trainee rota. Nothing here is ever about an instructor,
-- so this is only the `participant`-role narrowing.
drop policy if exists report_assignment_select on report_assignment;
create policy report_assignment_select on report_assignment for select to authenticated
  using (is_workshop_member(workshop_id) and has_evaluating_role(workshop_id));

-- instructor_reviewer: you can see the pairs that name you, and an administrator
-- can see the whole matrix in order to fix it. A reviewer does not get to learn
-- who else is reviewing whom.
drop policy if exists instructor_reviewer_select on instructor_reviewer;
create policy instructor_reviewer_select on instructor_reviewer for select to authenticated
  using (
    is_workshop_member(workshop_id)
    and (
      reviewer_email = my_email()
      or is_instructor_subject(instructor_participant_id)
      or has_workshop_role(workshop_id, array['chief_admin','admin'])
    )
  );

-- ---------------------------------------------------------------------------
-- 5. The one write path.
--
--    chief_admin only, matching transfer_chief_admin rather than the ordinary
--    grant matrix: who may judge the facilitators is the course lead's call, not
--    something a second admin should be able to rewrite quietly.
-- ---------------------------------------------------------------------------

create or replace function set_instructor_review_pair(
  _workshop_id    uuid,
  _reviewer_email text,
  _instructor_id  uuid,
  _allowed        boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor uuid;
  _norm  text := lower(btrim(coalesce(_reviewer_email, '')));
begin
  select id into _actor from app_user where auth_user_id = auth.uid();
  if _actor is null then
    raise exception 'tl30.no_account' using errcode = 'insufficient_privilege';
  end if;

  if not has_workshop_role(_workshop_id, array['chief_admin']) then
    raise exception 'tl30.not_the_chief_admin_of_this_workshop'
      using errcode = 'insufficient_privilege';
  end if;

  if _norm = '' or _norm not like '%_@_%' then
    raise exception 'tl30.not_an_email: %', _reviewer_email using errcode = 'check_violation';
  end if;

  if _allowed then
    insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id, granted_by)
    values (_workshop_id, _norm, _instructor_id, _actor)
    on conflict (workshop_id, reviewer_email, instructor_participant_id) do nothing;
    return jsonb_build_object('outcome', 'granted', 'email', _norm, 'instructor', _instructor_id);
  end if;

  delete from instructor_reviewer
   where workshop_id = _workshop_id
     and reviewer_email = _norm
     and instructor_participant_id = _instructor_id;
  return jsonb_build_object('outcome', 'revoked', 'email', _norm, 'instructor', _instructor_id);
end;
$$;

revoke all on function set_instructor_review_pair(uuid, text, uuid, boolean) from public, anon;
grant execute on function set_instructor_review_pair(uuid, text, uuid, boolean) to authenticated;

-- The helpers are read by policies, which run as the definer anyway. Granting
-- execute to `authenticated` lets the client mirror a decision it must not make;
-- `anon` gets nothing, by name rather than by revoking from public alone (which
-- does not touch the default grants Supabase issues per role).
revoke all on function my_email() from public, anon;
revoke all on function has_evaluating_role(uuid) from public, anon;
revoke all on function may_review_instructor(uuid) from public, anon;
revoke all on function reviews_any_instructor(uuid) from public, anon;
revoke all on function is_instructor_subject(uuid) from public, anon;
revoke all on function may_read_instructor_subject(uuid, uuid) from public, anon;
revoke all on function may_read_instructor_subject(uuid, text) from public, anon;
grant execute on function my_email() to authenticated;
grant execute on function has_evaluating_role(uuid) to authenticated;
grant execute on function may_review_instructor(uuid) to authenticated;
grant execute on function reviews_any_instructor(uuid) to authenticated;
grant execute on function is_instructor_subject(uuid) to authenticated;
grant execute on function may_read_instructor_subject(uuid, uuid) to authenticated;
grant execute on function may_read_instructor_subject(uuid, text) to authenticated;

commit;
