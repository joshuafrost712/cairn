-- Honest Eval — tl-09: the grading scale becomes the workshop's, two to six points.
--
-- Apply after 20260801000100_conversation_assignment.sql (tl-05).
--
-- 0-3 was never a neutral container. Three places in the schema encoded it as a
-- fact about the world rather than a fact about one workshop: two check
-- constraints pinning a designation to 0..3, and `mentoring_conversation`'s
-- `trigger_designation in (0, 1)` — which is not a range check at all but the
-- MEANING of the number, frozen into the schema. An organization running a
-- 5-point scale where 3 is adequate would have had follow-up conversations
-- refused by the database for the participants who needed them, and created for
-- the ones who did not.
--
-- Three decisions worth reading before changing anything here.
--
--   * A SCALE IS WRITTEN AS A WHOLE, THROUGH AN RPC, AND NEVER ROW BY ROW.
--     `scale_point` has no client write policy at all — the same shape tl-01
--     used for `workshop_member` and tl-02 built its three RPCs on. The reason
--     is the invariant: "between two and six points, at least one of which is
--     not a trigger" is a statement about a SET of rows, and the app's offline
--     outbox pushes one row per HTTP request, i.e. one row per transaction. A
--     per-row policy could not see the set; a deferred constraint trigger would
--     see each intermediate state and refuse a legal edit halfway through. So
--     `set_workshop_scale()` takes the whole scale as one jsonb argument and
--     replaces it in one transaction, and the invariant is checked exactly once
--     against exactly the state that will be committed.
--
--   * VALUES ARE THE ORGANIZATION'S OWN NUMBERS. 1-5 stays 1-5. There is no
--     normalization to a 0-based index, because a normalization layer shows
--     somebody "0-4" in an export or an email eventually, and the person reading
--     it is a participant reading their own report.
--
--   * REMOVING A POINT UNDER RECORDED EVIDENCE IS REFUSED, NOT REMAPPED. The RPC
--     will not drop a value that observations still sit on unless the caller
--     supplies an explicit mapping for it. Silently remapping a 3 to a 2 leaves
--     a number in the database that nobody chose and no report can explain.

-- ---------------------------------------------------------------------------
-- 1. The scale itself.
-- ---------------------------------------------------------------------------

create table if not exists scale_point (
  workshop_id    uuid not null references workshop(id) on delete cascade,
  -- The organization's own number. `smallint` rather than a positive type
  -- because a scale may legitimately start below zero once an administrator adds
  -- a point beneath the bottom one.
  value          smallint not null,
  label          text not null,
  description    text,
  -- Whether landing here warrants a mentoring conversation. This column is what
  -- replaces `trigger_designation in (0, 1)`: the trigger becomes a property of
  -- the point rather than a comparison against a literal.
  is_low_trigger boolean not null default false,
  sort_order     smallint not null default 0,
  primary key (workshop_id, value)
);

comment on table scale_point is
  'One point on a workshop''s grading scale (tl-09). Two to six per workshop, at least one of them not a low trigger. Written only through set_workshop_scale(); there is deliberately no insert/update/delete policy, because the count and the trigger rule are properties of the SET and cannot be enforced one row at a time.';

comment on column scale_point.is_low_trigger is
  'Whether a designation at this point warrants a mentoring conversation. Replaces the hardcoded "0 or 1" test in deriveNeededConversations().';

create index if not exists scale_point_workshop_sort_idx on scale_point (workshop_id, sort_order);

-- ---------------------------------------------------------------------------
-- 2. Un-pin the designation columns.
--
--    Dropped rather than widened to a bigger range: the legal set is now the
--    workshop's scale, which is a per-row join and not something a table-level
--    check can express. Validation moved to isValidDesignation() at every
--    ingest boundary in the client, and to set_workshop_scale() for the scale
--    itself. Stated plainly because it IS a loosening: a client that writes a
--    designation the workshop's scale does not define will no longer be refused
--    by Postgres.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select con.conname, c.relname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and con.contype = 'c'
      and (
        (c.relname = 'observation' and con.conname like '%evidence_designation%') or
        (c.relname = 'verification_verdict' and con.conname like '%adjusted_designation%') or
        (c.relname = 'mentoring_conversation' and con.conname like '%trigger_designation%')
      )
  loop
    execute format('alter table %I drop constraint %I;', r.relname, r.conname);
    raise notice 'tl-09: dropped scale-pinning constraint % on %', r.conname, r.relname;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. A remapped observation says so.
--
--    Null for every observation ever recorded on a point that still exists,
--    which is almost all of them. When it is set, the report prints the mark
--    rather than presenting a value the participant was never scored at as
--    though it were the original judgement.
-- ---------------------------------------------------------------------------

alter table observation add column if not exists remapped_from smallint;

comment on column observation.remapped_from is
  'The designation this observation originally carried, when a scale change removed that point and an administrator mapped it to a surviving one (tl-09). Null means the score is as recorded. Reports must show the mark; a remapped score is not an original judgement.';

-- ---------------------------------------------------------------------------
-- 4. The invariant, as one function, so SQL and TypeScript cannot disagree
--    about what a legal scale is.
--
--    Mirrors validateScalePoints() in src/lib/scale.ts exactly. That copy only
--    decides whether the Save button is enabled; this one enforces.
-- ---------------------------------------------------------------------------

create or replace function scale_points_are_legal(p_points jsonb)
returns text
language plpgsql
immutable
as $$
declare
  _n int;
  _distinct int;
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    return 'tl09.scale_is_not_an_array';
  end if;
  _n := jsonb_array_length(p_points);
  if _n < 2 then return 'tl09.scale_needs_two_points'; end if;
  if _n > 6 then return 'tl09.scale_allows_six_points'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_points) e
    where jsonb_typeof(e->'value') <> 'number'
       or (e->>'value')::numeric <> trunc((e->>'value')::numeric)
  ) then
    return 'tl09.scale_values_must_be_integers';
  end if;

  select count(distinct (e->>'value')::int) into _distinct
  from jsonb_array_elements(p_points) e;
  if _distinct <> _n then return 'tl09.scale_values_must_be_distinct'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_points) e
    where coalesce(btrim(e->>'label'), '') = ''
  ) then
    return 'tl09.scale_points_need_labels';
  end if;

  -- A scale on which every point warrants a conversation has stopped saying
  -- anything: every participant is flagged for every observation. Zero triggers
  -- is legal and means a workshop that does not use the follow-up feature.
  if not exists (
    select 1 from jsonb_array_elements(p_points) e
    where coalesce((e->>'is_low_trigger')::boolean, false) = false
  ) then
    return 'tl09.scale_needs_a_non_trigger_point';
  end if;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The one write path.
--
--    `p_remap` maps a value being REMOVED to a value that survives, e.g.
--    '{"3": 2}'. Supplying it is what turns a refusal into a recorded remap; the
--    RPC never invents one.
--
--    Returns the number of observations it remapped, so the caller can state a
--    real number rather than "some evidence may have been affected".
-- ---------------------------------------------------------------------------

create or replace function set_workshop_scale(
  p_workshop_id uuid,
  p_points jsonb,
  p_remap jsonb default '{}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _problem text;
  _removed smallint[];
  _v smallint;
  _target smallint;
  _stranded int;
  _remapped int := 0;
begin
  if not has_workshop_role(p_workshop_id, array['chief_admin','admin']) then
    raise exception 'you do not administer this workshop'
      using errcode = '42501', detail = 'tl09.not_an_admin_of_this_workshop';
  end if;

  _problem := scale_points_are_legal(p_points);
  if _problem is not null then
    raise exception 'that is not a usable scale'
      using errcode = '23514', detail = _problem;
  end if;

  -- Which of the workshop's current points this call drops.
  select coalesce(array_agg(sp.value), array[]::smallint[]) into _removed
  from scale_point sp
  where sp.workshop_id = p_workshop_id
    and not exists (
      select 1 from jsonb_array_elements(p_points) e
      where (e->>'value')::int = sp.value
    );

  -- Every removed point that still holds evidence needs an explicit target. A
  -- point nobody was ever scored at needs nothing.
  foreach _v in array _removed loop
    select count(*) into _stranded
    from observation o
    where o.workshop_id = p_workshop_id and o.evidence_designation = _v;

    if _stranded > 0 then
      if p_remap ? _v::text then
        _target := (p_remap->>_v::text)::smallint;
        if not exists (
          select 1 from jsonb_array_elements(p_points) e where (e->>'value')::int = _target
        ) then
          raise exception 'a remap must point at a value the new scale still has'
            using errcode = '23514', detail = 'tl09.remap_target_is_not_on_the_new_scale';
        end if;
        -- `remapped_from` is set only the first time, so a value moved twice
        -- still records what it was ORIGINALLY scored at rather than what the
        -- last remap happened to leave behind.
        update observation o
        set evidence_designation = _target,
            remapped_from = coalesce(o.remapped_from, _v)
        where o.workshop_id = p_workshop_id and o.evidence_designation = _v;
        get diagnostics _stranded = row_count;
        _remapped := _remapped + _stranded;
      else
        raise exception 'removing that point would strand recorded evidence'
          using errcode = '23514', detail = 'tl09.removed_point_still_holds_evidence';
      end if;
    end if;
  end loop;

  delete from scale_point sp
  where sp.workshop_id = p_workshop_id and sp.value = any(_removed);

  insert into scale_point (workshop_id, value, label, description, is_low_trigger, sort_order)
  select p_workshop_id,
         (e->>'value')::smallint,
         btrim(e->>'label'),
         nullif(btrim(coalesce(e->>'description', '')), ''),
         coalesce((e->>'is_low_trigger')::boolean, false),
         (row_number() over (order by (e->>'value')::int) - 1)::smallint
  from jsonb_array_elements(p_points) e
  on conflict (workshop_id, value) do update
    set label = excluded.label,
        description = excluded.description,
        is_low_trigger = excluded.is_low_trigger,
        sort_order = excluded.sort_order;

  return _remapped;
end $$;

comment on function set_workshop_scale(uuid, jsonb, jsonb) is
  'Replace a workshop''s grading scale in one transaction (tl-09). Refuses unless the caller is an admin of that workshop, refuses an illegal scale, and refuses to drop a point that still holds observations unless p_remap names a surviving value for it. Returns the number of observations remapped.';

revoke all on function set_workshop_scale(uuid, jsonb, jsonb) from public;
grant execute on function set_workshop_scale(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RLS: read by the workshop's members, written by nobody directly.
--
--    The missing insert/update/delete policies are the design, not an omission.
--    With no policy a write is refused whatever role the caller holds, which
--    leaves set_workshop_scale() as the only way in — and therefore leaves the
--    two-to-six rule with no path around it.
-- ---------------------------------------------------------------------------

alter table scale_point enable row level security;

drop policy if exists scale_point_select on scale_point;
create policy scale_point_select on scale_point for select to authenticated
  using (is_workshop_member(workshop_id));

grant select on scale_point to authenticated;
revoke insert, update, delete on scale_point from authenticated;

-- ---------------------------------------------------------------------------
-- 7. Seed every existing workshop with the scale it has always had.
--
--    Values 0-3, today's rubric wording, triggers on 0 and 1 — which is exactly
--    the behaviour the app had before this migration. A workshop that is never
--    edited afterwards behaves identically, which is the regression gate this
--    spec is measured against.
--
--    Inserted directly rather than through set_workshop_scale() because that
--    function resolves the CALLER's role and a migration has no caller.
-- ---------------------------------------------------------------------------

create or replace function seed_default_scale(p_workshop_id uuid)
returns void
language sql
as $$
  insert into scale_point (workshop_id, value, label, description, is_low_trigger, sort_order)
  select p_workshop_id, p.value, p.label, null, p.is_low_trigger, p.sort_order
  from (values
    (0::smallint, 'not yet demonstrated', true,  0::smallint),
    (1::smallint, 'emerging',             true,  1::smallint),
    (2::smallint, 'competent',            false, 2::smallint),
    (3::smallint, 'strong',               false, 3::smallint)
  ) as p(value, label, is_low_trigger, sort_order)
  where not exists (select 1 from scale_point sp where sp.workshop_id = p_workshop_id)
  on conflict (workshop_id, value) do nothing;
$$;

insert into scale_point (workshop_id, value, label, description, is_low_trigger, sort_order)
select w.id, p.value, p.label, null, p.is_low_trigger, p.sort_order
from workshop w
cross join (values
  (0::smallint, 'not yet demonstrated', true,  0::smallint),
  (1::smallint, 'emerging',             true,  1::smallint),
  (2::smallint, 'competent',            false, 2::smallint),
  (3::smallint, 'strong',               false, 3::smallint)
) as p(value, label, is_low_trigger, sort_order)
where not exists (select 1 from scale_point sp where sp.workshop_id = w.id)
on conflict (workshop_id, value) do nothing;

-- ---------------------------------------------------------------------------
-- 8. A new workshop is born with a scale.
--
--    The same shape as tl-01's membership trigger, and for the same reason: a
--    workshop with no scale is not a broken workshop, but it is one whose
--    administrator has to discover the Scale section before any capture screen
--    can offer a rating. Seeding on insert means the create flow lands somebody
--    on a working workshop and lets them change the scale rather than build it.
--
--    security definer, because `scale_point` has no insert policy at all and the
--    creating member is not exempt from that.
-- ---------------------------------------------------------------------------

create or replace function seed_scale_for_new_workshop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_default_scale(new.id);
  return new;
end $$;

drop trigger if exists workshop_seed_scale on workshop;
create trigger workshop_seed_scale
  after insert on workshop
  for each row execute function seed_scale_for_new_workshop();
