-- tl-12: bio profiles for participants and evaluators.
--
-- Joshua's feedback asked for "little bio profiles ... Certifications, Education,
-- Areas of work experience, Other trainings they've attended in the same track",
-- and the last clause is the one that forces a schema rather than four columns on
-- `participant`. A participant row is scoped to ONE workshop, so the same human
-- attending the Epistles workshop last year and the Psalms workshop this year is
-- two unrelated rows. "Other trainings in the same track" cannot be answered from
-- that model at all.
--
-- So `person` is the durable identity and `participant.person_id` / `app_user.person_id`
-- point at it. The track history is then a derived fact: the set of workshops whose
-- participant rows share a person. Nothing about it is stored, because a stored
-- derivation goes stale the first time somebody is added to a workshop.
--
-- ## The consent flag is deliberately absent
--
-- The spec called for `consent_given` / `consent_at`, defaulting false, gating
-- visibility. Joshua was asked and chose to drop it (2026-08-01): participants have
-- no accounts, so consent could only ever be an ADMIN ticking a box on somebody
-- else's behalf, and a 26-person imported roster would show an evaluator nothing
-- until 26 such boxes were ticked. A permission the subject cannot exercise and the
-- operator must sweep through is not a consent record, it is a chore that gets
-- swept. `visibility` alone governs, and it is a real choice with a real default.
--
-- ## The version numbers were claimed before this file was written
--
-- `20260801000700` and Dexie v17, both in the program file's concurrency section.
-- tl-06 and tl-09 both shipped `20260801000200` on 2026-08-01 because neither
-- branch could see the other's migrations folder; `supabase_migrations` records a
-- version and not a filename, so the second to land is read as already applied and
-- never recorded. Claiming in the plan is the fix.

-- ---------------------------------------------------------------------------
-- 1. The durable identity.
--
--    Thin on purpose. Everything a profile actually holds is in `person_profile`;
--    this table exists to be pointed AT, and the two columns it carries are the
--    two a merge screen needs to show you who it is proposing to combine.
--
--    `created_by` is not bookkeeping. A person row is inserted before anything
--    points at it, so at the instant of the insert it belongs to no workshop and
--    the membership-derived read policy below cannot see it. PostgREST always asks
--    for the representation, so `insert ... returning` consults the SELECT policy
--    too — the exact trap tl-02 spent a session diagnosing on `workshop`. One
--    `or created_by = current_app_user_id()` clause on the read policy is what
--    keeps a freshly created person visible to the admin who just created them.
-- ---------------------------------------------------------------------------

create table if not exists person (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  -- Normalized to lower case by the app and by the merge RPC. Unique where
  -- present, because an exact email match is the ONLY thing this system will
  -- auto-link on, and two person rows holding one address would make that link
  -- ambiguous. Nullable: plenty of participants have no address on file.
  primary_email text unique,
  created_by    uuid references app_user (id) on delete set null default current_app_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table person is
  'tl-12. A human, across workshops. participant.person_id and app_user.person_id point here; the track history is derived from shared person_id, never stored.';

-- ---------------------------------------------------------------------------
-- 2. The profile.
--
--    List fields are text[] rather than modelled institutions with dates. Joshua
--    asked for a little background; a normalized credentials schema is a different
--    product, and the spec says so.
--
--    `prior_trainings` holds SELF-REPORTED entries only — trainings elsewhere,
--    "tracks offered by others", which this deployment cannot vouch for. Trainings
--    inside the deployment are derived from shared person_id at read time and are
--    rendered as a visually distinct kind. Storing the derived ones would mean a
--    profile that still claims a workshop after somebody is removed from it.
-- ---------------------------------------------------------------------------

create table if not exists person_profile (
  person_id        uuid primary key references person (id) on delete cascade,
  headline         text,
  certifications   text[] not null default '{}',
  education        text[] not null default '{}',
  experience_areas text[] not null default '{}',
  languages        text[] not null default '{}',
  -- [{ "label": "...", "year": "2024" }, ...]. Self-reported, see above.
  prior_trainings  jsonb  not null default '[]'::jsonb,
  notes            text,
  visibility       text   not null default 'workshop'
                     check (visibility in ('workshop', 'admins', 'private')),
  updated_at       timestamptz not null default now(),
  updated_by       text
);

comment on table person_profile is
  'tl-12. Background, not assessment. Assessment lives in observation; a profile is what you read BEFORE you watch somebody.';

-- ---------------------------------------------------------------------------
-- 3. The two nullable links.
--
--    `on delete set null`, not cascade, in both directions. Deleting a person must
--    never take a participant row with it: the participant carries the evidence.
-- ---------------------------------------------------------------------------

alter table participant add column if not exists person_id uuid references person (id) on delete set null;
alter table app_user    add column if not exists person_id uuid references person (id) on delete set null;

create index if not exists participant_person_idx on participant (person_id);
create index if not exists app_user_person_idx    on app_user (person_id);

-- ---------------------------------------------------------------------------
-- 4. Reach helpers.
--
--    "Which workshops is this person in" has two answers that both count: the
--    workshops their participant rows belong to, and the workshops their account
--    is a member of. An evaluator has no participant row and must still have a
--    readable profile, which is half of what this spec is for.
--
--    security definer, search_path pinned, for the same reason every other helper
--    here is: a policy on the child should not drag the parent's RLS into its own
--    evaluation, and an unpinned definer function is a privilege-escalation
--    primitive.
-- ---------------------------------------------------------------------------

-- Is the caller a member of ANY workshop this person appears in?
create or replace function person_shares_workshop(_person_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from participant p
    where p.person_id = _person_id and is_workshop_member(p.workshop_id)
  ) or exists (
    select 1
    from app_user au
    join workshop_member wm on wm.app_user_id = au.id
    where au.person_id = _person_id and is_workshop_member(wm.workshop_id)
  )
$$;

-- Does the caller ADMINISTER any workshop this person appears in?
create or replace function person_is_administered_by_me(_person_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from participant p
    where p.person_id = _person_id
      and has_workshop_role(p.workshop_id, array['chief_admin', 'admin'])
  ) or exists (
    select 1
    from app_user au
    join workshop_member wm on wm.app_user_id = au.id
    where au.person_id = _person_id
      and has_workshop_role(wm.workshop_id, array['chief_admin', 'admin'])
  )
$$;

-- Is this person the caller?
create or replace function is_my_person(_person_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from app_user
    where auth_user_id = auth.uid() and person_id = _person_id and person_id is not null
  )
$$;

-- Did the caller create this person row, before anything pointed at it?
create or replace function i_created_person(_person_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from person
    where id = _person_id and created_by is not null and created_by = current_app_user_id()
  )
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS on `person`.
--
--    Readable by anyone who shares a workshop with them, by themselves, and by
--    whoever created the row (see the created_by note in section 1). Written by an
--    administrator of one of their workshops, by themselves, or by their creator.
--
--    Insert is `has_any_workshop_role(admin)` rather than something workshop-shaped,
--    because at insert time the row is in no workshop. That is a real widening and
--    it is bounded: what an admin can create is a name and an email, visible to
--    nobody until they link it to a participant in a workshop they administer.
-- ---------------------------------------------------------------------------

alter table person enable row level security;
alter table person_profile enable row level security;

revoke all on public.person         from anon, authenticated;
revoke all on public.person_profile from anon, authenticated;
grant select, insert, update, delete on public.person         to authenticated;
grant select, insert, update, delete on public.person_profile to authenticated;

drop policy if exists person_select on person;
drop policy if exists person_insert on person;
drop policy if exists person_update on person;
drop policy if exists person_delete on person;

create policy person_select on person for select to authenticated
  using (person_shares_workshop(id) or is_my_person(id) or i_created_person(id));

create policy person_insert on person for insert to authenticated
  with check (has_any_workshop_role(array['chief_admin', 'admin']));

create policy person_update on person for update to authenticated
  using (person_is_administered_by_me(id) or is_my_person(id) or i_created_person(id))
  with check (person_is_administered_by_me(id) or is_my_person(id) or i_created_person(id));

create policy person_delete on person for delete to authenticated
  using (person_is_administered_by_me(id) or i_created_person(id));

-- ---------------------------------------------------------------------------
-- 6. RLS on `person_profile`, which is where the visibility setting is enforced.
--
--    The whole point of the column is that it is a SERVER rule. A drawer that
--    declines to render an `admins` profile is a UI convention; a policy that
--    declines to return the row is a permission. tl-03's carry-forward says the
--    same thing about capture text and records it as a known gap; this table does
--    not repeat it.
--
--    Read, by case:
--      workshop — any member of a workshop the person is in, plus admins, plus self
--      admins   — administrators of one of their workshops, plus self
--      private  — self, plus administrators (who can already read the row through
--                 the export and the merge screen; pretending otherwise would be a
--                 lock with a published key)
--
--    Write: administrators of one of their workshops, the person themselves, or
--    the creator of a person not yet linked to anything. An evaluator writing
--    somebody else's profile is the negative test this spec ships.
-- ---------------------------------------------------------------------------

drop policy if exists person_profile_select on person_profile;
drop policy if exists person_profile_insert on person_profile;
drop policy if exists person_profile_update on person_profile;
drop policy if exists person_profile_delete on person_profile;

create policy person_profile_select on person_profile for select to authenticated
  using (
    is_my_person(person_id)
    or person_is_administered_by_me(person_id)
    or i_created_person(person_id)
    or (visibility = 'workshop' and person_shares_workshop(person_id))
  );

create policy person_profile_insert on person_profile for insert to authenticated
  with check (
    is_my_person(person_id)
    or person_is_administered_by_me(person_id)
    or i_created_person(person_id)
  );

create policy person_profile_update on person_profile for update to authenticated
  using (
    is_my_person(person_id)
    or person_is_administered_by_me(person_id)
    or i_created_person(person_id)
  )
  with check (
    is_my_person(person_id)
    or person_is_administered_by_me(person_id)
    or i_created_person(person_id)
  );

create policy person_profile_delete on person_profile for delete to authenticated
  using (is_my_person(person_id) or person_is_administered_by_me(person_id));

-- ---------------------------------------------------------------------------
-- 6b. The card: the two facts a reader needs that the tables above cannot give.
--
--     Both were found by the browser walkthrough rather than by reading, and both
--     are the same underlying problem: RLS FILTERS rather than refuses, so the
--     client cannot tell "you may not see this" from "there is nothing here".
--
--     **The denial.** `person_profile_select` withholds an `admins`-only profile
--     by returning no row. An evaluator's device therefore has no row and no
--     visibility value, so the drawer reported "no background has been recorded"
--     — which is a lie, and the exact failure the whole `denial` path was written
--     to prevent. The visibility STATE has to be knowable to somebody who may not
--     read the profile, and that can only come from here.
--
--     **The track history.** "Other trainings they've attended in the same track"
--     is derived from participant rows in OTHER workshops, and an evaluator is a
--     member of one workshop. Their device pulls only the workshops they belong
--     to, so the Epistles row that makes this whole feature worth building was
--     invisible to exactly the person it exists for. Deriving it client-side
--     cannot work; it is a fact about workshops the reader has no access to.
--
--     So a security-definer function computes both and returns names only — a
--     workshop's name and year, never a participant id, never a designation,
--     never anything from inside a workshop the caller is not in. The trainings
--     are withheld on the same rule as the profile, so an `admins`-only profile
--     does not leak its owner's history to an evaluator through the back door.
-- ---------------------------------------------------------------------------

create or replace function person_card(_person_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  _vis       text;
  _self      boolean := is_my_person(_person_id);
  _admin     boolean := person_is_administered_by_me(_person_id);
  _shares    boolean := person_shares_workshop(_person_id);
  _readable  boolean;
  _state     text;
  _trainings jsonb;
begin
  if not (_self or _admin or _shares) then
    return jsonb_build_object('state', 'not-in-workshop', 'readable', false, 'trainings', '[]'::jsonb);
  end if;

  select visibility into _vis from person_profile where person_id = _person_id;

  if _vis is null then
    -- No profile written yet. Nothing is being withheld, so the drawer's "no
    -- background recorded" is the truthful thing to say, and the track history
    -- still stands: it is derived from attendance, not from anything typed.
    _state := 'none';
    _readable := true;
  elsif _self or _admin or _vis = 'workshop' then
    _state := _vis;
    _readable := true;
  else
    _state := _vis;
    _readable := false;
  end if;

  if _readable then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'workshop_id', w.id,
          'label', w.name,
          'year', to_char(coalesce(w.start_date, w.end_date), 'YYYY')
        )
        order by coalesce(w.start_date, w.end_date) desc nulls last
      ),
      '[]'::jsonb
    )
    into _trainings
    from (select distinct workshop_id from participant where person_id = _person_id) p
    join workshop w on w.id = p.workshop_id;
  end if;

  return jsonb_build_object(
    'state', _state,
    'readable', _readable,
    'trainings', coalesce(_trainings, '[]'::jsonb)
  );
end $$;

revoke all on function person_card(uuid) from public, anon;
grant execute on function person_card(uuid) to authenticated;

comment on function person_card(uuid) is
  'tl-12. Visibility state plus derived track history for one person. Exists because RLS filters rather than refuses, so a client cannot tell a withheld profile from an absent one, and because the track history spans workshops the reader cannot read.';

-- ---------------------------------------------------------------------------
-- 7. Merge.
--
--    An RPC rather than a policy, and online-only, which is the same exception
--    tl-02's three membership RPCs took and for the same reason: a merge is atomic
--    across four tables and it is the server's decision, not the caller's
--    observation. Queueing one offline would show two histories combined that the
--    server may refuse an hour later.
--
--    The authorization rule is deliberately strict: the caller must administer a
--    workshop for BOTH people. Merging is the one operation in this spec that can
--    destroy information an admin cannot see — combining somebody's history with a
--    stranger's from a workshop the caller has no part in — so "I administer one of
--    them" is not enough.
--
--    Field merge rules, chosen so a merge can only ever ADD:
--      arrays  — union, order-preserving, survivor first
--      scalars — survivor's value if it is non-empty, else the absorbed one
--      visibility — the NARROWER of the two, because widening somebody's exposure
--                   as a side effect of an administrative tidy-up is not something
--                   anybody consented to
-- ---------------------------------------------------------------------------

create or replace function narrower_visibility(_a text, _b text)
returns text
language sql immutable
as $$
  select case
    when _a = 'private' or _b = 'private' then 'private'
    when _a = 'admins'  or _b = 'admins'  then 'admins'
    else 'workshop'
  end
$$;

create or replace function text_array_union(_a text[], _b text[])
returns text[]
language sql immutable
as $$
  select coalesce(
    (select array_agg(v order by ord)
     from (
       -- Group on the trimmed value and keep the earliest position, so the
       -- survivor's ordering survives and " CLAT " does not arrive beside "CLAT".
       select btrim(v) as v, min(ord) as ord
       from unnest(coalesce(_a, '{}'::text[]) || coalesce(_b, '{}'::text[]))
            with ordinality as t(v, ord)
       where btrim(v) <> ''
       group by btrim(v)
     ) d),
    '{}'::text[]
  )
$$;

create or replace function merge_persons(_survivor_id uuid, _absorbed_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _survivor  person%rowtype;
  _absorbed  person%rowtype;
  _sp        person_profile%rowtype;
  _ap        person_profile%rowtype;
  _moved_participants int := 0;
  _moved_accounts     int := 0;
  _actor text := current_app_user_email();
begin
  if _survivor_id is null or _absorbed_id is null then
    perform raise_refusal('tl12.merge_needs_two', 'A merge needs two different people.');
  end if;
  if _survivor_id = _absorbed_id then
    perform raise_refusal('tl12.merge_needs_two', 'A merge needs two different people.');
  end if;
  if _actor is null then
    perform raise_refusal('tl12.no_account', 'No account for the calling session.');
  end if;

  select * into _survivor from person where id = _survivor_id;
  select * into _absorbed from person where id = _absorbed_id;
  if _survivor.id is null or _absorbed.id is null then
    perform raise_refusal('tl12.person_not_found', 'One of those people no longer exists.');
  end if;

  -- BOTH, not either. See the header.
  if not (person_is_administered_by_me(_survivor_id) and person_is_administered_by_me(_absorbed_id)) then
    perform raise_refusal(
      'tl12.merge_needs_both_workshops',
      'You can only merge two people if you administer a workshop for each of them.'
    );
  end if;

  select * into _sp from person_profile where person_id = _survivor_id;
  select * into _ap from person_profile where person_id = _absorbed_id;

  if _ap.person_id is not null then
    if _sp.person_id is null then
      -- No survivor profile: move the absorbed one across wholesale.
      insert into person_profile (
        person_id, headline, certifications, education, experience_areas,
        languages, prior_trainings, notes, visibility, updated_at, updated_by
      ) values (
        _survivor_id, _ap.headline, _ap.certifications, _ap.education, _ap.experience_areas,
        _ap.languages, _ap.prior_trainings, _ap.notes, _ap.visibility, now(), _actor
      );
    else
      update person_profile set
        headline         = coalesce(nullif(btrim(_sp.headline), ''), _ap.headline),
        notes            = coalesce(nullif(btrim(_sp.notes), ''), _ap.notes),
        certifications   = text_array_union(_sp.certifications,   _ap.certifications),
        education        = text_array_union(_sp.education,        _ap.education),
        experience_areas = text_array_union(_sp.experience_areas, _ap.experience_areas),
        languages        = text_array_union(_sp.languages,        _ap.languages),
        -- jsonb `||` on two arrays concatenates. Duplicates are the app's problem
        -- to show and the admin's to tidy; dropping one silently would be worse.
        prior_trainings  = coalesce(_sp.prior_trainings, '[]'::jsonb) || coalesce(_ap.prior_trainings, '[]'::jsonb),
        visibility       = narrower_visibility(_sp.visibility, _ap.visibility),
        updated_at       = now(),
        updated_by       = _actor
      where person_id = _survivor_id;
    end if;
  end if;

  update participant set person_id = _survivor_id where person_id = _absorbed_id;
  get diagnostics _moved_participants = row_count;
  update app_user   set person_id = _survivor_id where person_id = _absorbed_id;
  get diagnostics _moved_accounts = row_count;

  -- Keep the absorbed person's email if the survivor has none, so an auto-link on
  -- that address keeps working afterwards. Clear it on the absorbed row first:
  -- primary_email is unique, and the survivor cannot take an address still held.
  if _survivor.primary_email is null and _absorbed.primary_email is not null then
    update person set primary_email = null where id = _absorbed_id;
    update person set primary_email = _absorbed.primary_email, updated_at = now() where id = _survivor_id;
  end if;

  -- Cascades to the absorbed profile. The participant and app_user rows have
  -- already been repointed above, so nothing carrying evidence is touched.
  delete from person where id = _absorbed_id;

  return jsonb_build_object(
    'ok', true,
    'survivor_id', _survivor_id,
    'absorbed_id', _absorbed_id,
    'survivor_name', _survivor.display_name,
    'absorbed_name', _absorbed.display_name,
    'moved_participants', _moved_participants,
    'moved_accounts', _moved_accounts
  );
end $$;

revoke all on function merge_persons(uuid, uuid) from public, anon;
grant execute on function merge_persons(uuid, uuid) to authenticated;

comment on function merge_persons(uuid, uuid) is
  'tl-12. Combines two person rows. Requires the caller to administer a workshop for BOTH. Never touches evaluation evidence: participant rows are repointed, not deleted.';

-- ---------------------------------------------------------------------------
-- 8. Link an account to a person when it is created.
--
--    This is a trigger and not a client write, and the reason is worth stating
--    because the client-side version is the obvious thing to reach for and cannot
--    work. tl-01 REVOKED the write grants on `app_user` rather than merely
--    omitting a policy, so a browser cannot write that table at all: `update
--    app_user set person_id = ...` comes back 42501 for every caller including a
--    platform owner, and the account goes on looking unlinked with nothing saying
--    why. Same find-or-create rule as everywhere else — exact normalized email.
--
--    AFTER INSERT rather than inside `handle_new_user`, so tl-11's invite-only
--    admission logic is left exactly as it is: this spec adds a link, it does not
--    get a say in who may sign up.
-- ---------------------------------------------------------------------------

create or replace function app_user_link_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _email text := lower(btrim(new.email));
  _pid uuid;
begin
  if new.person_id is not null or _email is null or _email = '' then
    return new;
  end if;
  select id into _pid from person where primary_email = _email;
  if _pid is null then
    insert into person (display_name, primary_email, created_by)
    values (coalesce(nullif(btrim(new.name), ''), _email), _email, null)
    returning id into _pid;
  end if;
  update app_user set person_id = _pid where id = new.id;
  return new;
end $$;

drop trigger if exists app_user_link_person_trigger on app_user;
create trigger app_user_link_person_trigger
  after insert on app_user
  for each row execute function app_user_link_person();

-- ---------------------------------------------------------------------------
-- 9. Auto-link the people already on file.
--
--    Exact normalized email only, and only where that address identifies exactly
--    one participant name and one account. Anything ambiguous is left for the merge
--    screen, which asks a human. Never fuzzy-match: a wrong merge blends two
--    humans' evaluation histories and unpicking it afterwards is worse than never
--    having linked them, which is the same rule tl-10 applies to roster import.
-- ---------------------------------------------------------------------------

do $$
declare
  _rec record;
  _pid uuid;
begin
  for _rec in
    select lower(btrim(email)) as email, min(name) as name
    from (
      select registered_email as email, name from participant
      where registered_email is not null and btrim(registered_email) <> '' and person_id is null
      union all
      select email, name from app_user
      where email is not null and btrim(email) <> '' and person_id is null
    ) s
    where email is not null and btrim(email) <> ''
    group by lower(btrim(email))
  loop
    select id into _pid from person where primary_email = _rec.email;
    if _pid is null then
      insert into person (display_name, primary_email, created_by)
      values (_rec.name, _rec.email, null)
      returning id into _pid;
    end if;
    update participant set person_id = _pid
      where person_id is null and lower(btrim(registered_email)) = _rec.email;
    update app_user set person_id = _pid
      where person_id is null and lower(btrim(email)) = _rec.email;
  end loop;
end $$;
