-- Honest Eval — tl-15: the brief pack's settings, stored per workshop.
--
-- Apply after 20260806000100_hosted_routing.sql (tl-23).
--
-- ONE COLUMN, FOR THE REASON tl-14 GAVE AND THIS SPEC INHERITS. `ai_config` is tl-13's
-- and is already one row per workshop, read on every provider call and edited on one
-- screen; the paths to an operator's course materials are edited on that same screen by
-- the same roles. A table of its own would need policies, an outbox order and a reason to
-- exist, and would make "this workshop's AI settings" two rows that could disagree about
-- which workshop they describe.
--
-- WHAT THIS FILE DOES NOT DO. It does not re-declare `ai_config`, and it touches no grant
-- and no policy. `if not exists` protects the SHAPE of an object and says nothing about
-- the permissions declared around it — tl-13 learned that at the cost of a live
-- regression on tl-11's `platform_setting` — so this is an `add column if not exists` and
-- nothing else. `ai_config`'s existing chief_admin/admin policies already govern the new
-- column, because a policy is on the table rather than on its columns.
--
-- WHAT THE VALIDATOR IS AND IS NOT CHECKING. It checks that the stored paths are strings
-- of a sane length and that there are not hundreds of them. It does NOT check that a path
-- exists, is absolute, or is well-formed for any operating system, because the filesystem
-- it describes belongs to whoever unzips the pack and this deployment cannot see it. A
-- green tick beside a path here would be a claim the app is in no position to make.

alter table ai_config
  add column if not exists brief jsonb not null default '{}'::jsonb;

comment on column ai_config.brief is
  'The brief pack''s settings (tl-15): local_files (text[] of course-material locations as the administrator typed them), local_files_note (what to take from them), pack_generated_at (when a pack was last built). The paths describe a filesystem this deployment cannot see and are instructions to the operator''s own agent, never data the app holds. Validated by ai_brief_is_legal().';

-- ---------------------------------------------------------------------------
-- What a legal brief block looks like.
--
-- The caps are mirrored from MAX_LOCAL_FILE_PATHS / MAX_LOCAL_FILE_PATH_CHARS /
-- MAX_LOCAL_FILES_NOTE_CHARS in src/lib/aiConfig.ts, and test/brief.test.ts reads this
-- file to keep the two equal — the pairing tl-13 used for AI_FUNCTION_DEFAULTS and tl-14
-- used for the assumption keys, and for the same reason: SQL cannot import TypeScript, so
-- the only thing that can hold two copies together is a test that fails when they drift.
--
-- The asymmetry those specs set is kept. An unknown key is REFUSED here and merely
-- ignored on the client, because a newer client writing a key this deployment does not
-- know is a real disagreement worth an error, while a newer server row read by an older
-- client must degrade rather than break the page.
-- ---------------------------------------------------------------------------

create or replace function ai_brief_is_legal(p_brief jsonb)
returns text
language plpgsql
immutable
as $$
declare
  _key text;
  _value jsonb;
  _path jsonb;
begin
  if p_brief is null then return null; end if;
  if jsonb_typeof(p_brief) <> 'object' then
    return 'tl15.brief_must_be_an_object';
  end if;

  for _key, _value in select * from jsonb_each(p_brief) loop
    if _key not in ('local_files', 'local_files_note', 'pack_generated_at') then
      return 'tl15.unknown_brief_key';
    end if;

    if _key = 'local_files' then
      if jsonb_typeof(_value) = 'null' then continue; end if;
      if jsonb_typeof(_value) <> 'array' then
        return 'tl15.local_files_must_be_an_array';
      end if;
      if jsonb_array_length(_value) > 20 then
        return 'tl15.too_many_local_files';
      end if;
      for _path in select * from jsonb_array_elements(_value) loop
        if jsonb_typeof(_path) <> 'string' then
          return 'tl15.local_file_must_be_a_string';
        end if;
        if length(_path #>> '{}') > 500 then
          return 'tl15.local_file_is_too_long';
        end if;
      end loop;
    end if;

    if _key = 'local_files_note' then
      if jsonb_typeof(_value) = 'null' then continue; end if;
      if jsonb_typeof(_value) <> 'string' then
        return 'tl15.note_must_be_a_string';
      end if;
      if length(_value #>> '{}') > 2000 then
        return 'tl15.note_is_too_long';
      end if;
    end if;

    if _key = 'pack_generated_at' then
      if jsonb_typeof(_value) = 'null' then continue; end if;
      if jsonb_typeof(_value) <> 'string' then
        return 'tl15.pack_generated_at_must_be_a_string';
      end if;
    end if;
  end loop;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Extend the trigger rather than adding a second one.
--
-- Re-declared in full, exactly as tl-14 did and for its reason: two triggers on one table
-- leave the order of two refusals undefined, so an administrator would get a different
-- message depending on which fired first. The three pre-existing invariants (a legal
-- function map, legal estimator assumptions, hosted-api only where the deployment permits
-- it) are reproduced unchanged, and `new.updated_at := now()` stays last.
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

  _problem := ai_brief_is_legal(new.brief);
  if _problem is not null then
    raise exception 'that is not a usable set of brief settings'
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

-- ---------------------------------------------------------------------------
-- The validators are called by the trigger under the definer's rights, so no client role
-- needs EXECUTE on any of them.
--
-- Revoked from the roles BY NAME, which is tl-23's scar: default privileges grant execute
-- to `anon` and `authenticated` EXPLICITLY on every new public function, so
-- `revoke ... from public` locks nothing at all. tl-14's two validators were left
-- executable by any signed-in session for the same reason `ai_call_permitted` was, and
-- they are swept up here rather than left as a smaller instance of a gap this wave has
-- now fixed three times. The exposure was nil — they take a jsonb and return a slug about
-- it, holding no data — but "harmless and inconsistent" is how the next one gets missed.
-- ---------------------------------------------------------------------------
revoke all on function ai_brief_is_legal(jsonb) from public, anon, authenticated;
revoke all on function ai_assumptions_are_legal(jsonb) from public, anon, authenticated;
revoke all on function ai_functions_are_legal(jsonb) from public, anon, authenticated;
