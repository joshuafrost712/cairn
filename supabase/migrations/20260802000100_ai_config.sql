-- Honest Eval — tl-13: how a workshop does its AI work, and which functions use a
-- model at all.
--
-- Apply after 20260801000700_person_profiles.sql (tl-12).
--
-- Three tables and one function, and the function is the point of the migration.
--
--   * `ai_config` is the workshop's answer to "which provider, and for what".
--   * `platform_setting` is the DEPLOYMENT's answer to one question `ai_config`
--     cannot ask: whether hosted, metered AI may be spent here at all. Joshua's
--     deployment holds the Gemini key, so "any workshop admin may select
--     hosted-api" would mean "any workshop admin may spend Joshua's quota". The
--     mode ships built and is selectable only where a platform owner has turned
--     it on; per-workshop keys and per-workshop billing are tl-14's.
--   * `ai_call_log` is the trace. Every provider call, in every mode, including
--     the ones that end in "now go and do this yourself" — per
--     Agent-Engineering-Protocol §6, a failure that cannot be traced backward is
--     the failure that cannot be fixed.
--   * `ai_call_permitted()` is the authorization an Edge Function asks for. It
--     exists because of the bug this spec opens by closing: `draft-scenario`
--     shipped with `verify_jwt` on, the key correctly server-side, and NO check
--     that the caller may spend this workshop's tokens. verify_jwt answers "is
--     this a real account". It never answers "may this account do this here".
--     Three more functions (tl-14 through tl-16) are about to copy whatever shape
--     this one sets, so the check lives in SQL, once, rather than in each
--     function's TypeScript.
--
-- WHY THE FUNCTION TAKES AN AUTH USER ID RATHER THAN READING auth.uid(). An Edge
-- Function reaches Postgres with the service-role key, where auth.uid() is null,
-- so `has_workshop_role()` and its siblings answer false for everybody. The
-- function therefore resolves the caller explicitly from the id the function got
-- out of the caller's OWN JWT (via auth.getUser, i.e. verified by the auth
-- server, never a claim the client typed). That is also why execute is granted to
-- `service_role` alone: a parameter naming any user is safe only in a caller that
-- cannot be a browser.

-- ---------------------------------------------------------------------------
-- 1. Deployment-level switches.
--
--    Read by any signed-in user, because the client has to be able to say WHY a
--    mode is unselectable rather than showing a dead control. Written by a
--    platform owner only.
-- ---------------------------------------------------------------------------

create table if not exists platform_setting (
  key        text primary key,
  value      jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

comment on table platform_setting is
  'Deployment-wide switches (tl-13), as distinct from workshop_setting which is per workshop. Readable by any member so the UI can state why a control is unavailable; writable by a platform owner only.';

alter table platform_setting enable row level security;

drop policy if exists platform_setting_select on platform_setting;
create policy platform_setting_select on platform_setting for select to authenticated
  using (true);

drop policy if exists platform_setting_write on platform_setting;
create policy platform_setting_write on platform_setting for all to authenticated
  using (is_platform_owner())
  with check (is_platform_owner());

grant select on platform_setting to authenticated;
grant insert, update, delete on platform_setting to authenticated;

-- Off, deliberately, and this row is the one Joshua's deployment keeps. The mode
-- is built and tested; it is not selectable here until somebody who owns the bill
-- says so.
insert into platform_setting (key, value)
values ('hosted_ai_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What a legal function map looks like.
--
--    Mirrors AI_FUNCTIONS and the shape checks in src/lib/aiConfig.ts. That copy
--    decides whether Save is enabled; this one enforces. Same pairing tl-09 used
--    for the scale: SQL enforces, TypeScript offers.
--
--    An unknown key is REFUSED rather than ignored, which is the opposite of the
--    client's tolerant read. The asymmetry is deliberate: a newer client writing
--    a function this deployment does not know about is a real disagreement worth
--    an error, while a newer SERVER row read by an older client must degrade to
--    "off" rather than break the page it appears on.
-- ---------------------------------------------------------------------------

create or replace function ai_functions_are_legal(p_functions jsonb)
returns text
language plpgsql
immutable
as $$
declare
  _key text;
  _entry jsonb;
begin
  if p_functions is null then return null; end if;
  if jsonb_typeof(p_functions) <> 'object' then
    return 'tl13.functions_must_be_an_object';
  end if;
  for _key, _entry in select * from jsonb_each(p_functions) loop
    if _key not in (
      'observation_routing', 'scenario_draft', 'narrative_prose',
      'email_drafting', 'conversation_guidance'
    ) then
      return 'tl13.unknown_ai_function';
    end if;
    if jsonb_typeof(_entry) <> 'object' then
      return 'tl13.function_entry_must_be_an_object';
    end if;
    if _entry ? 'enabled' and jsonb_typeof(_entry->'enabled') <> 'boolean' then
      return 'tl13.function_enabled_must_be_a_boolean';
    end if;
    if _entry ? 'model'
       and jsonb_typeof(_entry->'model') not in ('string', 'null') then
      return 'tl13.function_model_must_be_a_string';
    end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The workshop's configuration.
--
--    ONE ROW PER WORKSHOP, not one row per function, and not a key/value pair in
--    workshop_setting. The mode and the toggles are read together on every
--    provider call and are edited together on one screen, and `workshop_setting`
--    is readable by every member of a workshop — which is exactly wrong here,
--    since tl-03's whole point is that an evaluator never learns the mechanism.
--
--    NO ROW IS A LEGAL STATE and means "behave as the app did before this spec":
--    github-claude, routing on, scenario draft-fill on. Seeding every existing
--    workshop would have been the same behaviour with more rows to keep true.
-- ---------------------------------------------------------------------------

create table if not exists ai_config (
  workshop_id uuid primary key references workshop(id) on delete cascade,
  mode        text not null default 'github-claude'
              check (mode in ('github-claude', 'byo-agent', 'hosted-api')),
  -- function name -> { enabled: bool, model: text|null }. Partial: an absent
  -- entry takes the built-in default rather than meaning "off".
  functions   jsonb not null default '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

comment on table ai_config is
  'Per-workshop AI provider mode and per-function toggles (tl-13). Admin-only in BOTH directions: an evaluator must never learn the mechanism (tl-03), and a toggle an evaluator could read is one they could reason about spending.';

comment on column ai_config.functions is
  'Partial map of AI function -> {enabled, model}. An absent function takes the default in src/lib/aiConfig.ts (observation routing and scenario draft-fill on, the three unbuilt ones off). Enforced by ai_functions_are_legal().';

-- ---------------------------------------------------------------------------
-- 4. The two invariants a policy cannot express.
--
--    A per-row RLS policy can decide WHO writes. It cannot decide whether the
--    deployment permits the mode being written, or whether the jsonb is
--    well-formed. Both are checked in a trigger so there is no path around them,
--    including the service-role paths the Edge Functions use.
-- ---------------------------------------------------------------------------

create or replace function ai_config_is_permitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _problem text;
  _hosted boolean;
begin
  _problem := ai_functions_are_legal(new.functions);
  if _problem is not null then
    raise exception 'that is not a usable AI configuration'
      using errcode = '23514', detail = _problem;
  end if;

  if new.mode = 'hosted-api' then
    -- `#>> '{}'` reads the jsonb as plain text whether it was stored as the
    -- boolean `true` or the string `"true"`, where a `::text::boolean` cast would
    -- succeed on the first and raise on the second.
    select coalesce((value #>> '{}')::boolean, false) into _hosted
    from platform_setting where key = 'hosted_ai_enabled';
    if not coalesce(_hosted, false) then
      raise exception 'hosted AI is not enabled on this deployment'
        using errcode = '23514', detail = 'tl13.hosted_ai_not_enabled_here';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_config_check on ai_config;
create trigger ai_config_check
  before insert or update on ai_config
  for each row execute function ai_config_is_permitted();

-- ---------------------------------------------------------------------------
-- 5. RLS: the administering roles, in both directions.
--
--    The same role set the UI gates on. tl-07 learned that the hard way in the
--    opposite direction (a page gated on ADMIN_ROLES over a table whose policy
--    named CHIEF_ROLES locked out a chief evaluator who could legitimately use
--    it), so the rule is worth restating: gate the UI on the same set the policy
--    names. Here it is `chief_admin, admin` in both places, because the mode
--    decides where a workshop's evidence is sent.
-- ---------------------------------------------------------------------------

alter table ai_config enable row level security;

drop policy if exists ai_config_select on ai_config;
create policy ai_config_select on ai_config for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists ai_config_insert on ai_config;
create policy ai_config_insert on ai_config for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists ai_config_update on ai_config;
create policy ai_config_update on ai_config for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']))
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

grant select, insert, update on ai_config to authenticated;
-- Deleting a configuration would silently restore the defaults, which is a
-- change of behaviour dressed as a tidy-up. Rows die with their workshop.
revoke delete on ai_config from authenticated;

-- ---------------------------------------------------------------------------
-- 6. The trace.
--
--    Insert is granted to the administering roles because the client records the
--    human-in-the-loop outcomes itself: in github-claude and byo-agent mode
--    there is no server call to trace, and "the operator was handed a prompt"
--    is precisely the outcome the protocol asks to see. Edge Functions write
--    with the service-role key and bypass RLS.
--
--    No update, no delete: a trace somebody can edit is not a trace.
-- ---------------------------------------------------------------------------

create table if not exists ai_call_log (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid not null references workshop(id) on delete cascade,
  fn           text not null,
  mode         text not null,
  model        text,
  actor_email  text,
  input_chars  integer,
  -- 'result' | 'operator_action' | 'refused' | 'error'
  outcome      text not null,
  detail       text,
  tokens_in    integer,
  tokens_out   integer,
  latency_ms   integer,
  at           timestamptz not null default now()
);

comment on table ai_call_log is
  'One row per AI provider call in any mode (tl-13), including the operator-action outcomes that are the normal state of the two human-in-the-loop modes. Append-only: no update or delete policy exists.';

create index if not exists ai_call_log_workshop_at_idx on ai_call_log (workshop_id, at desc);

alter table ai_call_log enable row level security;

drop policy if exists ai_call_log_select on ai_call_log;
create policy ai_call_log_select on ai_call_log for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists ai_call_log_insert on ai_call_log;
create policy ai_call_log_insert on ai_call_log for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

grant select, insert on ai_call_log to authenticated;
revoke update, delete on ai_call_log from authenticated;

-- ---------------------------------------------------------------------------
-- 7. The authorization an Edge Function asks for.
--
--    Returns null when the call may proceed, or a stable slug naming the refusal.
--    Two different refusals, deliberately: "you do not administer this workshop"
--    and "this workshop has that function switched off" are different facts, and
--    the acceptance test for this spec is that the server distinguishes them.
--
--    The defaults here MIRROR AI_FUNCTION_DEFAULTS in src/lib/aiConfig.ts. A
--    workshop with no ai_config row must behave exactly as the app did before
--    this migration, which for scenario draft-fill means enabled: it is a live
--    feature, and defaulting it off would have taken a working button away from
--    every workshop in the name of a switch nobody had asked for yet.
-- ---------------------------------------------------------------------------

create or replace function ai_call_permitted(
  _auth_user_id uuid,
  _workshop_id  uuid,
  _function     text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _is_admin boolean;
  _entry jsonb;
  _enabled boolean;
begin
  if _auth_user_id is null or _workshop_id is null then
    return 'tl13.caller_or_workshop_missing';
  end if;

  select exists (
    select 1
    from workshop_member wm
    join app_user u on u.id = wm.app_user_id
    where wm.workshop_id = _workshop_id
      and u.auth_user_id = _auth_user_id
      and wm.role = any (array['chief_admin', 'admin'])
  ) into _is_admin;

  if not _is_admin then
    return 'tl13.not_an_admin_of_this_workshop';
  end if;

  if _function not in (
    'observation_routing', 'scenario_draft', 'narrative_prose',
    'email_drafting', 'conversation_guidance'
  ) then
    return 'tl13.unknown_ai_function';
  end if;

  select functions -> _function into _entry
  from ai_config where workshop_id = _workshop_id;

  _enabled := coalesce(
    (_entry->>'enabled')::boolean,
    -- No row, or no entry for this function: the built-in default.
    _function in ('observation_routing', 'scenario_draft')
  );

  if not _enabled then
    return 'tl13.function_is_switched_off_for_this_workshop';
  end if;

  return null;
end $$;

comment on function ai_call_permitted(uuid, uuid, text) is
  'Whether a caller may spend this workshop''s AI budget on this function (tl-13). Null means yes; anything else is a slug naming the refusal. Called by Edge Functions with the service-role key, passing the auth user id they resolved from the caller''s own verified JWT — which is why it takes the id as a parameter instead of reading auth.uid(), and why execute is granted to service_role alone.';

revoke all on function ai_call_permitted(uuid, uuid, text) from public;
grant execute on function ai_call_permitted(uuid, uuid, text) to service_role;
