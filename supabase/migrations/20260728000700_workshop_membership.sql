-- Throughline — tl-01: per-workshop membership.
--
-- Moves every evaluation-facing role off the global `app_user.role` column and
-- into `workshop_member(workshop_id, app_user_id, role)`, so one deployment can
-- host several organizations' workshops with different people holding different
-- roles in each. `app_user.role` narrows to a platform tier that exists only to
-- bootstrap: somebody has to be able to create the first workshop before any
-- membership row exists.
--
-- Two rules this migration enforces, and they are the whole point:
--   1. Every authorization decision resolves auth.uid() -> app_user ->
--      workshop_member server-side. The client's active-workshop selection is an
--      input to be validated, never a claim to be trusted.
--   2. `workshop_member` has NO client write path at all — not a policy, not even
--      a grant. Memberships change through the security-definer trigger below and,
--      from tl-02/tl-11, through RPCs. A browser cannot add itself to a workshop.
--
-- Apply after 20260707000600_role_allowlist_and_rls.sql.
--
-- Behaviour changes worth knowing before applying:
--   * Reads on the nine data tables are no longer open. An unauthenticated device
--     now shows the bundled seed data rather than real workshop data (see
--     src/db/reference.ts). This is deliberate: `using (true)` reads were the
--     largest remaining hole once roles became per-workshop.
--   * Creating a workshop requires `platform_owner`. The creator is added as that
--     workshop's `chief_admin` automatically, or they would immediately lose sight
--     of the row they just inserted.
--   * `app_user` is no longer readable in full by every session. You see yourself,
--     plus people you share a workshop with.

-- ---------------------------------------------------------------------------
-- 1. The membership table.
-- ---------------------------------------------------------------------------

create table if not exists workshop_member (
  workshop_id  uuid not null references workshop(id) on delete cascade,
  app_user_id  uuid not null references app_user(id) on delete cascade,
  role         text not null
    check (role in ('chief_admin','admin','chief_evaluator','consultant','evaluator','participant')),
  added_by     uuid references app_user(id) on delete set null,
  added_at     timestamptz not null default now(),
  primary key (workshop_id, app_user_id)
);

-- "which workshops am I in" runs on every app load; "who administers this
-- workshop" runs on every promotion screen (tl-02, tl-11).
create index if not exists workshop_member_app_user_idx on workshop_member (app_user_id);
create index if not exists workshop_member_workshop_role_idx on workshop_member (workshop_id, role);

alter table workshop_member enable row level security;

-- Read-only to clients, and only through the policy below. Supabase's default
-- privileges grant all on new public tables to anon/authenticated, so the write
-- grants are revoked explicitly rather than left to RLS alone: an attempt to
-- insert a membership should fail at the grant, before any policy is consulted.
revoke all on public.workshop_member from anon, authenticated;
grant select on public.workshop_member to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Seed memberships from the existing global roles, BEFORE narrowing the
--    column. Every current account keeps the access it had, inside the pilot
--    workshop. `do nothing` on conflict, so a re-run cannot stomp a role that
--    has been changed since.
-- ---------------------------------------------------------------------------

insert into workshop_member (workshop_id, app_user_id, role, added_by)
select w.id,
       u.id,
       case u.role
         when 'admin'           then 'admin'
         when 'chief_evaluator' then 'chief_evaluator'
         when 'consultant'      then 'consultant'
         when 'participant'     then 'participant'
         else 'evaluator'
       end,
       u.id
from app_user u
cross join workshop w
where u.role in ('admin','chief_evaluator','consultant','evaluator','participant')
on conflict (workshop_id, app_user_id) do nothing;

-- The owner account holds chief_admin in the pilot workshop. tl-02 turns
-- "exactly one chief_admin per workshop" into an enforced invariant; this
-- migration only seeds a consistent starting state.
update workshop_member wm
   set role = 'chief_admin'
  from app_user u
 where u.id = wm.app_user_id
   and lower(u.email) = 'josh_frost@sil.org';

-- ---------------------------------------------------------------------------
-- 3. The allowlist now describes a workshop role plus a platform tier.
--
--    Per-workshop invitations are tl-11's job. Until then the allowlist carries
--    an optional `default_workshop_id`: when set, a new signup is added to that
--    workshop with `assigned_role`. Without this bridge, every invited evaluator
--    who signs up before tl-11 lands would arrive at a no-membership dead end.
-- ---------------------------------------------------------------------------

alter table role_allowlist
  add column if not exists platform_owner      boolean not null default false,
  add column if not exists default_workshop_id uuid references workshop(id) on delete set null;

alter table role_allowlist drop constraint if exists role_allowlist_assigned_role_check;
alter table role_allowlist
  add constraint role_allowlist_assigned_role_check
    check (assigned_role in ('chief_admin','admin','chief_evaluator','consultant','evaluator','participant'));

-- The owner is the platform tier's only holder. Everyone else is a member of the
-- workshops they are added to and nothing more.
update role_allowlist
   set platform_owner = (lower(email) = 'josh_frost@sil.org'),
       default_workshop_id = (select id from workshop order by start_date limit 1);

-- ---------------------------------------------------------------------------
-- 4. Narrow app_user.role to the platform tier.
--
--    `platform_owner` grants exactly three powers: create a workshop, manage
--    role_allowlist, recover a workshop whose chief_admin is gone. It is not an
--    evaluation role and grants nothing inside a workshop it holds no membership
--    in — every policy below keys off workshop_member, never off this column.
-- ---------------------------------------------------------------------------

alter table app_user drop constraint if exists app_user_role_check;

update app_user
   set role = case when lower(email) = 'josh_frost@sil.org' then 'platform_owner' else 'member' end
 where role not in ('platform_owner','member');

alter table app_user
  add constraint app_user_role_check check (role in ('platform_owner','member'));

alter table app_user alter column role set default 'member';

-- ---------------------------------------------------------------------------
-- 5. Signup provisioning: platform tier on app_user, workshop role on
--    workshop_member. Still invite-only.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _name      text;
  _allowed   text[];
  _assigned  text;
  _requested text;
  _role      text;
  _owner     boolean;
  _workshop  uuid;
  _app_user  uuid;
begin
  select allowed_roles, assigned_role, platform_owner, default_workshop_id
    into _allowed, _assigned, _owner, _workshop
    from role_allowlist
    where lower(email) = lower(new.email);

  -- Invite-only: an email absent from the allowlist cannot create an account.
  -- Raising here rolls back the auth.users insert, so no orphan is left behind.
  if _allowed is null then
    raise exception 'Email % is not authorized to sign up. Ask an administrator to add you.', new.email
      using errcode = 'insufficient_privilege';
  end if;

  _name := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), new.email);

  -- Honor a requested workshop role only if the allowlist permits it for this
  -- email; otherwise use the assigned one. The client can never elevate itself.
  _requested := new.raw_user_meta_data->>'role';
  if _requested is not null and _requested = any(_allowed) then
    _role := _requested;
  else
    _role := _assigned;
  end if;

  insert into public.app_user (auth_user_id, email, name, role)
  values (new.id, new.email, _name, case when _owner then 'platform_owner' else 'member' end)
  on conflict (email) do update set
    auth_user_id = excluded.auth_user_id,
    name         = excluded.name,
    role         = excluded.role
  returning id into _app_user;

  -- Bridge until tl-11: place the new account in the allowlist's default
  -- workshop so an invited evaluator can work on day one.
  if _workshop is not null then
    insert into public.workshop_member (workshop_id, app_user_id, role)
    values (_workshop, _app_user, _role)
    on conflict (workshop_id, app_user_id) do nothing;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A workshop's creator becomes its chief_admin.
--
--    Without this, a platform_owner who inserts a workshop cannot see the row
--    they just created — every read policy below requires a membership.
-- ---------------------------------------------------------------------------

create or replace function seed_workshop_chief_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _app_user uuid;
begin
  select id into _app_user from app_user where auth_user_id = auth.uid();
  if _app_user is null then
    -- Server-side insert (migration, seed, service_role). Nothing to attribute.
    return new;
  end if;
  insert into workshop_member (workshop_id, app_user_id, role, added_by)
  values (new.id, _app_user, 'chief_admin', _app_user)
  on conflict (workshop_id, app_user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists workshop_seed_chief_admin on workshop;
create trigger workshop_seed_chief_admin
  after insert on workshop
  for each row execute function seed_workshop_chief_admin();

-- ---------------------------------------------------------------------------
-- 7. Server-side membership resolution.
--
--    One helper set, called by every policy. Thirty inlined joins would be
--    thirty places to audit and thirty places to get wrong. All are
--    security-definer so a policy that consults them does not re-enter RLS on
--    workshop_member (which would recurse) and does not need workshop_member
--    readable to work.
-- ---------------------------------------------------------------------------

create or replace function current_app_user_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select id from app_user where auth_user_id = auth.uid() $$;

create or replace function has_workshop_role(_workshop_id uuid, _roles text[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from workshop_member wm
    join app_user u on u.id = wm.app_user_id
    where wm.workshop_id = _workshop_id
      and u.auth_user_id = auth.uid()
      and wm.role = any (_roles)
  )
$$;

create or replace function is_workshop_member(_workshop_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from workshop_member wm
    join app_user u on u.id = wm.app_user_id
    where wm.workshop_id = _workshop_id
      and u.auth_user_id = auth.uid()
  )
$$;

-- For the tables that are still global rather than per-workshop (`ksa`, until
-- tl-08 gives it a workshop_id): "do you hold this role in any workshop".
create or replace function has_any_workshop_role(_roles text[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from workshop_member wm
    join app_user u on u.id = wm.app_user_id
    where u.auth_user_id = auth.uid()
      and wm.role = any (_roles)
  )
$$;

create or replace function has_any_membership()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from workshop_member wm
    join app_user u on u.id = wm.app_user_id
    where u.auth_user_id = auth.uid()
  )
$$;

create or replace function is_platform_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from app_user
    where auth_user_id = auth.uid() and role = 'platform_owner'
  )
$$;

create or replace function shares_workshop_with(_app_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from workshop_member mine
    join app_user u on u.id = mine.app_user_id
    join workshop_member theirs on theirs.workshop_id = mine.workshop_id
    where u.auth_user_id = auth.uid()
      and theirs.app_user_id = _app_user_id
  )
$$;

-- Parent lookups for the two tables that reach a workshop indirectly. Kept as
-- security-definer functions rather than inline subqueries so a policy on the
-- child does not drag the parent's RLS into its own evaluation.
create or replace function workshop_of_activity(_activity_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$ select workshop_id from activity where id = _activity_id $$;

create or replace function workshop_of_evaluation(_evaluation_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$ select workshop_id from evaluation where id = _evaluation_id $$;

-- ---------------------------------------------------------------------------
-- 8. Rewrite RLS on the nine data tables, plus app_user and workshop_member.
--
--    The join path from each table to its workshop, stated once so it is
--    reviewable rather than buried in thirty-six policy bodies:
--
--      workshop               id
--      team                   workshop_id
--      participant            workshop_id
--      activity               workshop_id
--      activity_ksa           -> activity.workshop_id
--      evaluation             workshop_id
--      observation            -> evaluation.workshop_id
--      mentoring_conversation workshop_id
--      ksa                    (none yet — global table; tl-08 makes it
--                              per-workshop and tightens these two policies)
--
--    Who may write what:
--      reference tables (workshop/team/participant/activity/activity_ksa/ksa)
--        -> the workshop's authors: chief_admin, admin, chief_evaluator. This
--           mirrors the surfaces those roles can already reach (Builder, Roster);
--           tl-01 makes the existing gates workshop-aware, it does not re-cut them.
--      record tables (evaluation/observation/mentoring_conversation)
--        -> any member may insert and update (evaluators capture their own work);
--           deletes are an author's act.
--      workshop insert -> platform_owner only (the bootstrap power).
--      workshop_member -> nobody, from the browser. See section 1.
-- ---------------------------------------------------------------------------

do $$
declare
  -- table name, expression resolving that row to a workshop id
  scoped text[][] := array[
    ['workshop',               'id'],
    ['team',                   'workshop_id'],
    ['participant',            'workshop_id'],
    ['activity',               'workshop_id'],
    ['activity_ksa',           'workshop_of_activity(activity_id)'],
    ['evaluation',             'workshop_id'],
    ['observation',            'workshop_of_evaluation(evaluation_id)'],
    ['mentoring_conversation', 'workshop_id']
  ];
  reference_tables text[] := array['workshop','team','participant','activity','activity_ksa'];
  authors text := $q$array['chief_admin','admin','chief_evaluator']$q$;
  t text;
  ws text;
  write_expr text;
  i int;
  r record;
begin
  -- Drop every existing policy on the affected tables, whatever it was named.
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'workshop','team','participant','activity','ksa','activity_ksa',
        'evaluation','observation','mentoring_conversation',
        'app_user','workshop_member'
      ])
  loop
    execute format('drop policy %I on public.%I;', r.policyname, r.tablename);
  end loop;

  for i in 1 .. array_length(scoped, 1) loop
    t  := scoped[i][1];
    ws := scoped[i][2];
    execute format('alter table public.%I enable row level security;', t);

    -- Read: membership in the row's workshop. No membership, no row.
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated using (is_workshop_member(%2$s));',
      t, ws
    );

    if t = any (reference_tables) then
      write_expr := format('has_workshop_role(%s, %s)', ws, authors);
      -- workshop rows are created by the platform tier, not by a workshop's own
      -- authors: there is no membership to check before the row exists.
      if t = 'workshop' then
        execute format(
          'create policy workshop_insert on public.workshop for insert to authenticated with check (is_platform_owner());'
        );
      else
        execute format(
          'create policy %1$s_insert on public.%1$I for insert to authenticated with check (%2$s);',
          t, write_expr
        );
      end if;
      execute format(
        'create policy %1$s_update on public.%1$I for update to authenticated using (%2$s) with check (%2$s);',
        t, write_expr
      );
      execute format(
        'create policy %1$s_delete on public.%1$I for delete to authenticated using (%2$s);',
        t, write_expr
      );
    else
      -- Record tables: any member captures and revises; authors delete.
      execute format(
        'create policy %1$s_insert on public.%1$I for insert to authenticated with check (is_workshop_member(%2$s));',
        t, ws
      );
      execute format(
        'create policy %1$s_update on public.%1$I for update to authenticated using (is_workshop_member(%2$s)) with check (is_workshop_member(%2$s));',
        t, ws
      );
      execute format(
        'create policy %1$s_delete on public.%1$I for delete to authenticated using (has_workshop_role(%2$s, %3$s));',
        t, ws, authors
      );
    end if;
  end loop;
end $$;

-- ksa: global until tl-08. Readable by anyone who belongs to a workshop,
-- writable by anyone who authors one. Stated separately because it is the one
-- table whose scope this migration cannot honestly express.
alter table ksa enable row level security;
create policy ksa_select on ksa for select to authenticated using (has_any_membership());
create policy ksa_insert on ksa for insert to authenticated
  with check (has_any_workshop_role(array['chief_admin','admin','chief_evaluator']));
create policy ksa_update on ksa for update to authenticated
  using (has_any_workshop_role(array['chief_admin','admin','chief_evaluator']))
  with check (has_any_workshop_role(array['chief_admin','admin','chief_evaluator']));
create policy ksa_delete on ksa for delete to authenticated
  using (has_any_workshop_role(array['chief_admin','admin','chief_evaluator']));

-- app_user: still read-only to clients (no write policy at all, so the platform
-- tier cannot be self-assigned from a browser). Narrowed from "every session
-- reads every row" to yourself plus the people you share a workshop with, which
-- is what keeps two organizations on one deployment from reading each other's
-- directory.
alter table app_user enable row level security;
create policy app_user_select on app_user for select to authenticated
  using (auth_user_id = auth.uid() or shares_workshop_with(id));

-- workshop_member: you see your own memberships, and the roster of any workshop
-- you belong to. No write policy, and no write grant (section 1).
alter table workshop_member enable row level security;
create policy workshop_member_select on workshop_member for select to authenticated
  using (app_user_id = current_app_user_id() or is_workshop_member(workshop_id));
