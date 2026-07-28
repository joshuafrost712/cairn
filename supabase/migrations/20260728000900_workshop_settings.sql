-- Honest Eval — Wave 2, W2-1: settings belong to a workshop, not to a device.
--
-- `required_confirmations` has lived in localStorage since the verification gate
-- was built. That was tolerable while it was one person's own preference, and it
-- stops being tolerable the moment an administrator sets a number on somebody
-- else's behalf: the threshold changed on their laptop and on no other phone in
-- the room, while every device kept happily reporting reports as "ready" against
-- its own private idea of the rule.
--
-- Wave 2 adds per-evaluator review quotas, which have exactly the same shape and
-- worse consequences, so both move here.
--
-- Deliberately key/value rather than a wide row. These are a handful of operator
-- knobs that will grow one at a time, and a new knob should not be a migration.
--
-- Apply after 20260728000800_participant_profile.sql.

create table if not exists workshop_setting (
  workshop_id uuid not null references workshop(id) on delete cascade,
  key         text not null,
  -- jsonb, because the values are not one type: the thresholds are numbers and
  -- the quota overrides are an email -> n map.
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (workshop_id, key)
);

comment on table workshop_setting is
  'Per-workshop operator settings (verification threshold, review quotas). Client caches these in Dexie and mirrors required_confirmations into localStorage so the synchronous accessor in src/reports/verification.ts keeps working offline.';

alter table workshop_setting enable row level security;

-- Read by any member: an evaluator has to know the threshold their own work is
-- being judged against, and the quota they are carrying.
create policy workshop_setting_select on workshop_setting for select to authenticated
  using (is_workshop_member(workshop_id));

-- Written by the workshop's authors, the same set that may edit the roster and
-- the scenario. Stated three times rather than once because Postgres wants a
-- policy per verb, not because the rule differs between them.
create policy workshop_setting_insert on workshop_setting for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy workshop_setting_update on workshop_setting for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy workshop_setting_delete on workshop_setting for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

-- Seed the current default for every existing workshop, so a device that pulls
-- before anyone has touched Settings gets the value the app already behaves as
-- if it had, rather than an empty table it has to guess from.
insert into workshop_setting (workshop_id, key, value)
select w.id, 'required_confirmations', to_jsonb(2)
from workshop w
on conflict (workshop_id, key) do nothing;
