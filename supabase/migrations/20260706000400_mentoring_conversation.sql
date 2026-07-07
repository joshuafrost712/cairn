-- Cairn — Mentoring conversations subsystem.
-- One record per triggering observation (id = 'mc::<observation_uuid>').
-- A conversation is triggered when a verified/adjusted observation has
-- effective_designation 0 or 1. The id scheme makes upserts idempotent.
--
-- Apply after 0003_auth_and_roles.sql.
--
-- RLS note: permissive pilot policy (inheriting the pattern from 0001).
-- TIGHTEN before wider rollout.

create type mentoring_status as enum ('needed', 'scheduled', 'completed', 'dismissed');

create table mentoring_conversation (
  -- Stable dedup key: "mc::<trigger_observation_id>" matches the Dexie primary key.
  id                     text primary key,
  participant_id         uuid not null references participant(id) on delete cascade,
  participant_name       text not null,
  workshop_id            uuid references workshop(id) on delete set null,
  trigger_observation_id text,                    -- client-side observation id (not a FK; observations live locally)
  trigger_ksa_code       text,
  trigger_designation    int check (trigger_designation in (0, 1)),
  trigger_activity_id    uuid references activity(id) on delete set null,
  status                 mentoring_status not null default 'needed',
  scheduled_for          date,
  summary                text,
  participant_response   text,
  recorded_by            text,                    -- email of the evaluator/consultant who completed it
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Keep updated_at current on every write.
create trigger mentoring_conversation_set_updated_at
  before update on mentoring_conversation
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS (permissive pilot — TIGHTEN before wider rollout)
-- ---------------------------------------------------------------------------
alter table mentoring_conversation enable row level security;

create policy mentoring_conversation_all
  on mentoring_conversation
  for all
  using (true)
  with check (true);
