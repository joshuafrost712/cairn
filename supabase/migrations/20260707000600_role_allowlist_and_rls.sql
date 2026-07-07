-- Throughline — auth hardening: invite-only signup, allowlist-driven roles,
-- and tightened RLS. Apply after 0005_realtime_evaluation.sql.
--
-- Closes two privilege-escalation holes present in the pilot:
--   1. Signup trusted a client-supplied role, so anyone could self-register as
--      chief_evaluator or admin (SignIn dropdown -> raw_user_meta_data.role ->
--      handle_new_user). Roles are now assigned from role_allowlist, not the client.
--   2. The permissive `*_all for all using(true)` policies let any client (even the
--      anon key) UPDATE app_user.role directly. app_user is now read-only to clients
--      (roles change only via the security-definer trigger / service_role), and data
--      tables allow writes only to authenticated sessions.
--
-- Signup is invite-only: an email absent from role_allowlist cannot create an account.

-- ---------------------------------------------------------------------------
-- 1. Allowlist of who may sign up and with which role(s).
-- ---------------------------------------------------------------------------
create table if not exists role_allowlist (
  email         text primary key,
  -- roles this email may hold; a signup "role" request is honored only if it is
  -- in this set, otherwise the account is created with assigned_role.
  allowed_roles text[] not null,
  -- the role granted by default (and used to reconcile existing accounts).
  assigned_role text not null
    check (assigned_role in ('evaluator','consultant','chief_evaluator','admin','participant')),
  note          text,
  created_at    timestamptz not null default now()
);

-- Lock it down entirely: no anon/authenticated policies, so only the DB owner
-- (migrations, dashboard, service_role) and the security-definer trigger can
-- read or change it. Clients can never see or edit the allowlist.
alter table role_allowlist enable row level security;

-- Seed the initial roster. Emails are stored lowercase (auth stores them lowercase).
insert into role_allowlist (email, allowed_roles, assigned_role, note) values
  ('josh_frost@sil.org',  array['admin','chief_evaluator','consultant','evaluator'], 'admin',           'Owner'),
  ('nikkicm23@gmail.com', array['chief_evaluator'],                                  'chief_evaluator', 'Chief evaluator'),
  ('hahaday@gmail.com',   array['chief_evaluator'],                                  'chief_evaluator', 'Katie (personal email)'),
  ('katie_frost@sil.org', array['chief_evaluator'],                                  'chief_evaluator', 'Katie (SIL email)'),
  ('viji_mathew@sil.org', array['evaluator'],                                        'evaluator',       'Evaluator'),
  ('viji@sall.com',       array['evaluator'],                                        'evaluator',       'Evaluator')
on conflict (email) do update set
  allowed_roles = excluded.allowed_roles,
  assigned_role = excluded.assigned_role,
  note          = excluded.note;

-- ---------------------------------------------------------------------------
-- 2. Invite-only, allowlist-driven signup provisioning.
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
begin
  select allowed_roles, assigned_role
    into _allowed, _assigned
    from role_allowlist
    where lower(email) = lower(new.email);

  -- Invite-only: reject signups from emails that are not pre-authorized. Raising
  -- here rolls back the auth.users insert, so no orphan account is created.
  if _allowed is null then
    raise exception 'Email % is not authorized to sign up. Ask an administrator to add you.', new.email
      using errcode = 'insufficient_privilege';
  end if;

  _name := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), new.email);

  -- Honor a requested role only if it is one this email is allowed to hold;
  -- otherwise fall back to the assigned role. The client can never elevate itself.
  _requested := new.raw_user_meta_data->>'role';
  if _requested is not null and _requested = any(_allowed) then
    _role := _requested;
  else
    _role := _assigned;
  end if;

  insert into public.app_user (auth_user_id, email, name, role)
  values (new.id, new.email, _name, _role)
  on conflict (email) do update set
    auth_user_id = excluded.auth_user_id,
    name         = excluded.name,
    role         = excluded.role;

  return new;
end;
$$;

-- Trigger already attached in 0003 (on_auth_user_created); replacing the function
-- above is sufficient.

-- ---------------------------------------------------------------------------
-- 3. Backfill app_user rows for any existing auth users on the allowlist.
--    (Notably the owner account, created before the schema/trigger existed.)
-- ---------------------------------------------------------------------------
insert into public.app_user (auth_user_id, email, name, role)
select u.id,
       u.email,
       coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), u.email),
       a.assigned_role
from auth.users u
join role_allowlist a on lower(a.email) = lower(u.email)
on conflict (email) do update set
  auth_user_id = excluded.auth_user_id,
  role         = excluded.role;

-- ---------------------------------------------------------------------------
-- 4. Tighten RLS: drop the permissive pilot policies; reads stay open (needed
--    for offline / pre-auth reference loads and the realtime coverage feed),
--    writes require an authenticated session, and app_user becomes read-only to
--    clients so roles cannot be changed from the browser.
-- ---------------------------------------------------------------------------
do $$
declare
  data_tables text[] := array[
    'workshop','team','participant','activity','ksa',
    'activity_ksa','evaluation','observation','mentoring_conversation'
  ];
  t text;
  r record;
begin
  -- Drop every existing policy on the data tables + app_user, whatever they were named.
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any (data_tables || array['app_user'])
  loop
    execute format('drop policy %I on public.%I;', r.policyname, r.tablename);
  end loop;

  -- Data tables: open reads, authenticated-only writes.
  foreach t in array data_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_select on public.%I for select using (true);', t, t);
    execute format(
      'create policy %I_write on public.%I for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;

  -- app_user: readable by authenticated sessions (identity resolution); NO client
  -- write policy, so inserts/updates/deletes from the browser are blocked. The
  -- security-definer trigger and service_role bypass RLS and remain able to write.
  execute 'alter table public.app_user enable row level security';
  execute 'create policy app_user_select on public.app_user for select to authenticated using (true)';
end $$;
