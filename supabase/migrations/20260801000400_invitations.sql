-- Throughline — tl-11: the people directory and invitations.
--
-- tl-02 built the enforcement: `can_grant`, three security-definer RPCs, and an
-- append-only `membership_change_log`. All of it was unreachable from the app,
-- because every one of those RPCs addresses a person by `app_user_id`, and
-- `app_user_select` shows you only people you ALREADY share a workshop with. So
-- the browser could re-rank somebody who was in the room and could not put anybody
-- into it. Adding an evaluator still meant Joshua editing a migration.
--
-- This migration closes that with an invitation addressed by EMAIL, and with the
-- signup path taught to honor it.
--
-- Apply after 20260801000300_conversation_followup.sql (tl-06).
--
-- ---------------------------------------------------------------------------
-- The one deviation from the spec, decided with Joshua on 2026-08-01
-- ---------------------------------------------------------------------------
--
-- The spec asks `invite_to_workshop` to do two things atomically: write the
-- invitation, and upsert the email into `role_allowlist` so signup will succeed.
-- Revocation then has to undo both halves.
--
-- It is one write here, not two. The spec's own acceptance step already requires
-- `handle_new_user` to admit an email holding a pending invitation, which makes
-- the allowlist write redundant — and redundant is the generous reading. The
-- honest one is that it is a second grant of the same permission, stored in a
-- different table, that a revoke has to remember to take back. A revoke that
-- updates the invitation and misses the allowlist leaves the person able to
-- create an account, which is exactly the bug the spec says a reviewer will look
-- for first. Deleting the second write deletes the bug rather than testing for it.
--
-- So: `role_allowlist` is untouched by this migration and by every RPC in it. It
-- keeps its policy-free lockdown and stays what it has always been — the
-- operator's bootstrap list, the way the first account in a fresh deployment gets
-- in. An invitation is the other way in, and it is the one an administrator can
-- reach. Signup accepts either.

-- ---------------------------------------------------------------------------
-- 1. Invitations are their own state, because they are not memberships.
--
--    A `workshop_member` row needs an `app_user_id`, and the person an admin most
--    needs to see the night before a workshop is the one who has not made an
--    account yet. Keeping the two tables apart is what lets the directory show
--    "invited, has not joined" instead of showing nothing at all.
-- ---------------------------------------------------------------------------

create table if not exists workshop_invitation (
  id                   uuid primary key default gen_random_uuid(),
  workshop_id          uuid not null references workshop(id) on delete cascade,
  -- Stored normalized (lower, trimmed) by the RPC. `auth.users.email` is
  -- lowercase, so a mixed-case invitation would sit pending forever while the
  -- person it names signs in and lands nowhere.
  email                text not null,
  -- `chief_admin` is absent on purpose, matching can_grant: that role is reached
  -- by transfer, never by a grant, and least of all by an invitation to somebody
  -- who does not yet have an account.
  role                 text not null
    check (role in ('admin','chief_evaluator','consultant','evaluator','participant')),
  invited_by           uuid references app_user(id) on delete set null,
  invited_by_email     text,
  invited_at           timestamptz not null default now(),
  status               text not null default 'pending'
    check (status in ('pending','accepted','revoked')),
  accepted_at          timestamptz,
  accepted_app_user_id uuid references app_user(id) on delete set null
);

-- One live invitation per person per workshop. Partial, so a revoked or accepted
-- one does not block a fresh invite, and structural rather than checked inside the
-- RPC for the same reason tl-02's chief-admin index is.
create unique index if not exists workshop_invitation_one_pending
  on workshop_invitation (workshop_id, lower(email))
  where status = 'pending';

create index if not exists workshop_invitation_email_idx
  on workshop_invitation (lower(email))
  where status = 'pending';

alter table workshop_invitation enable row level security;

-- Readable by the people who can act on memberships; writable by nobody. Same
-- shape as membership_change_log, and for the same reason: every write is a
-- decision the server makes, so the only write path is a definer function.
revoke all on public.workshop_invitation from anon, authenticated;
grant select on public.workshop_invitation to authenticated;

drop policy if exists workshop_invitation_select on workshop_invitation;
create policy workshop_invitation_select on workshop_invitation
  for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin']));

-- ---------------------------------------------------------------------------
-- 2. The audit log learns two more verbs.
--
--    tl-02's log answers "who changed this role". An invitation is not a role
--    change yet, and it is still the moment somebody granted an outsider a way in,
--    so it belongs in the same place rather than in a second log nobody reads.
--    `target_app_user_id` is null for an invitation and `target_email` carries the
--    address — which is exactly what those denormalized email columns were for.
-- ---------------------------------------------------------------------------

alter table membership_change_log drop constraint if exists membership_change_log_operation_check;
alter table membership_change_log
  add constraint membership_change_log_operation_check
    check (operation in ('grant','revoke','transfer','recover','invite','uninvite'));

-- The tl-02 logger resolves the target's email from `app_user`, which an invited
-- person does not have a row in. This one takes the email directly.
create or replace function log_invitation_change(
  _workshop_id uuid,
  _actor       uuid,
  _email       text,
  _role        text,
  _operation   text
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into membership_change_log (
    workshop_id, actor_app_user_id, actor_email,
    target_app_user_id, target_email, from_role, to_role, operation
  )
  values (
    _workshop_id,
    _actor, (select lower(email) from app_user where id = _actor),
    null, lower(_email),
    case when _operation = 'uninvite' then _role else null end,
    case when _operation = 'invite'   then _role else null end,
    _operation
  );
end $$;

revoke all on function log_invitation_change(uuid, uuid, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Inviting.
--
--    Two outcomes, and the difference matters enough that the RPC reports which
--    one happened rather than letting the UI guess.
--
--      * The email has no account -> a pending invitation. Nothing has been
--        granted yet; the row is a standing instruction to `handle_new_user`.
--      * The email HAS an account -> the membership is written immediately and the
--        invitation is recorded as already accepted. This is the case tl-02 could
--        not reach at all: `set_workshop_member_role` needs an `app_user_id`, and
--        `app_user_select` hides anybody you do not already share a workshop with,
--        so a browser could not resolve the id of the person it wanted to add.
--        Resolving it inside the definer is the whole point of doing this by email.
--
--    Both paths go through `can_grant` with the target's CURRENT role, so an admin
--    inviting a person who already holds `consultant` somewhere in this workshop is
--    refused for the same reason they cannot re-rank them directly.
-- ---------------------------------------------------------------------------

create or replace function invite_to_workshop(
  _workshop_id uuid,
  _email       text,
  _role        text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  _actor       uuid := current_app_user_id();
  _actor_role  text;
  _norm        text := lower(trim(coalesce(_email, '')));
  _target      uuid;
  _target_role text;
  _id          uuid;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  if _norm = '' or _norm not like '%_@_%.__%' then
    perform raise_refusal('tl11.bad_email', 'That does not look like an email address.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _actor;

  select id into _target from app_user where lower(email) = _norm;
  if _target is not null then
    select role into _target_role
      from workshop_member where workshop_id = _workshop_id and app_user_id = _target;
  end if;

  if _target_role is not null then
    perform raise_refusal('tl11.already_a_member',
      'That person is already in this workshop. Change their role from the directory instead.');
  end if;

  if not can_grant(_actor_role, _target_role, _role) then
    if _role = 'chief_admin' then
      perform raise_refusal('tl02.chief_admin_by_transfer_only',
        'The chief admin role is handed over by transfer, not granted.');
    elsif _actor_role = 'admin' then
      perform raise_refusal('tl02.admin_may_only_grant_evaluator',
        'An admin can invite evaluators. Only the chief admin can invite anyone else.');
    else
      perform raise_refusal('tl02.not_an_administrator',
        'Only this workshop''s administrators can invite people to it.');
    end if;
  end if;

  if exists (
    select 1 from workshop_invitation
     where workshop_id = _workshop_id and lower(email) = _norm and status = 'pending'
  ) then
    perform raise_refusal('tl11.already_invited',
      'That address already has an invitation waiting. Revoke it first if the role should change.');
  end if;

  insert into workshop_invitation (
    workshop_id, email, role, invited_by, invited_by_email,
    status, accepted_at, accepted_app_user_id
  )
  values (
    _workshop_id, _norm, _role, _actor,
    (select lower(email) from app_user where id = _actor),
    case when _target is null then 'pending' else 'accepted' end,
    case when _target is null then null else now() end,
    _target
  )
  returning id into _id;

  if _target is null then
    perform log_invitation_change(_workshop_id, _actor, _norm, _role, 'invite');
    return jsonb_build_object('outcome', 'invited', 'invitation_id', _id);
  end if;

  insert into workshop_member (workshop_id, app_user_id, role, added_by)
  values (_workshop_id, _target, _role, _actor)
  on conflict (workshop_id, app_user_id) do update set role = excluded.role;

  perform log_membership_change(_workshop_id, _actor, _target, null, _role, 'grant');
  return jsonb_build_object('outcome', 'added', 'invitation_id', _id);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Revoking, which is one write because there is only one grant to take back.
--
--    Permission is read as "could you have issued this invitation" — can_grant
--    against a target who is not a member, which is what a pending invitee is. So
--    an admin can revoke the evaluator invitations they can issue and cannot
--    revoke a chief admin's invitation to a consultant.
-- ---------------------------------------------------------------------------

create or replace function revoke_invitation(_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor      uuid := current_app_user_id();
  _actor_role text;
  _inv        workshop_invitation%rowtype;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  select * into _inv from workshop_invitation where id = _id;
  if _inv.id is null then
    perform raise_refusal('tl11.unknown_invitation', 'That invitation no longer exists.');
  end if;
  if _inv.status <> 'pending' then
    perform raise_refusal('tl11.not_pending',
      'That invitation has already been accepted or revoked.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _inv.workshop_id and app_user_id = _actor;

  if not can_grant(_actor_role, null, _inv.role) then
    if _actor_role = 'admin' then
      perform raise_refusal('tl02.admin_may_only_grant_evaluator',
        'An admin can withdraw evaluator invitations. Only the chief admin can withdraw the others.');
    else
      perform raise_refusal('tl02.not_an_administrator',
        'Only this workshop''s administrators can withdraw an invitation.');
    end if;
  end if;

  update workshop_invitation set status = 'revoked' where id = _id;
  perform log_invitation_change(_inv.workshop_id, _actor, _inv.email, _inv.role, 'uninvite');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Re-sending.
--
--    There is no outbound mail service (spec, out of scope), so "resend" cannot
--    mean a second email went out and the UI must not imply one did. What it means
--    here is that the invitation is dated today, so the copyable message an admin
--    pastes into their own mail client is not stamped a fortnight ago.
--
--    Deliberately NOT logged. Nothing about who may do what changed, and a log
--    that fills with non-events is a log people stop reading.
-- ---------------------------------------------------------------------------

create or replace function resend_invitation(_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor      uuid := current_app_user_id();
  _actor_role text;
  _inv        workshop_invitation%rowtype;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  select * into _inv from workshop_invitation where id = _id;
  if _inv.id is null then
    perform raise_refusal('tl11.unknown_invitation', 'That invitation no longer exists.');
  end if;
  if _inv.status <> 'pending' then
    perform raise_refusal('tl11.not_pending', 'That invitation has already been accepted or revoked.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _inv.workshop_id and app_user_id = _actor;

  if not can_grant(_actor_role, null, _inv.role) then
    perform raise_refusal('tl02.not_an_administrator',
      'Only this workshop''s administrators can re-issue an invitation.');
  end if;

  update workshop_invitation set invited_at = now() where id = _id;
end $$;

revoke all on function invite_to_workshop(uuid, text, text) from public, anon;
revoke all on function revoke_invitation(uuid)              from public, anon;
revoke all on function resend_invitation(uuid)              from public, anon;
grant execute on function invite_to_workshop(uuid, text, text) to authenticated;
grant execute on function revoke_invitation(uuid)              to authenticated;
grant execute on function resend_invitation(uuid)              to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Acceptance, on first sign-in.
--
--    Three changes to tl-01's version, and the third is the one to read twice.
--
--      * An email with a pending invitation may create an account even with no
--        allowlist row. That is the whole point: an administrator can now let
--        somebody in without an operator editing a migration.
--      * Every pending invitation for that email becomes a membership, so a person
--        invited to two workshops before signing up arrives holding both.
--      * Invitations are applied BEFORE tl-01's `default_workshop_id` bridge, and
--        the bridge inserts `on conflict do nothing`. The order is load-bearing:
--        the bridge is a blunt instrument that puts every new signup into one
--        workshop with the allowlist's role, and an explicit invitation to that
--        same workshop must win over it. Reversed, an evaluator invited as a
--        consultant would silently arrive as an evaluator.
--
--    The bridge is KEPT rather than retired, because four of the six seeded
--    allowlist addresses have still never signed in; retiring it today would strand
--    exactly the people it was written for. It is dead the moment those accounts
--    exist, and removing it is a one-line change for whoever notices.
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
  _norm      text := lower(new.email);
  _invited   boolean;
  _inv       record;
begin
  select allowed_roles, assigned_role, coalesce(platform_owner, false), default_workshop_id
    into _allowed, _assigned, _owner, _workshop
    from role_allowlist
    where lower(email) = _norm;

  select exists (
    select 1 from workshop_invitation where lower(email) = _norm and status = 'pending'
  ) into _invited;

  -- Still invite-only. Two ways in now: the operator's allowlist, or an
  -- administrator's invitation. Raising rolls back the auth.users insert, so a
  -- refused signup leaves no orphan account behind.
  if _allowed is null and not _invited then
    raise exception 'Email % has not been invited to a workshop. Ask the workshop administrator to invite you, then sign up with the same address.', new.email
      using errcode = 'insufficient_privilege';
  end if;

  _name := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), new.email);

  -- A workshop role can only come from the allowlist's own list, and only for the
  -- bridge below. An invitation carries its own role and never consults this.
  _requested := new.raw_user_meta_data->>'role';
  if _allowed is not null and _requested is not null and _requested = any(_allowed) then
    _role := _requested;
  else
    _role := _assigned;
  end if;

  insert into public.app_user (auth_user_id, email, name, role)
  values (new.id, new.email, _name, case when coalesce(_owner, false) then 'platform_owner' else 'member' end)
  on conflict (email) do update set
    auth_user_id = excluded.auth_user_id,
    name         = excluded.name,
    role         = excluded.role
  returning id into _app_user;

  -- Invitations first; see the note above on why the order decides the role.
  for _inv in
    select id, workshop_id, role, invited_by
      from workshop_invitation
     where lower(email) = _norm and status = 'pending'
     order by invited_at
  loop
    insert into public.workshop_member (workshop_id, app_user_id, role, added_by)
    values (_inv.workshop_id, _app_user, _inv.role, _inv.invited_by)
    on conflict (workshop_id, app_user_id) do nothing;

    update workshop_invitation
       set status = 'accepted', accepted_at = now(), accepted_app_user_id = _app_user
     where id = _inv.id;

    perform log_membership_change(_inv.workshop_id, _inv.invited_by, _app_user, null, _inv.role, 'grant');
  end loop;

  -- tl-01's bridge, unchanged and now second in line.
  if _workshop is not null and _role is not null then
    insert into public.workshop_member (workshop_id, app_user_id, role)
    values (_workshop, _app_user, _role)
    on conflict (workshop_id, app_user_id) do nothing;
  end if;

  return new;
end;
$$;
