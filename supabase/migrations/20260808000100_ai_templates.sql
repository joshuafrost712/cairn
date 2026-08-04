-- Honest Eval — tl-16: the output template library.
--
-- Apply after 20260807000100_ai_brief.sql (tl-15). `20260805000100` remains tl-22's
-- held claim and is deliberately skipped rather than taken.
--
-- ONE TABLE, and unlike tl-14's and tl-15's additions it genuinely is a table rather
-- than a column on `ai_config`. Those two stored ONE value per workshop (an assumption
-- set, a brief block) edited on the same screen by the same roles, so a column was
-- right. This is a variable number of independently authored rows, each with its own
-- edit history in the proposal queue and its own revert, and squeezing thirty-odd
-- template bodies into a jsonb blob would make every save a read-modify-write of the
-- whole library — which is exactly how two administrators editing two different
-- templates would silently overwrite each other.
--
-- WHAT AN ABSENT ROW MEANS, AND WHY THERE IS NO `is_default` COLUMN. The spec's column
-- list had one. It is not here, and the reason generalizes: a row saying
-- `is_default = true` beside a body that differs from the shipped text is a state that
-- cannot be true, and a column that can lie is worse than one that does not exist. So
-- **absence is the default and presence is the override**, which makes "a workshop with
-- no rows produces byte-identical output to before this spec" true by construction
-- rather than by a code path that has to remember. Revert-to-default is a DELETE.
--
-- WHICH IS WHY DELETE IS GRANTED HERE AND REFUSED ON `ai_config`. tl-13 revoked delete
-- on its table because deleting a configuration would silently restore the defaults —
-- a change of behaviour dressed as a tidy-up. Here restoring the default IS the act an
-- administrator is asking for, it is offered by name in the editor, and it goes through
-- tl-07's dialog and log like every other Setup save. Same mechanism, opposite meaning,
-- and worth saying out loud so a later reader does not "fix" the inconsistency.

create table if not exists ai_template (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid not null references workshop(id) on delete cascade,
  kind         text not null
               check (kind in ('email', 'report', 'instructions_general', 'instructions_function')),
  -- The slot this body replaces, e.g. 'participant_email.intro'. Mirrored from
  -- TEMPLATE_KEYS in src/templates/defaults.ts by the list below.
  template_key text not null,
  body         text not null,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  -- One override per slot per workshop. This is what makes an upsert on
  -- (workshop_id, template_key) the whole write path, which is what
  -- src/db/referenceWrite.ts's TABLE_SPEC needs to build its onConflict string.
  unique (workshop_id, template_key)
);

comment on table ai_template is
  'Authored overrides for the wording the app produces (tl-16): email and report prose slots, and the instructions AI jobs follow. An ABSENT row means the shipped default in src/templates/defaults.ts; a present row is the workshop''s override. Deleting a row is revert-to-default. Schema definitions, validators and the capture attestation are NOT here and must never be: templates hold guidance, code holds the contract.';

alter table ai_template enable row level security;

-- REVOKE FIRST, this codebase's doctrine since tl-01: Supabase's default privileges
-- grant everything on a new public table to `anon` and `authenticated`, so a table
-- protected by RLS alone is one `disable row level security` away from wide open. An
-- attempt should fail at the GRANT, before any policy is consulted.
revoke all on ai_template from anon, authenticated;

-- READ BY ANY MEMBER, and this is a considered departure from `doc_draft`, the table it
-- otherwise most resembles. Wave 2 gave `doc_draft` chief-roles-only policies on all
-- four verbs because `workshop_member` includes the `participant` role and a draft's
-- body contains that participant's assessment, so a member-wide read would publish the
-- evaluations to the cohort. A template contains no evidence at all — it is the sentence
-- around the evidence — and it has to be readable by a non-admin device, because
-- `buildParticipantReportSegments` runs wherever a report is rendered. Withholding it
-- would not protect anything and would make an evaluator's report silently fall back to
-- shipped wording while an admin's showed the authored kind.
drop policy if exists ai_template_select on ai_template;
create policy ai_template_select on ai_template for select to authenticated
  using (is_workshop_member(workshop_id));

-- WRITTEN BY THE ROLES THE SETUP HUB IS GATED ON, not one set wider. Wave 2's scar:
-- `/admin/assignments` was gated on ADMIN_ROLES while `report_assignment`'s write policy
-- named CHIEF_ROLES, locking a chief evaluator out of a page they could legitimately
-- use. The fix is to make the two the same list rather than to guess which is right, so
-- these name ADMIN_ROLES (`admin`, `chief_admin`) exactly as `/admin/setup` is gated
-- since tl-07, and as `ai_config` is.
drop policy if exists ai_template_insert on ai_template;
create policy ai_template_insert on ai_template for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists ai_template_update on ai_template;
create policy ai_template_update on ai_template for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']))
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists ai_template_delete on ai_template;
create policy ai_template_delete on ai_template for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

grant select, insert, update, delete on ai_template to authenticated;

create index if not exists ai_template_workshop_idx on ai_template (workshop_id);

-- ---------------------------------------------------------------------------
-- What a legal row looks like.
--
-- WHAT THIS CHECKS AND WHAT IT DELIBERATELY DOES NOT. It refuses a `template_key` this
-- deployment does not know and a body that is empty or absurd — the two things a bad row
-- could do to somebody ELSE. It does not re-implement the token scanner or the per-slot
-- variable table in `src/templates/validate.ts`, and that is a stated limit rather than
-- an oversight: those rules catch an administrator's TYPO in their own workshop's
-- wording, not an attacker, and mirroring a regex plus a thirty-row spec table into
-- plpgsql would create a second copy of the interesting logic to keep in step for no
-- gain in what anybody could do.
--
-- The asymmetry tl-13 set and tl-15 kept is kept again: an unknown key is REFUSED here
-- and merely IGNORED on the client (`bodyFor` falls back to the shipped default), because
-- a newer client writing a key this deployment does not know is a real disagreement
-- worth an error, while a newer server row read by an older client must degrade rather
-- than break the page.
--
-- The key list and the length cap are mirrored from TEMPLATE_KEYS and
-- MAX_TEMPLATE_BODY_CHARS, and test/templates.test.ts READS THIS FILE to keep the two
-- equal. Adding a template means editing both. That is tl-13's `AI_FUNCTION_DEFAULTS`
-- pairing and tl-15's brief-caps pairing, for the reason both gave: SQL cannot import
-- TypeScript, so a failing test is the only thing that can hold two copies together.
-- ---------------------------------------------------------------------------

create or replace function ai_template_is_legal(p_key text, p_body text)
returns text
language plpgsql
immutable
as $$
begin
  if p_key is null or p_body is null then
    return 'tl16.key_and_body_are_required';
  end if;

  if p_key not in (
    'participant_email.greeting',
    'participant_email.intro',
    'participant_email.no-evidence',
    'participant_email.highlights-heading',
    'participant_email.growth-heading',
    'participant_email.claim',
    'participant_email.followup',
    'participant_email.gate',
    'participant_email.signoff',
    'event_digest.greeting',
    'event_digest.group-heading',
    'event_digest.no-observations',
    'event_digest.mean',
    'event_digest.no-pattern',
    'event_digest.pattern',
    'event_digest.conversations-heading',
    'event_digest.no-conversations',
    'event_digest.unrouted',
    'event_digest.signoff',
    'participant_report.title',
    'participant_report.intro',
    'participant_report.gate-ready',
    'participant_report.gate-locked',
    'participant_report.totals',
    'participant_report.evidence-heading',
    'participant_report.evidence-none',
    'participant_report.unevidenced-heading',
    'participant_report.unevidenced-list',
    'participant_report.flagged-heading',
    'participant_report.flagged-intro',
    'participant_report.cbc-heading',
    'participant_report.cbc-intro',
    'instructions.general',
    'instructions.observation_routing',
    'instructions.scenario_draft',
    'instructions.conversation_guidance'
  ) then
    return 'tl16.unknown_template_key';
  end if;

  if btrim(p_body) = '' then
    return 'tl16.body_is_empty';
  end if;

  if length(p_body) > 20000 then
    return 'tl16.body_is_too_long';
  end if;

  return null;
end $$;

-- One trigger, and it is this table's own: tl-14 and tl-15 each re-declared
-- `ai_config_is_permitted` in full rather than adding a second trigger, because two
-- triggers on one table leave the order of two refusals undefined. That reasoning is
-- about ONE table with several invariants. This is a different table, so it gets its own
-- and `ai_config_is_permitted` is not touched.
create or replace function ai_template_is_permitted()
returns trigger
language plpgsql
as $$
declare
  _problem text;
begin
  _problem := ai_template_is_legal(new.template_key, new.body);
  if _problem is not null then
    raise exception 'that is not a usable template'
      using errcode = '23514', detail = _problem;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_template_is_permitted_trg on ai_template;
create trigger ai_template_is_permitted_trg
  before insert or update on ai_template
  for each row execute function ai_template_is_permitted();

-- The validator is called by the trigger under the table owner's rights, so no client
-- role needs EXECUTE on it.
--
-- REVOKED FROM THE ROLES BY NAME, which is tl-23's scar and the wave's third
-- permissions-shaped one: default privileges grant execute to `anon` and `authenticated`
-- EXPLICITLY on every new public function, so `revoke ... from public` locks nothing at
-- all. Verify with `has_function_privilege`, never by reading this file.
revoke all on function ai_template_is_legal(text, text) from public, anon, authenticated;
revoke all on function ai_template_is_permitted() from public, anon, authenticated;
