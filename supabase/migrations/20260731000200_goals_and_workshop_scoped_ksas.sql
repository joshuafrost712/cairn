-- Honest Eval — tl-08: a goals layer above the questions, and questions that
-- belong to a workshop instead of to the deployment.
--
-- Two problems, one migration, because neither can be fixed alone.
--
-- FIRST, `ksa` had no workshop_id and `code` was globally unique, so every
-- workshop in a deployment shared one question pool. Two organizations both
-- wanting a `Q1` was not a warning, it was a collision; and editing a question
-- in one workshop silently edited it in the other. That is why tl-01 could not
-- honestly scope this table and left it on `has_any_membership()`.
--
-- SECOND, the level ABOVE a question was a free-text string against a hardcoded
-- constant of the six Psalms-workshop competency areas. Joshua's feedback asks
-- for "the highest-level KSAs (or whatever other goals they have)", and the
-- parenthesis is the requirement: a different organization must be able to
-- populate that level with what it is actually training toward. Meanwhile the
-- reports GROUP on that unvalidated string, so it was load-bearing for display
-- while being unconstrained in storage.
--
-- Apply after 20260731000100_setup_change_log.sql.
--
-- Three decisions worth reading before changing anything here:
--
--   * `area` IS RETAINED, NULLABLE, AND UNREAD. It is dropped in a follow-up
--     once nothing reads it, not here, so a client build from before this
--     migration keeps working against the new schema for one cycle. It is NOT a
--     second writable path: app code neither reads nor writes it after tl-08,
--     and two writable copies of the same fact is how they come to disagree.
--   * A QUESTION WIRED ACROSS TWO WORKSHOPS IS CLONED, NOT REASSIGNED. Scoping
--     such a row to one workshop would silently unhook the other workshop's
--     events. On the live deployment there is one workshop and this branch is a
--     no-op; it exists so the migration is correct rather than merely adequate
--     for today's data.
--   * THE AI-FACING RUBRIC GETS NO PER-EVENT OVERRIDE. One question means one
--     thing to the router. Per-event wording is about how a HUMAN is prompted to
--     look, not about what the evidence is; giving the rubric an override would
--     let the same code mean two things in one report.

-- ---------------------------------------------------------------------------
-- 1. The goal entity: the level above a question, per workshop.
--
--    "Goal" rather than "KSA area" because the name has to survive an
--    organization that does not use KSAs. `workshop.goal_label` is what each
--    workshop calls this level in its own UI, so a group using KSAs sees KSAs
--    and nobody is asked to rename a schema to rename a heading.
-- ---------------------------------------------------------------------------

create table if not exists goal (
  id          uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references workshop(id) on delete cascade,
  -- Short handle, unique inside the workshop. Not globally unique: the whole
  -- point of this migration is that two workshops may both have a G1.
  code        text not null,
  title       text not null,
  description text,
  sort_order  int not null default 0
);

create unique index if not exists goal_workshop_code_idx on goal (workshop_id, code);
create index if not exists goal_workshop_sort_idx on goal (workshop_id, sort_order);

alter table workshop add column if not exists goal_label text;

comment on column workshop.goal_label is
  'What this workshop calls the level above a question ("Goal", "KSA area", "Competency"). Null means the app default.';

-- ---------------------------------------------------------------------------
-- 2. Questions become workshop-scoped, and gain a goal.
-- ---------------------------------------------------------------------------

alter table ksa add column if not exists workshop_id uuid references workshop(id) on delete cascade;
alter table ksa add column if not exists goal_id uuid references goal(id) on delete set null;

-- `area` was `not null`. It has to stop being required before it can stop being
-- written, and it stops being written in this release.
alter table ksa alter column area drop not null;

comment on column ksa.area is
  'LEGACY (tl-08). Replaced by goal_id. Retained nullable for one release cycle so a pre-tl-08 client keeps working; app code neither reads nor writes it. Dropped in a follow-up.';

-- ---------------------------------------------------------------------------
-- 3. `code` stops being globally unique.
--
--    This is the constraint the whole spec is for: two organizations may both
--    have a Q1, and neither edit touches the other.
--
--    It has to happen BEFORE the backfill, not after. Step 4c clones a question
--    that is wired across two workshops, and a clone carries the same `code` —
--    which the old global unique would refuse.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  -- Drop whatever the global unique on `code` is called. Named `ksa_code_key` by
  -- the foundation schema, but matched structurally so a differently-named
  -- constraint on an older project is also removed.
  for r in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where c.relname = 'ksa'
      and con.contype = 'u'
      and con.conkey = array[(
        select attnum from pg_attribute
        where attrelid = c.oid and attname = 'code'
      )]::smallint[]
  loop
    execute format('alter table ksa drop constraint %I;', r.conname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Backfill, in one block so a half-assigned state is never committed.
--
--    A question's workshop is the workshop its wiring already points at. That is
--    a fact in the data rather than a guess: `activity_ksa` -> `activity` ->
--    `workshop_id`. Where a question is wired nowhere, it falls to the earliest
--    workshop, which on the live deployment is Psalms (Bali 2026) — the spec's
--    instruction, expressed as a rule instead of a hardcoded id so it is also
--    right on a deployment that is not Joshua's.
-- ---------------------------------------------------------------------------

do $$
declare
  _fallback uuid;
  _orphans int;
  r record;
  _clone uuid;
begin
  -- Nothing to do on a fresh deployment with no workshops at all.
  select id into _fallback from workshop order by start_date nulls last, name limit 1;

  if exists (select 1 from ksa where workshop_id is null) then
    -- 4a. The primary workshop: the one holding the most of this question's
    --     wiring. Ties break on the earliest event, so the choice is stable
    --     across re-runs rather than depending on row order.
    update ksa k
    set workshop_id = w.workshop_id
    from (
      select ak.ksa_id,
             a.workshop_id,
             row_number() over (
               partition by ak.ksa_id
               order by count(*) desc, min(a.sort_order), a.workshop_id
             ) as rank
      from activity_ksa ak
      join activity a on a.id = ak.activity_id
      group by ak.ksa_id, a.workshop_id
    ) w
    where w.ksa_id = k.id and w.rank = 1 and k.workshop_id is null;

    -- 4b. Unwired questions fall to the earliest workshop.
    if _fallback is not null then
      update ksa set workshop_id = _fallback where workshop_id is null;
    end if;
  end if;

  -- 4c. A question wired into a SECOND workshop gets its own copy there, and
  --     that workshop's wiring is repointed at the copy. Without this, scoping
  --     the original to workshop A would leave workshop B's events pointing at a
  --     question workshop B's members cannot even read.
  for r in
    select distinct ak.ksa_id, a.workshop_id
    from activity_ksa ak
    join activity a on a.id = ak.activity_id
    join ksa k on k.id = ak.ksa_id
    where k.workshop_id is not null and a.workshop_id <> k.workshop_id
  loop
    insert into ksa (
      workshop_id, code, area, short_label, description, evaluator_facing_prompt,
      ai_facing_rubric, evidence_levels, cbc_subpoint_refs, guiding_questions
    )
    select r.workshop_id, k.code, k.area, k.short_label, k.description,
           k.evaluator_facing_prompt, k.ai_facing_rubric, k.evidence_levels,
           k.cbc_subpoint_refs, k.guiding_questions
    from ksa k where k.id = r.ksa_id
    returning id into _clone;

    update activity_ksa ak
    set ksa_id = _clone
    where ak.ksa_id = r.ksa_id
      and ak.activity_id in (select id from activity where workshop_id = r.workshop_id);

    raise notice 'tl-08: cloned question % into workshop % (was shared across workshops)',
      r.ksa_id, r.workshop_id;
  end loop;

  -- 4d. One goal per distinct area string, per workshop, ordered by the six
  --     Psalms areas where the string matches and alphabetically after that. The
  --     six strings are inlined deliberately: this is a one-time reproduction of
  --     what KSA_AREAS held on 2026-07-31, not a dependency on a constant that
  --     is about to be demoted to seed data.
  insert into goal (workshop_id, code, title, sort_order)
  select workshop_id,
         'G' || row_number() over (partition by workshop_id order by ord, title),
         title,
         row_number() over (partition by workshop_id order by ord, title) - 1
  from (
    select distinct k.workshop_id,
           k.area as title,
           coalesce(
             array_position(
               array[
                 'The CLAT Process and Translation of Aesthetic Language',
                 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
                 'Genre Theory, Discovery, and Matching',
                 'Psalms Exegesis and Internalization',
                 'Checking Artistic Translations',
                 'Advocacy and Community Integration'
               ],
               k.area
             ),
             999
           ) as ord
    from ksa k
    where k.workshop_id is not null
      and k.area is not null
      and btrim(k.area) <> ''
  ) src
  on conflict (workshop_id, code) do nothing;

  -- 4e. Point each question at its workshop's goal of the same title.
  update ksa k
  set goal_id = g.id
  from goal g
  where g.workshop_id = k.workshop_id and g.title = k.area and k.goal_id is null;

  -- 4f. workshop_id is required by every reader in the app. Enforce it if the
  --     backfill placed everything; warn rather than fail if it did not, because
  --     the only way to reach here with nulls is a deployment holding questions
  --     and no workshops, where a null row already satisfies no RLS policy and
  --     is therefore unreachable rather than dangerous.
  select count(*) into _orphans from ksa where workshop_id is null;
  if _orphans = 0 then
    alter table ksa alter column workshop_id set not null;
  else
    raise warning 'tl-08: % question(s) could not be placed in a workshop; workshop_id left nullable. They are unreachable through RLS until assigned.', _orphans;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The replacement constraint: unique inside a workshop.
-- ---------------------------------------------------------------------------

create unique index if not exists ksa_workshop_code_idx on ksa (workshop_id, code);
create index if not exists ksa_goal_idx on ksa (goal_id);

-- ---------------------------------------------------------------------------
-- 6. Per-event prompt overrides.
--
--    Null means "use the question's own value". Resolution happens in exactly
--    one place in the client (`ksasForActivity`), because a second resolution
--    site is how the capture screen and the routing capture file come to show an
--    evaluator two different questions.
-- ---------------------------------------------------------------------------

alter table activity_ksa add column if not exists prompt_override text;
alter table activity_ksa add column if not exists guiding_questions_override jsonb;

comment on column activity_ksa.prompt_override is
  'Per-event replacement for ksa.evaluator_facing_prompt. Null = use the question''s own. There is deliberately no override for ai_facing_rubric: one question must mean one thing to the router.';
comment on column activity_ksa.guiding_questions_override is
  'Per-event replacement for ksa.guiding_questions, as a json array of strings. Null = use the question''s own; an empty array means "show none here".';

-- ---------------------------------------------------------------------------
-- 7. RLS.
--
--    `goal` follows the reference-table pattern tl-01 established: read by any
--    member of the workshop, written by its authors. `ksa` finally gets the
--    workshop-scoped policies tl-01 said it was waiting for — until now a member
--    of ANY workshop could read and write every question in the deployment,
--    which is the hole that made per-workshop roles incomplete.
-- ---------------------------------------------------------------------------

alter table goal enable row level security;

drop policy if exists goal_select on goal;
create policy goal_select on goal for select to authenticated
  using (is_workshop_member(workshop_id));

drop policy if exists goal_insert on goal;
create policy goal_insert on goal for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists goal_update on goal;
create policy goal_update on goal for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists goal_delete on goal;
create policy goal_delete on goal for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

grant select, insert, update, delete on goal to authenticated;

-- ksa: from "any member of any workshop" to "this workshop".
drop policy if exists ksa_select on ksa;
create policy ksa_select on ksa for select to authenticated
  using (is_workshop_member(workshop_id));

drop policy if exists ksa_insert on ksa;
create policy ksa_insert on ksa for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists ksa_update on ksa;
create policy ksa_update on ksa for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists ksa_delete on ksa;
create policy ksa_delete on ksa for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));
