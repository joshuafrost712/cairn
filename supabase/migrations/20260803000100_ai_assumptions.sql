-- Honest Eval — tl-14: the estimator's assumptions, stored per workshop.
--
-- Apply after 20260802000100_ai_config.sql (tl-13).
--
-- ONE COLUMN, AND DELIBERATELY NOT A TABLE. `ai_config` is tl-13's and is already
-- one row per workshop, read together on every provider call and edited on one
-- screen; the assumptions are edited on that same screen by the same roles. A second
-- table would have needed its own policies, its own outbox order, and its own reason
-- to exist, and it would have made "the workshop's AI settings" two rows that could
-- disagree about which workshop they describe.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND WHY THAT IS THE WHOLE CARE OF IT. It does not
-- re-declare `ai_config`. tl-13 learned this at the cost of a live regression: its
-- first draft re-declared tl-11's `platform_setting` with `create table if not
-- exists`, the CREATE was skipped on the live database and the GRANTs beside it were
-- not, which reopened a client write path tl-11 had deliberately closed. `if not
-- exists` protects the SHAPE of an object and says nothing about the permissions
-- declared around it. So this file uses `alter table ... add column if not exists`
-- and touches no grant and no policy: `ai_config`'s existing chief_admin/admin
-- policies in both directions already govern this column, because a policy is on the
-- table rather than on its columns.

alter table ai_config
  add column if not exists assumptions jsonb not null default '{}'::jsonb;

comment on column ai_config.assumptions is
  'Partial map of estimator assumption -> number (tl-14). Absent keys take the defaults in src/ai/estimate.ts DEFAULT_ASSUMPTIONS. Sparse by design: only what an administrator changed is stored, so a later change to a default reaches every workshop that never overrode it. Validated by ai_assumptions_are_legal().';

-- ---------------------------------------------------------------------------
-- What a legal assumptions map looks like.
--
-- Mirrors the shape checks in `resolveAssumptions` the way
-- `ai_functions_are_legal` mirrors `resolveAiConfig`: SQL enforces, TypeScript
-- offers. The asymmetry tl-13 set is kept — an unknown key is REFUSED here and
-- merely ignored on the client, because a newer client writing a key this deployment
-- does not know is a real disagreement worth an error, while a newer server row read
-- by an older client must degrade to the default rather than break the page.
--
-- The key list is mirrored from DEFAULT_ASSUMPTIONS in src/ai/estimate.ts, and
-- test/estimate.test.ts reads this migration to keep the two equal — the same pairing
-- tl-13 used for AI_FUNCTION_DEFAULTS, and for the same reason: SQL cannot import
-- TypeScript, so the only thing that can hold the copies together is a test that
-- fails when they drift. Adding an assumption means editing both.
-- ---------------------------------------------------------------------------

create or replace function ai_assumptions_are_legal(p_assumptions jsonb)
returns text
language plpgsql
immutable
as $$
declare
  _key text;
  _value jsonb;
begin
  if p_assumptions is null then return null; end if;
  if jsonb_typeof(p_assumptions) <> 'object' then
    return 'tl14.assumptions_must_be_an_object';
  end if;
  for _key, _value in select * from jsonb_each(p_assumptions) loop
    if _key not in (
      'captureChars', 'evaluatorsPerActivity', 'observationCoverage',
      'reportsPerParticipant', 'emailsPerParticipant', 'digestsPerEvent',
      'discrepancyNotes', 'observationsPerConversation', 'documentChars',
      'lowMultiplier', 'highMultiplier'
    ) then
      return 'tl14.unknown_assumption';
    end if;
    if jsonb_typeof(_value) <> 'number' then
      return 'tl14.assumption_must_be_a_number';
    end if;
    -- A negative assumption is not a smaller estimate, it is a nonsensical one: it
    -- would subtract tokens and could drive a total below zero, which would read as
    -- "this is cheaper than doing nothing".
    if (_value)::numeric < 0 then
      return 'tl14.assumption_must_not_be_negative';
    end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Extend tl-13's trigger rather than adding a second one.
--
-- Re-declared in full and unchanged apart from the new check, because two triggers
-- on one table would leave the order of two refusals undefined and give an
-- administrator a different error message depending on which fired first. The two
-- pre-existing invariants (a legal function map; hosted-api only where the deployment
-- permits it) are reproduced exactly; the `new.updated_at := now()` stamp stays last.
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

  _problem := ai_assumptions_are_legal(new.assumptions);
  if _problem is not null then
    raise exception 'that is not a usable set of estimator assumptions'
      using errcode = '23514', detail = _problem;
  end if;

  if new.mode = 'hosted-api' then
    -- `#>> '{}'` reads the jsonb as plain text whether it was stored as the boolean
    -- `true` or the string `"true"`, where a `::text::boolean` cast would succeed on
    -- the first and raise on the second.
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
