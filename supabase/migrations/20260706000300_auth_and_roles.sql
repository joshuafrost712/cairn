-- Cairn — real auth integration and extended roles.
-- Adds Supabase Auth linkage to app_user and expands the role set.
-- Apply after 0002_quick_ratings_focus_short_label.sql.
--
-- RLS note: policies below remain permissive for the low-sensitivity pilot
-- (inheriting the pattern from 0001). TIGHTEN: restrict writes to
-- authenticated users (auth.uid() is not null) before wider rollout.
-- Current anon-key reads used by the local seed / offline flow are
-- intentionally left working.

-- ---------------------------------------------------------------------------
-- 1. Expand the role check constraint.
-- ---------------------------------------------------------------------------

-- Drop the existing constraint so we can recreate it with the extended set.
alter table app_user drop constraint if exists app_user_role_check;

alter table app_user
  add constraint app_user_role_check
    check (role in ('evaluator', 'consultant', 'chief_evaluator', 'admin', 'participant'));

-- ---------------------------------------------------------------------------
-- 2. Link app_user rows to Supabase Auth users.
-- ---------------------------------------------------------------------------

alter table app_user
  add column if not exists auth_user_id uuid
    unique
    references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. Auto-provision an app_user row when a new Supabase Auth user signs up.
-- ---------------------------------------------------------------------------

-- Accepted role values (guard against junk in raw_user_meta_data).
-- We use a simple inline check inside the function below.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
-- Run as the DB owner so the function can write to app_user even when called
-- from the auth schema trigger context.
set search_path = public
as $$
declare
  _name  text;
  _role  text;
begin
  -- Resolve display name: prefer meta->>'name', fall back to email address.
  _name := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), new.email);

  -- Resolve role: accept only the five allowed values; default to 'evaluator'.
  _role := coalesce(new.raw_user_meta_data->>'role', 'evaluator');
  if _role not in ('evaluator', 'consultant', 'chief_evaluator', 'admin', 'participant') then
    _role := 'evaluator';
  end if;

  insert into public.app_user (auth_user_id, email, name, role)
  values (new.id, new.email, _name, _role)
  on conflict (email)
  do update set
    auth_user_id = excluded.auth_user_id,
    name         = excluded.name,
    role         = excluded.role;

  return new;
end;
$$;

-- Attach the trigger to auth.users (fires after every new Auth signup).
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
