-- ---------------------------------------------------------------------------
-- tl-23: routing through a hosted key — the schema half.
--
-- Three changes and no re-declared objects. Per tl-13's scar (and the protocol
-- rule it earned): `platform_setting` is tl-11's table and `ai_call_log` is
-- tl-13's, so this file ALTERs and `create or replace`s and never `create table
-- if not exists`-es either of them — `if not exists` protects an object's shape
-- and says nothing about the permissions declared around it.
--
--   1. Two nullable integer columns on ai_call_log for the cache token fields.
--      They get their own columns rather than being folded into tokens_in
--      because they are billed at a different rate and the registry holds one
--      input price: a cost display that priced a cache read at full rate would
--      overstate the bill, which is the same class of error as understating it.
--      (tl-21's measurement was wrong by a factor of sixty because
--      usage.input_tokens excludes the cache read.)
--
--   2. ai_spend_permitted(): the money question, asked the same way tl-13's
--      ai_call_permitted() asks the permission question — null means yes,
--      anything else is a slug naming the refusal. It owns BOTH spend
--      preconditions: the deployment switch (hosted_ai_enabled) and the daily
--      token ceiling. The switch lives here and not only in the client because
--      this is the first path in the app where a bug spends money rather than
--      tokens, and a spend gate enforced only in aiConfig.ts's localStorage
--      mirror is a console away from being no gate at all.
--
--   3. ai_daily_token_ceiling joins set_platform_setting()'s key allowlist with
--      a numeric type check beside the existing boolean one, and is seeded at
--      2,000,000 tokens/day. At Sonnet 5's standard prices that bounds a runaway
--      day at roughly $6 (all input) to $30 (all output) — routing's real shape
--      is input-dominated, so call it ~$7. A judgment call, changeable without
--      a deploy: set_platform_setting('ai_daily_token_ceiling', to_jsonb(N)).
-- ---------------------------------------------------------------------------

alter table ai_call_log add column if not exists cache_read_tokens integer;
alter table ai_call_log add column if not exists cache_write_tokens integer;

comment on column ai_call_log.cache_read_tokens is
  'Prompt-cache read tokens (Anthropic usage.cache_read_input_tokens). Separate from tokens_in because they bill at ~0.1x the input rate; tokens_in holds only usage.input_tokens, which EXCLUDES this (tl-21 learned that at a factor of sixty).';
comment on column ai_call_log.cache_write_tokens is
  'Prompt-cache write tokens (Anthropic usage.cache_creation_input_tokens). Billed at a premium over the input rate; kept apart from tokens_in for the same reason as cache_read_tokens.';

-- ---------------------------------------------------------------------------
-- May money be spent on this deployment right now?
--
-- Counts every token column on hosted-api rows since midnight UTC. Client-side
-- hosted-api trace rows carry null token counts on the routing path (the Edge
-- Function is the only writer of the real numbers, so nothing is counted twice)
-- and nulls sum as zero here. The parameter names the workshop asking, so a
-- later per-workshop budget is a body change rather than a contract change;
-- today's ceiling is deliberately deployment-wide because the key and the bill
-- are the deployment's.
-- ---------------------------------------------------------------------------

create or replace function ai_spend_permitted(_workshop_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _enabled boolean;
  _ceiling numeric;
  _spent numeric;
begin
  if _workshop_id is null then
    return 'tl13.caller_or_workshop_missing';
  end if;

  select coalesce((value #>> '{}')::boolean, false) into _enabled
  from platform_setting where key = 'hosted_ai_enabled';
  if not coalesce(_enabled, false) then
    return 'tl23.hosted_ai_disabled_on_this_deployment';
  end if;

  select coalesce((value #>> '{}')::numeric, 2000000) into _ceiling
  from platform_setting where key = 'ai_daily_token_ceiling';
  _ceiling := coalesce(_ceiling, 2000000);

  select coalesce(sum(
    coalesce(tokens_in, 0) + coalesce(tokens_out, 0)
    + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
  ), 0) into _spent
  from ai_call_log
  where mode = 'hosted-api'
    and at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');

  -- Refuses AT the boundary: a day that has spent exactly the ceiling is done.
  if _spent >= _ceiling then
    return 'tl23.daily_token_ceiling_reached';
  end if;

  return null;
end $$;

comment on function ai_spend_permitted(uuid) is
  'Whether the deployment may spend metered AI tokens right now (tl-23). Null means yes; a slug names the refusal (hosted AI off, or the daily token ceiling reached). Sums all four token columns on today''s hosted-api ai_call_log rows against platform_setting.ai_daily_token_ceiling. Called by Edge Functions with the service-role key, alongside ai_call_permitted(); execute is granted to service_role alone for the same reason.';

revoke all on function ai_spend_permitted(uuid) from public;
grant execute on function ai_spend_permitted(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The ceiling as a deployment setting. Writes stay behind set_platform_setting()
-- (tl-11's writer, extended by tl-13 and now here): create or replace the
-- FUNCTION, never a re-declared table, and no grant changes anywhere.
-- ---------------------------------------------------------------------------

insert into platform_setting (key, value)
values ('ai_daily_token_ceiling', to_jsonb(2000000))
on conflict (key) do nothing;

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
  -- A deployment-wide setting is a platform power, not a workshop one. An admin of
  -- one workshop must not be able to widen a budget, or turn on a metered model,
  -- that every other workshop draws on.
  if not is_platform_owner() then
    perform raise_refusal('tl11.platform_owner_only',
      'Only this deployment''s owner can change a deployment-wide setting.');
  end if;
  if _key not in ('signup_budget_per_hour', 'hosted_ai_enabled', 'ai_daily_token_ceiling') then
    perform raise_refusal('tl11.unknown_setting', 'That is not a setting this deployment has.');
  end if;
  if _key = 'hosted_ai_enabled' and jsonb_typeof(_value) <> 'boolean' then
    perform raise_refusal('tl13.hosted_ai_needs_a_boolean',
      'Hosted AI is either on or off.');
  end if;
  if _key = 'ai_daily_token_ceiling'
     and (jsonb_typeof(_value) <> 'number' or (_value #>> '{}')::numeric <= 0) then
    perform raise_refusal('tl23.ceiling_needs_a_positive_number',
      'The daily AI token ceiling is a positive number of tokens.');
  end if;

  insert into platform_setting (key, value, updated_at, updated_by)
  values (_key, _value, now(), _actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
end $$;
