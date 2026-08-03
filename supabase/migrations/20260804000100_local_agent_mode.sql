-- ---------------------------------------------------------------------------
-- tl-21: a fourth AI provider mode — the workshop's own machine.
--
-- ONE WIDENED CHECK CONSTRAINT AND NOTHING ELSE. No grant, no revoke, no policy,
-- no `create table`, and `ai_config_is_permitted()` is deliberately NOT
-- re-declared: nothing in it has to change, and re-declaring a function or table
-- another migration created is how a permission gets reopened by accident. tl-13
-- learned that on the live database when it re-declared tl-11's
-- `platform_setting` with `create table if not exists` — the CREATE was skipped
-- and the GRANT beside it was not, opening a client write path tl-11 had closed.
-- `if not exists` protects an object's SHAPE and says nothing about the
-- permissions declared around it.
--
-- The constraint's live name was read off the deployed database rather than
-- guessed (`ai_config_mode_check`, definition
-- `CHECK ((mode = ANY (ARRAY['github-claude'::text, 'byo-agent'::text,
-- 'hosted-api'::text])))`), so this is a drop-and-add of that exact name.
--
-- WHY THIS IS THE WHOLE SCHEMA COST OF THE SPEC. The relay's address and token
-- are device-local, in localStorage, following the routing PAT's precedent: an
-- address is a property of a machine on a network, not of a workshop, and putting
-- it in `ai_config` would sync one laptop's 127.0.0.1 to every other device in
-- the workshop. The relay itself is the durable record of an in-flight job, so the
-- app has nothing new to persist and no Dexie version and no reference-outbox
-- order are spent. Dexie v19 and outbox order 13 remain tl-15's.
--
-- NO ROW IS STILL A LEGAL STATE, meaning "behave as before tl-13", and no existing
-- workshop is touched by this file. Widening a check constraint cannot invalidate
-- a row that already satisfies the narrower one.
-- ---------------------------------------------------------------------------

alter table ai_config drop constraint if exists ai_config_mode_check;

alter table ai_config
  add constraint ai_config_mode_check
  check (mode in ('github-claude', 'local-agent', 'byo-agent', 'hosted-api'));

comment on column ai_config.mode is
  'How this workshop''s AI work is done. github-claude (default): files through a private repo, routed by a person in a Claude Max session. local-agent (tl-21): a machine at the workshop runs it unattended through a locally installed CLI on its own subscription; no key, no network. byo-agent: the operator carries a brief to their own tool. hosted-api: a server-side Edge Function holding a key, off on this deployment via platform_setting.hosted_ai_enabled. Kept in step with AI_MODES in src/lib/aiConfig.ts.';
