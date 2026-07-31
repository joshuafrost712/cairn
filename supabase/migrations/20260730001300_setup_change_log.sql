-- Honest Eval — tl-07: the setup audit log.
--
-- Setup is editable at any point in a workshop, including mid-workshop, and the
-- change-impact dialog states what each save will cost before it commits. This
-- table is the other half of that honesty: what was actually changed, by whom, at
-- what severity, and against a workshop in what state.
--
-- Without it the app can warn an administrator and then keep no record that the
-- warning was shown and accepted. Six weeks later, when a participant's report
-- reads oddly, the question is "did somebody edit the descriptors mid-workshop"
-- and the answer has to be reconstructible.
--
-- Apply after 20260730001200_verdict_and_observation_sync.sql.
--
-- Three decisions worth reading before changing anything here:
--
--   * APPEND-ONLY, BY THE ABSENCE OF POLICIES. There is no update policy and no
--     delete policy, so with RLS enabled neither is possible from any client, for
--     any role. A log the person it records can edit is not a log.
--   * INSERT IS RPC-ONLY, for the same reason tl-04 made a verdict a signature:
--     the actor must be the caller, not a value the caller supplies. `actor_email`
--     comes from current_app_user_email() inside the function, so a client cannot
--     attribute its own edit to somebody else.
--   * BEST-EFFORT AT THE CALL SITE. The client logs AFTER the change has
--     committed and ignores failure (src/setup/log.ts). A logging failure must
--     never roll back an edit the admin already confirmed — the alternative is a
--     workshop that cannot be edited because an audit insert is refused.

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------

create table if not exists setup_change_log (
  -- Client-generated, so an offline log row keeps one identity across the
  -- outbox and the eventual insert, and a replayed queue cannot double-log.
  id            text primary key,
  workshop_id   uuid not null references workshop(id) on delete cascade,
  actor_email   text not null,
  entity        text not null,
  entity_id     text,
  entity_label  text not null,
  operation     text not null check (operation in ('create', 'update', 'delete')),
  severity      text not null check (
                  severity in ('safe', 'affects_future', 'invalidates_evidence', 'destructive')
                ),
  workshop_state text not null check (workshop_state in ('draft', 'in_progress', 'closed')),
  -- The compact before/after the dialog was built from, and the counts it quoted.
  -- jsonb rather than columns because the shape differs per entity and the value of
  -- this row is "what did the admin see when they said yes".
  diff          jsonb not null default '{}'::jsonb,
  counts        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);

create index if not exists setup_change_log_workshop_at_idx
  on setup_change_log (workshop_id, at desc);

alter table setup_change_log enable row level security;

-- Read by the administrators of the workshop it belongs to. Not by every member:
-- the log names who changed what, which is management information rather than
-- something an evaluator needs while capturing.
drop policy if exists setup_change_log_select on setup_change_log;
create policy setup_change_log_select on setup_change_log for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

-- No insert policy on purpose: the RPC below is the only way in.
-- No update or delete policy on purpose: the log is append-only.

grant select on setup_change_log to authenticated;
revoke insert, update, delete on setup_change_log from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. The writer.
--
--    security definer so it can insert past the absent insert policy, with the
--    authorization check written out explicitly: an administrator of THIS
--    workshop, and nobody else. `on conflict do nothing` makes a replayed offline
--    queue idempotent rather than duplicating a row.
-- ---------------------------------------------------------------------------

create or replace function log_setup_change(
  _id             text,
  _workshop_id    uuid,
  _entity         text,
  _entity_id      text,
  _entity_label   text,
  _operation      text,
  _severity       text,
  _workshop_state text,
  _diff           jsonb default '{}'::jsonb,
  _counts         jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor text := current_app_user_email();
begin
  if _actor is null then
    raise exception 'no app_user for the calling session' using errcode = '42501';
  end if;
  if not has_workshop_role(_workshop_id, array['chief_admin', 'admin']) then
    raise exception 'not an administrator of this workshop' using errcode = '42501';
  end if;

  insert into setup_change_log (
    id, workshop_id, actor_email, entity, entity_id, entity_label,
    operation, severity, workshop_state, diff, counts
  ) values (
    _id, _workshop_id, _actor, _entity, _entity_id, _entity_label,
    _operation, _severity, _workshop_state, coalesce(_diff, '{}'::jsonb),
    coalesce(_counts, '{}'::jsonb)
  )
  on conflict (id) do nothing;

  return _id;
end $$;

revoke all on function log_setup_change(
  text, uuid, text, text, text, text, text, text, jsonb, jsonb
) from public, anon;
grant execute on function log_setup_change(
  text, uuid, text, text, text, text, text, text, jsonb, jsonb
) to authenticated;