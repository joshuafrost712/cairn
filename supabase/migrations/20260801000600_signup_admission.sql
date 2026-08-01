-- Throughline — tl-11 addendum: the sign-up admission queue.
--
-- Measured on the wire while building tl-11 (scripts/tl11-session-tests.mjs): a
-- successful sign-up sends a confirmation email, and this project's mailer is
-- Supabase's built-in one, capped at `rate_limit_email_sent = 2` per hour with no
-- custom SMTP configured. Invitations are unlimited; the sign-ups they produce are
-- not. A cohort invited on one evening would have had two people get in and the
-- rest meet `429 over_email_send_rate_limit` with no idea when to try again.
--
-- ---------------------------------------------------------------------------
-- What this can and cannot do, said before the code rather than after
-- ---------------------------------------------------------------------------
--
-- **It does not hold a message in a spool, because there is no message to hold.**
-- The email is sent by GoTrue when the INVITEE signs up, an action this app does
-- not trigger and cannot delay. So what is metered here is the instruction: each
-- pending invitation is given a window, the window is printed in the message the
-- administrator sends, and the app's own sign-up page refuses politely before it
-- opens. Nobody using the app spends a slot early, and nobody sees a rate-limit
-- error instead of a time.
--
-- Three honest limits, all of which the copy admits:
--
--   * The budget is spent by OTHER mail too — password resets share the same
--     `rate_limit_email_sent`. The scheduler cannot see those, so a busy hour can
--     still overrun. It reduces collisions; it does not guarantee their absence.
--   * The window is NOT enforced in `handle_new_user`. It could be, and the send
--     would then be genuinely impossible before the window — but a trigger refusal
--     reaches the browser as `unexpected_failure`, which `src/lib/signupErrors.ts`
--     reads as "you were never invited". Enforcing it there would trade a polite
--     wait for a wrong accusation. The gate is the app's own door.
--   * It is deployment-wide, not per workshop, because the cap is. Two workshops
--     onboarding the same evening draw on one budget and this schedules across
--     both.
--
-- **The budget is a setting, not a constant.** Configure custom SMTP and set it to
-- 100 and every window opens immediately: the layer stays and goes quiet, rather
-- than needing to be torn out.
--
-- Apply after 20260801000400_invitations.sql.

-- ---------------------------------------------------------------------------
-- 1. Deployment-level settings.
--
--    `workshop_settings` is the wrong home: this is a property of the project's
--    mailer, shared by every workshop in the deployment, and putting it there
--    would let two workshops hold two different truths about one cap.
-- ---------------------------------------------------------------------------

create table if not exists platform_setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

alter table platform_setting enable row level security;

-- Readable by any signed-in session: an administrator has to be able to see why
-- somebody is being asked to wait. Writable by nobody directly.
revoke all on public.platform_setting from anon, authenticated;
grant select on public.platform_setting to authenticated;

drop policy if exists platform_setting_select on platform_setting;
create policy platform_setting_select on platform_setting
  for select to authenticated using (true);

insert into platform_setting (key, value)
values ('signup_budget_per_hour', to_jsonb(2))
on conflict (key) do nothing;

comment on table platform_setting is
  'tl-11: deployment-wide settings. signup_budget_per_hour mirrors the project''s '
  'auth rate_limit_email_sent; raise both together when custom SMTP is configured.';

/**
 * How many accounts may be created in one hour.
 *
 * Clamped rather than trusted. A zero or negative budget would make
 * `next_signup_window` loop to its cap and hand everybody a date two weeks out,
 * which is a worse failure than an unmetered one; a value above 1000 is somebody
 * meaning "no limit" and is treated as such.
 */
create or replace function signup_budget_per_hour()
returns integer
language sql stable security definer set search_path = public
as $$
  select least(greatest(coalesce((select value::text::int from platform_setting
                                   where key = 'signup_budget_per_hour'), 2), 1), 1000)
$$;

grant execute on function signup_budget_per_hour() to authenticated;

create or replace function set_platform_setting(_key text, _value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _actor uuid := current_app_user_id();
begin
  if _actor is null then
    perform raise_refusal('tl02.no_account', 'You are not signed in to an account this deployment knows.');
  end if;
  -- The cap is a property of the deployment, so changing it is a platform power,
  -- not a workshop one. An admin of one workshop must not be able to widen a
  -- budget every other workshop draws on.
  if not is_platform_owner() then
    perform raise_refusal('tl11.platform_owner_only',
      'Only this deployment''s owner can change how many accounts may be created each hour.');
  end if;
  if _key <> 'signup_budget_per_hour' then
    perform raise_refusal('tl11.unknown_setting', 'That is not a setting this deployment has.');
  end if;

  insert into platform_setting (key, value, updated_at, updated_by)
  values (_key, _value, now(), _actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
end $$;

revoke all on function set_platform_setting(text, jsonb) from public, anon;
grant execute on function set_platform_setting(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Every invitation gets a window.
--
--    Existing rows are backdated to `invited_at`, so nothing already issued starts
--    waiting because this migration ran. That matters: the four invitations in
--    flight when this lands were sent with no time in them.
-- ---------------------------------------------------------------------------

alter table workshop_invitation
  add column if not exists opens_at timestamptz;

update workshop_invitation set opens_at = invited_at where opens_at is null;

alter table workshop_invitation alter column opens_at set default now();

create index if not exists workshop_invitation_opens_idx
  on workshop_invitation (opens_at)
  where status = 'pending';

/**
 * The first hour with room, counting the whole deployment.
 *
 * Two things are counted against an hour, and both are needed. **Scheduled**:
 * pending invitations whose window falls in it, which is what stops six invitations
 * issued in one minute from all opening at once. **Spent**: invitations actually
 * accepted during it, which is what stops the current hour being offered as empty
 * when two people have already signed up in it. The second term is zero for every
 * future hour and is the whole reason this is not simply arithmetic on a count.
 *
 * The loop is capped at two weeks. A budget that cannot be met inside that is a
 * misconfiguration, and handing back a date rather than spinning is the behaviour
 * that gets noticed and fixed.
 */
create or replace function next_signup_window()
returns timestamptz
language plpgsql stable security definer set search_path = public
as $$
declare
  _budget int := signup_budget_per_hour();
  _hour   timestamptz := date_trunc('hour', now());
  _used   int;
  _steps  int := 0;
begin
  loop
    select
      (select count(*) from workshop_invitation
        where status = 'pending' and opens_at >= _hour and opens_at < _hour + interval '1 hour')
      +
      (select count(*) from workshop_invitation
        where accepted_at >= _hour and accepted_at < _hour + interval '1 hour')
      into _used;

    if _used < _budget then
      -- Never a time in the past: the current hour opens now, not on the hour.
      return greatest(_hour, now());
    end if;

    _hour := _hour + interval '1 hour';
    _steps := _steps + 1;
    exit when _steps > 336;  -- two weeks
  end loop;
  return _hour;
end $$;

grant execute on function next_signup_window() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Inviting takes the next window.
--
--    Only the pending path. An address that already has an account is added
--    outright and creates no sign-up, so it consumes no budget and waits for
--    nothing.
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
  _opens       timestamptz;
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

  _opens := case when _target is null then next_signup_window() else now() end;

  insert into workshop_invitation (
    workshop_id, email, role, invited_by, invited_by_email,
    status, accepted_at, accepted_app_user_id, opens_at
  )
  values (
    _workshop_id, _norm, _role, _actor,
    (select lower(email) from app_user where id = _actor),
    case when _target is null then 'pending' else 'accepted' end,
    case when _target is null then null else now() end,
    _target,
    _opens
  )
  returning id into _id;

  if _target is null then
    perform log_invitation_change(_workshop_id, _actor, _norm, _role, 'invite');
    return jsonb_build_object('outcome', 'invited', 'invitation_id', _id, 'opens_at', _opens);
  end if;

  insert into workshop_member (workshop_id, app_user_id, role, added_by)
  values (_workshop_id, _target, _role, _actor)
  on conflict (workshop_id, app_user_id) do update set role = excluded.role;

  perform log_membership_change(_workshop_id, _actor, _target, null, _role, 'grant');
  return jsonb_build_object('outcome', 'added', 'invitation_id', _id, 'opens_at', _opens);
end $$;

/**
 * Re-dating an invitation re-books its window.
 *
 * "Re-date" meant only "stamp it today" before the queue existed. Now the date and
 * the window are the same fact, and leaving the window behind would hand somebody a
 * freshly-dated message telling them to come back at a time that has passed.
 */
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

  -- Clear the old window BEFORE asking for a new one, or this invitation counts
  -- itself as occupying the hour it is trying to leave.
  update workshop_invitation set opens_at = null where id = _id;
  update workshop_invitation
     set invited_at = now(), opens_at = next_signup_window()
   where id = _id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. "May I sign up yet?", asked by somebody who is not signed in.
--
--    Deliberately answers `open` for an address it is holding nothing for, rather
--    than `unknown`. That is not politeness — it is the difference between a
--    stranger learning "this address has an invitation waiting" and learning
--    nothing at all. The only thing this function will ever confirm is that an
--    address it IS holding has a window in the future, which is the minimum needed
--    to say "come back at two o'clock" instead of showing a database error.
--
--    It never returns a name, a workshop, a role, or whether an address is invited
--    at all once its window has opened.
-- ---------------------------------------------------------------------------

create or replace function invitation_window(_email text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select case
              when opens_at is null or opens_at <= now() then jsonb_build_object('status', 'open')
              else jsonb_build_object('status', 'waiting', 'opens_at', opens_at)
            end
       from workshop_invitation
      where lower(email) = lower(trim(coalesce(_email, '')))
        and status = 'pending'
      order by opens_at
      limit 1),
    jsonb_build_object('status', 'open'))
$$;

revoke all on function invitation_window(text) from public;
grant execute on function invitation_window(text) to anon, authenticated;
