-- Cairn — OBT Participant Evaluation
-- Foundation schema (build-brief steps 1-2).
--
-- Apply this in the Supabase SQL editor (Dashboard > SQL) or via the Supabase CLI.
-- Model follows "Workshop Participant Evaluation and CBC Integration - Internal":
-- qualitative evidence is primary; the 0-3 rating is derived and maps to CBC sub-points.
--
-- RLS note: policies below are intentionally permissive for the low-sensitivity pilot
-- (evaluations are only sensitive in aggregate reconstruction, which is not a realistic
-- threat here; sensitive deployments run over VPN). TIGHTEN before any wider rollout.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Core entities
-- ---------------------------------------------------------------------------

create table workshop (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_date  date,
  end_date    date,
  location    text,
  languages   text[] default '{}',          -- e.g. {English, Hindi}
  created_at  timestamptz not null default now()
);

create table team (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid not null references workshop(id) on delete cascade,
  name         text not null
);

create table participant (
  id                 uuid primary key default gen_random_uuid(),
  workshop_id        uuid not null references workshop(id) on delete cascade,
  name               text not null,
  registered_email   text,
  team_id            uuid references team(id) on delete set null,
  preferred_language text default 'English'
);

create table activity (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid not null references workshop(id) on delete cascade,
  title        text not null,
  day          date,
  start_time   timestamptz,
  end_time     timestamptz,
  sort_order   int not null default 0,
  genre_group  text                            -- optional grouping/genre label
);

-- KSA: one row per knowledge/skill/attitude statement.
-- area is one of the 5 standardized KSA areas.
create table ksa (
  id                      uuid primary key default gen_random_uuid(),
  code                    text unique not null,   -- e.g. ORAL-1
  area                    text not null,          -- one of the 5 KSA areas
  description             text not null,
  evaluator_facing_prompt text not null,          -- concise, expert-brevity, shown while recording
  ai_facing_rubric        text,                   -- fuller rubric, used later by the AI layer
  evidence_levels         jsonb,                  -- { "0": "...", "1": "...", "2": "...", "3": "..." }
  cbc_subpoint_refs       text[] default '{}'     -- CBC matrix sub-points this KSA maps to
);

-- Which KSAs (questions) belong to which activity.
create table activity_ksa (
  activity_id uuid not null references activity(id) on delete cascade,
  ksa_id      uuid not null references ksa(id) on delete cascade,
  sort_order  int not null default 0,
  primary key (activity_id, ksa_id)
);

-- Evaluators / consultants / admins. In the foundation slice the client persists a
-- local identity; this table is the durable record and the future Supabase Auth join.
create table app_user (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text unique not null,
  role        text not null default 'evaluator'  -- evaluator | consultant | admin
                check (role in ('evaluator','consultant','admin')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Evaluation: the raw session the evaluator produces (one free-form capture).
-- The queryable per-individual unit (observation) is derived from this by the
-- DEFERRED AI routing step.
-- ---------------------------------------------------------------------------

create table evaluation (
  id                uuid primary key default gen_random_uuid(),
  -- client-generated id so an offline-created row keeps a stable identity across sync
  client_id         text unique not null,
  evaluator_id      uuid references app_user(id) on delete set null,
  evaluator_email   text,                          -- denormalized for offline-created rows
  activity_id       uuid references activity(id) on delete set null,
  workshop_id       uuid references workshop(id) on delete set null,
  source_language   text default 'English',
  -- per-question capture, keyed by ksa_id -> evaluator's dictated/typed text
  answers           jsonb default '{}',
  -- readable free-form composed from answers at submit; what the AI routing step reads
  source_text       text not null default '',
  -- who the evaluator was watching for this capture (names and/or participant ids)
  participant_scope jsonb default '[]',
  attestation       boolean not null default false,
  ruleset_version   text,
  edit_history      jsonb default '[]',            -- [{ at, prevText }]
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Deferred (AI layer) fields: present so the schema is stable, unused this slice.
  english_text            text,
  original_ai_translation text,                    -- immutable snapshot, set once by the AI layer
  translation_status      text default 'not_needed'
                            check (translation_status in ('not_needed','unverified','verified')),
  verified_at             timestamptz,
  verified_by             uuid references app_user(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Deferred tables: created so the DB is complete; the foundation app does NOT
-- write to these. The AI routing + reporting + verification-gate phases will.
-- ---------------------------------------------------------------------------

create table observation (
  id                          uuid primary key default gen_random_uuid(),
  evaluation_id               uuid not null references evaluation(id) on delete cascade,
  participant_id              uuid references participant(id) on delete set null,
  ksa_id                      uuid references ksa(id) on delete set null,
  activity_id                 uuid references activity(id) on delete set null,
  text                        text,                -- English excerpt
  source_excerpt              text,
  sentiment_flag              text,                -- strong | weak | neutral
  evidence_designation        int check (evidence_designation between 0 and 3),
  ai_confidence               numeric,
  routing_status              text default 'auto'  -- auto | needs_review
                                check (routing_status in ('auto','needs_review')),
  reporting_locked_until_verified boolean not null default true,
  origin                      text default 'individual'  -- individual | group
                                check (origin in ('individual','group')),
  created_at                  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Maintain updated_at on evaluation.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger evaluation_set_updated_at
  before update on evaluation
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS (permissive pilot policies — TIGHTEN before wider rollout)
-- ---------------------------------------------------------------------------
alter table workshop     enable row level security;
alter table team         enable row level security;
alter table participant  enable row level security;
alter table activity     enable row level security;
alter table ksa          enable row level security;
alter table activity_ksa enable row level security;
alter table app_user     enable row level security;
alter table evaluation   enable row level security;
alter table observation  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'workshop','team','participant','activity','ksa',
    'activity_ksa','app_user','evaluation','observation'
  ] loop
    execute format(
      'create policy %I_all on %I for all using (true) with check (true);', t, t
    );
  end loop;
end $$;
