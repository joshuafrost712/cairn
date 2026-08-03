-- Throughline — tl-02: chief admin, transfer, and the promotion matrix.
--
-- tl-01 made membership per-workshop but gave it no write path at all: no policy,
-- not even a grant. That was deliberate, and this is the migration that opens the
-- door — through three security-definer RPCs and nothing else. A browser still
-- cannot touch `workshop_member` directly.
--
-- The asymmetry these RPCs enforce is Joshua's, stated precisely:
--
--   "needs to have a chief admin position that can be transferred. chief admin
--    can promote others to being admin AND remove them from being an admin.
--    other admins can only promote others to being an evaluator."
--
-- So delegating administration never delegates control of the workshop. An admin
-- can staff a workshop with evaluators and can do nothing to another admin, to the
-- chief admin, or to their own rank.
--
-- Apply after 20260731000200_goals_and_workshop_scoped_ksas.sql (tl-08).
--
-- Behaviour changes worth knowing before applying:
--   * Exactly one chief_admin per workshop is now a database invariant, enforced
--     by a partial unique index rather than by convention. Applying this migration
--     will FAIL if any existing workshop holds two, which is the correct outcome:
--     that state needs a human decision, not a silent pick.
--   * `workshop_update`'s WITH CHECK admits a platform owner. This is what makes a
--     workshop created in the app reach the backend at all (see section 6), and it
--     is deliberately WITH CHECK only, so the cross-workshop edit power it would
--     otherwise hand out does not exist.

-- ---------------------------------------------------------------------------
-- 1. The invariant: exactly one chief admin per workshop.
--
--    Structural, not procedural. Each RPC below also refuses to empty the slot,
--    but a check inside a function is a race away from being wrong, and two chief
--    admins is precisely the state from which the promotion matrix stops meaning
--    anything.
-- ---------------------------------------------------------------------------

create unique index if not exists workshop_member_one_chief_admin
  on workshop_member (workshop_id)
  where role = 'chief_admin';

-- ---------------------------------------------------------------------------
-- 2. The matrix, written down once.
--
--    | Actor          | May grant                             | May revoke     | May not                                        |
--    |----------------|---------------------------------------|----------------|------------------------------------------------|
--    | platform_owner | nothing inside a workshop             | nothing        | act as an admin of a workshop it has no        |
--    |  (no member-   |                                       |                | membership in, EXCEPT transfer_chief_admin,    |
--    |   ship)        |                                       |                | the recovery path in section 5                 |
--    | chief_admin    | admin, chief_evaluator, consultant,   | the same set   | grant chief_admin (that is transfer, a         |
--    |                | evaluator, participant                |                | separate operation), or leave the slot empty   |
--    | admin          | evaluator only                        | evaluator only | grant or revoke admin, chief_admin,            |
--    |                |                                       |                | chief_evaluator or consultant; remove the      |
--    |                |                                       |                | chief admin; act on another admin at all       |
--    | everyone else  | nothing                               | nothing        | change any membership                          |
--
--    `_requested_role` null means removal, so one function answers both questions
--    and there is no second copy of the matrix to drift. The TypeScript twin is
--    src/lib/permissions.ts, imported by the client to disable buttons; this one
--    is the enforcement. Both are tested against the same cells.
--
--    Two readings of the feedback that the table above does not spell out, made
--    explicit here because an implementation has to choose:
--
--      * An admin may act only on somebody who currently holds NO membership or
--        holds `evaluator`. "May grant evaluator only" would otherwise permit an
--        admin to convert a participant into an evaluator, which is a privilege
--        change on a person they were never given authority over.
--      * A chief admin acting on the current chief_admin is always refused. That
--        single rule covers self-demotion, self-removal, and the emptied slot.
-- ---------------------------------------------------------------------------

create or replace function can_grant(
  _actor_role          text,
  _target_current_role text,
  _requested_role      text
)
returns boolean
language sql immutable
as $$
  select case
    -- Nobody reaches chief_admin through a grant. Transfer is its own operation
    -- because it is atomic on two rows, not one.
    when _requested_role = 'chief_admin' then false
    -- The chief admin's own row is untouchable by any grant or revoke, including
    -- their own. Transfer is the intended exit.
    when _target_current_role = 'chief_admin' then false
    when _actor_role = 'chief_admin' then
      _requested_role is null
      or _requested_role in ('admin','chief_evaluator','consultant','evaluator','participant')
    when _actor_role = 'admin' then
      (_target_current_role is null or _target_current_role = 'evaluator')
      and (_requested_role is null or _requested_role = 'evaluator')
    else false
  end
$$;

comment on function can_grant(text, text, text) is
  'tl-02 promotion matrix. Null _requested_role means removal. Mirrored in src/lib/permissions.ts.';

-- ---------------------------------------------------------------------------
-- 3. The audit log.
--
--    Append-only by the absence of update and delete policies, and insertable
--    only from inside the RPCs, which run as the definer. Same shape as tl-07's
--    setup_change_log and for the same reason: the first thing anybody asks when
--    a role looks wrong is who changed it.
-- ---------------------------------------------------------------------------

create table if not exists membership_change_log (
  id                   uuid primary key default gen_random_uuid(),
  workshop_id          uuid not null references workshop(id) on delete cascade,
  actor_app_user_id    uuid references app_user(id) on delete set null,
  actor_email          text,
  target_app_user_id   uuid references app_user(id) on delete set null,
  target_email         text,
  from_role            text,
  to_role              text,
  operation            text not null
    check (operation in ('grant','revoke','transfer','recover')),
  at                   timestamptz not null default now()
);

create index if not exists membership_change_log_workshop_idx
  on membership_change_log (workshop_id, at desc);

alter table membership_change_log enable row level security;

-- Readable by the people who can act on memberships, writable by nobody: the
-- RPCs are security definer and bypass both the grant and the policy.
revoke all on public.membership_change_log from anon, authenticated;
grant select on public.membership_change_log to authenticated;

drop policy if exists membership_change_log_select on membership_change_log;
create policy membership_change_log_select on membership_change_log
  for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin']));

-- The email columns are denormalized on purpose. `app_user_id` is `on delete set
-- null`, so the account-deletion case the recovery path exists for would erase
-- the very row that explains it.
create or replace function log_membership_change(
  _workshop_id uuid,
  _actor       uuid,
  _target      uuid,
  _from_role   text,
  _to_role     text,
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
    _actor,  (select lower(email) from app_user where id = _actor),
    _target, (select lower(email) from app_user where id = _target),
    _from_role, _to_role, _operation
  );
end $$;

revoke all on function log_membership_change(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Refusals, in one place.
--
--    Every refusal raises 42501 — the same SQLSTATE RLS itself returns, so the
--    client's existing isAuthorizationRefusal() classifier (src/db/referenceWrite.ts)
--    recognizes these without being taught a second code. The MESSAGE is readable
--    enough to surface verbatim; DETAIL carries a stable slug so tl-11 can map it
--    to a chrome.json string instead of rendering server prose in the UI forever.
-- ---------------------------------------------------------------------------

create or replace function raise_refusal(_slug text, _message text)
returns void
language plpgsql immutable
as $$
begin
  raise exception '%', _message using errcode = 'insufficient_privilege', detail = _slug;
end $$;

revoke all on function raise_refusal(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The three operations.
--
--    Each resolves the caller from auth.uid() and never from an argument, so
--    passing somebody else's user id as the actor is not a thing the API allows
--    you to attempt. Each pins search_path, because a security-definer function
--    that does not is a privilege-escalation primitive.
-- ---------------------------------------------------------------------------

create or replace function set_workshop_member_role(
  _workshop_id uuid,
  _target_app_user_id uuid,
  _role text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor       uuid := current_app_user_id();
  _actor_role  text;
  _target_role text;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _actor;
  select role into _target_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _target_app_user_id;

  if not exists (select 1 from app_user where id = _target_app_user_id) then
    perform raise_refusal('tl02.unknown_target', 'That person does not have an account yet.');
  end if;

  -- Self-action. A chief admin's exit is transfer_chief_admin; an admin who wants
  -- to leave calls remove_workshop_member on themselves. Neither is a role change.
  if _target_app_user_id = _actor then
    perform raise_refusal('tl02.no_self_role_change', 'You cannot change your own role in a workshop.');
  end if;

  if not can_grant(_actor_role, _target_role, _role) then
    if _role = 'chief_admin' then
      perform raise_refusal('tl02.chief_admin_by_transfer_only',
        'The chief admin role is handed over by transfer, not granted.');
    elsif _target_role = 'chief_admin' then
      perform raise_refusal('tl02.cannot_change_chief_admin',
        'The chief admin''s role can only change by transferring it.');
    elsif _actor_role = 'admin' then
      perform raise_refusal('tl02.admin_may_only_grant_evaluator',
        'An admin can add and remove evaluators. Only the chief admin can change anyone else.');
    else
      perform raise_refusal('tl02.not_an_administrator',
        'Only this workshop''s administrators can change who belongs to it.');
    end if;
  end if;

  if _target_role is not distinct from _role then
    return;  -- already holds it; nothing changed, so nothing is logged
  end if;

  insert into workshop_member (workshop_id, app_user_id, role, added_by)
  values (_workshop_id, _target_app_user_id, _role, _actor)
  on conflict (workshop_id, app_user_id) do update set role = excluded.role;

  perform log_membership_change(_workshop_id, _actor, _target_app_user_id, _target_role, _role, 'grant');
end $$;

create or replace function remove_workshop_member(
  _workshop_id uuid,
  _target_app_user_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor       uuid := current_app_user_id();
  _actor_role  text;
  _target_role text;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _actor;
  select role into _target_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _target_app_user_id;

  if _target_role is null then
    perform raise_refusal('tl02.not_a_member', 'That person is not a member of this workshop.');
  end if;

  -- Leaving a workshop you were added to should not require anybody's permission,
  -- so self-removal is open to every role except the one that would strand the
  -- workshop. The chief admin's exit is transfer_chief_admin.
  if _target_app_user_id = _actor then
    if _actor_role = 'chief_admin' then
      perform raise_refusal('tl02.chief_admin_cannot_leave',
        'Transfer the chief admin role to someone else before leaving this workshop.');
    end if;
  elsif not can_grant(_actor_role, _target_role, null) then
    if _target_role = 'chief_admin' then
      perform raise_refusal('tl02.cannot_remove_chief_admin',
        'The chief admin cannot be removed. Transfer the role first.');
    elsif _actor_role = 'admin' then
      perform raise_refusal('tl02.admin_may_only_remove_evaluator',
        'An admin can remove evaluators. Only the chief admin can remove anyone else.');
    else
      perform raise_refusal('tl02.not_an_administrator',
        'Only this workshop''s administrators can change who belongs to it.');
    end if;
  end if;

  delete from workshop_member
   where workshop_id = _workshop_id and app_user_id = _target_app_user_id;

  perform log_membership_change(_workshop_id, _actor, _target_app_user_id, _target_role, null, 'revoke');
end $$;

create or replace function transfer_chief_admin(
  _workshop_id uuid,
  _to_app_user_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor        uuid := current_app_user_id();
  _actor_role   text;
  _target_role  text;
  _recovery     boolean := false;
  _current_chief uuid;
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;

  select role into _actor_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _actor;
  select app_user_id into _current_chief
    from workshop_member where workshop_id = _workshop_id and role = 'chief_admin';

  -- The recovery path, and the only cross-workshop power in the system: a platform
  -- owner may hand a workshop's chief admin role to one of its members even where
  -- they hold no membership themselves. It is what makes "the slot can never be
  -- emptied" safe rather than a way to lock a workshop permanently. It is logged
  -- as `recover` precisely because it is the exception.
  if _actor_role is distinct from 'chief_admin' then
    if is_platform_owner() then
      _recovery := true;
    else
      perform raise_refusal('tl02.only_chief_admin_transfers',
        'Only this workshop''s chief admin can hand the role to someone else.');
    end if;
  end if;

  select role into _target_role
    from workshop_member where workshop_id = _workshop_id and app_user_id = _to_app_user_id;

  -- A transfer cannot land on somebody who never accepted an invitation.
  if _target_role is null then
    perform raise_refusal('tl02.target_not_a_member',
      'Add that person to the workshop before making them its chief admin.');
  end if;

  if _target_role = 'chief_admin' then
    perform raise_refusal('tl02.already_chief_admin', 'That person is already the chief admin.');
  end if;

  -- Demote before promote, in one transaction: the partial unique index is checked
  -- per statement, so the other order trips it against the outgoing chief admin's
  -- own row.
  if _current_chief is not null then
    update workshop_member set role = 'admin'
     where workshop_id = _workshop_id and app_user_id = _current_chief;
  end if;

  update workshop_member set role = 'chief_admin'
   where workshop_id = _workshop_id and app_user_id = _to_app_user_id;

  if _current_chief is not null then
    perform log_membership_change(_workshop_id, _actor, _current_chief, 'chief_admin', 'admin',
                                  case when _recovery then 'recover' else 'transfer' end);
  end if;
  perform log_membership_change(_workshop_id, _actor, _to_app_user_id, _target_role, 'chief_admin',
                                case when _recovery then 'recover' else 'transfer' end);
end $$;

revoke all on function set_workshop_member_role(uuid, uuid, text) from public, anon;
revoke all on function remove_workshop_member(uuid, uuid)          from public, anon;
revoke all on function transfer_chief_admin(uuid, uuid)            from public, anon;
grant execute on function set_workshop_member_role(uuid, uuid, text) to authenticated;
grant execute on function remove_workshop_member(uuid, uuid)          to authenticated;
grant execute on function transfer_chief_admin(uuid, uuid)            to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The bug tl-08 found: a workshop created in the app never reached the backend.
--
--    tl-08 recorded the cause as `workshop_update`'s WITH CHECK, since PostgREST's
--    upsert is `insert ... on conflict do update`. That reading is wrong, and the
--    wrong fix would have been much wider than the right one. Measured here rather
--    than reasoned about:
--
--      plain insert                                  -> ok
--      insert ... returning id                       -> 42501
--      insert ... on conflict do nothing              -> 42501
--      insert ... on conflict do update               -> 42501
--      the same upsert, with workshop_SELECT widened  -> ok
--
--    `on conflict do nothing` and a bare `returning` fail too, so the conflict
--    clause is a red herring. The refusal is the SELECT policy applied to the row
--    being returned. `workshop_select` is `is_workshop_member(id)`, and the
--    creator's membership is written by the AFTER INSERT trigger
--    `seed_workshop_chief_admin` — in the same command, so a STABLE helper reading
--    the statement's snapshot cannot see it. The row is created, its owner is
--    seeded, and the owner still cannot see it to return it. PostgREST always asks
--    for the representation, so every create through the app hit this.
--
--    So the fix is one clause on the read policy, and it adds no write power at
--    all. Verified with the fix in place: a platform owner renaming a workshop
--    they hold no membership in is still filtered to zero rows, and upserting over
--    one still returns `42501 ... (USING expression)`. `workshop_update` is left
--    exactly as tl-01 wrote it.
--
--    What this does widen, said plainly rather than smuggled: a platform owner can
--    now READ every workshop ROW in the deployment — name, dates, location. Not
--    its people, participants, activities, evaluations or observations, each of
--    which is scoped by its own `is_workshop_member` policy. That is coherent with
--    the tier: creating workshops is already one of the platform owner's three
--    powers, and a create you cannot read back is not a power.
--
--    tl-17's create flow depends on this. scripts/tl08-goals.mjs asserts the bug
--    in the direction that was true before today, so that line is now expected to
--    fail and to be read: tl-08's branch flips it when it merges.
-- ---------------------------------------------------------------------------

drop policy if exists workshop_select on workshop;
create policy workshop_select on workshop for select to authenticated
  using (is_workshop_member(id) or is_platform_owner());