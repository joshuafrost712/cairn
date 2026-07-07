-- Cairn — overhaul of the evaluator capture experience.
-- Adds: a short scannable KSA heading, an optional per-KSA quick 0-3 read the
-- evaluator can tap during capture, and the single CIT chosen in focus mode.
-- Apply after 0001_foundation_schema.sql. Idempotent (add column if not exists).

-- Short heading for the capture card (e.g. "CLAT facilitation & drafting").
-- evaluator_facing_prompt stays the longer observation cue shown beneath it.
alter table ksa add column if not exists short_label text;

-- The evaluator's optional quick read, keyed by ksa_id -> 0..3. A prior the AI
-- routing reads, not a final score; the multi-evaluator gate still rules. Absent
-- keys mean "no read".
alter table evaluation add column if not exists quick_ratings jsonb default '{}';

-- When focus mode is on during capture, the single CIT the evaluator watched.
-- Null = multi-person capture (the default).
alter table evaluation
  add column if not exists focus_participant_id uuid references participant(id) on delete set null;
