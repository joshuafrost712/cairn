-- Honest Eval — Wave 2, W2-2: who owes what.
--
-- The verification gate could already say "this report needs two confirmations".
-- Nothing in the data model could say whose job that was. This table is that
-- missing record, and it is the whole reason the kanban and the progress view
-- can exist.
--
-- Two kinds, one table:
--   review      — you own clearing this participant's report through the
--                 verification gate: casting verdicts on their observations.
--   observation — you own watching this participant and capturing on them.
-- Different jobs, overlapping people. A `kind` column beats two near-identical
-- tables, and it means transfer, quota and the board are written once.
--
-- Keyed on evaluator_email rather than app_user_id, matching every other
-- evaluator-shaped record here (observation.evaluator_email,
-- verification verdicts, coverage rows) and working in local-only mode, where
-- there is no app_user row to point at. The trade is deliberate: an assignment
-- can name somebody who has not signed up yet, which is what makes it possible
-- to plan a rota before the workshop starts.
--
-- Observation assignments are workshop-level, not per-event. "Viji watches Amos,
-- Ruth and Daniel for the whole workshop" is the real distribution problem for a
-- 26-person cohort, and a nullable activity_id in the primary key would not
-- dedupe: in Postgres, NULLs are distinct, so the same assignment could be
-- inserted any number of times.
--
-- Apply after 20260728000900_workshop_settings.sql.

create table if not exists report_assignment (
  workshop_id     uuid not null references workshop(id) on delete cascade,
  participant_id  uuid not null references participant(id) on delete cascade,
  evaluator_email text not null,
  kind            text not null check (kind in ('review','observation')),
  source          text not null default 'manual'
                    check (source in ('auto','manual','transfer')),
  added_by        text,
  added_at        timestamptz not null default now(),
  primary key (workshop_id, participant_id, evaluator_email, kind)
);

comment on column report_assignment.source is
  'How the row came to exist. Kept so an auto-assignment run can be audited after the fact, and so a hand-made exception is visibly not the algorithm''s doing.';

-- "what am I carrying" is the query an evaluator's own device runs; the primary
-- key already serves "who has this participant".
create index if not exists report_assignment_evaluator_idx
  on report_assignment (workshop_id, evaluator_email, kind);

alter table report_assignment enable row level security;

-- Read by any member. An evaluator must be able to see their own queue, and
-- seeing that a colleague also has this participant is the point of a shared
-- rota rather than a leak.
create policy report_assignment_select on report_assignment for select to authenticated
  using (is_workshop_member(workshop_id));

-- Written by the workshop's authors, the same set that edits the roster. An
-- evaluator cannot hand themselves work or hand their work to somebody else;
-- transfer is an administrator's act.
create policy report_assignment_insert on report_assignment for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy report_assignment_update on report_assignment for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy report_assignment_delete on report_assignment for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));
