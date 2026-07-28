-- Honest Eval — participant profile fields.
--
-- Three facts the roster wanted and did not have: who a participant serves with,
-- how long they have been doing this work, and enough to read a team's composition
-- at a glance. All three are OPTIONAL, and the app treats absent and null as the
-- same answer, because a roster is normally entered incomplete and then filled in.
--
-- No RLS work: the existing `participant` policies from 20260728000700 select and
-- write the row, not a column list, so new columns inherit them unchanged. Nothing
-- in the client indexes these, so there is no Dexie schema version to bump either.
--
-- Apply after 20260728000700_workshop_membership.sql.

alter table participant add column if not exists sex text;
alter table participant add column if not exists organization text;
alter table participant add column if not exists years_of_service int;

-- Two values, and nullable. The check is deliberately narrow because the only
-- consumer is the male/female composition read on a music team, where a third
-- category would not be a finer answer, it would be an unanswerable one. Blank
-- stays available and is shown as "unspecified" rather than being folded into
-- either count.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'participant_sex_check'
  ) then
    alter table participant
      add constraint participant_sex_check check (sex in ('male', 'female'));
  end if;
end $$;

-- Years of service is a count of years, not a date. Guard the obvious nonsense
-- (a negative, or a number that would mean the person started before writing).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'participant_years_of_service_check'
  ) then
    alter table participant
      add constraint participant_years_of_service_check
      check (years_of_service is null or (years_of_service >= 0 and years_of_service <= 80));
  end if;
end $$;
