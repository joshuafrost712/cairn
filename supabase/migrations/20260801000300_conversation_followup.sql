-- tl-06: an evaluator who has held the conversation can say it is not finished.
--
-- Two columns and no policy change, which is the whole point worth reading here.
--
-- WHY NO POLICY AND NO TRIGGER EDIT.
--   tl-05's `mentoring_conversation_guard` is a DENY-list: it names the columns an
--   assignee may not change (the assignment fields, the guidance, and the trigger
--   evidence) and lets everything else through. So a new column is assignee-writable
--   by silence, and these two are meant to be. That is correct here and is a trap
--   for the next spec, because the failure is quiet in the dangerous direction: a
--   future admin-owned column added without touching the trigger would be editable
--   by every assignee, and nothing would say so.
--
--   `test/evaluatorConversations.test.ts` closes that. It reads the columns this
--   file adds straight out of the SQL and fails unless each one is either frozen by
--   the trigger or carried by `mentoringOutcomePatch` — so a column that is neither
--   is a failing test rather than an unnoticed grant. Whoever adds the next column
--   extends that list and is made to decide which side it belongs on.
--
-- WHY BOTH ARE ON THE OUTCOME PATCH.
--   The flag is raised by the person who held the conversation, in the room, often
--   offline. It travels on tl-05's narrow assignee `update` alongside the summary
--   and the participant's response, because it is the same act: this is how it
--   went, and it is not over. An admin's whole-row upsert carries them too, so an
--   admin can clear a flag they have acted on.
--
--   ORDERING NOTE FOR DEPLOY. The patch now names two columns that did not exist
--   before this migration, so a client built from this branch talking to a backend
--   without it fails every outcome write with PGRST204 rather than only the
--   follow-up half. Apply this migration before shipping the client, not after.
--
-- Applies after 20260801000100_conversation_assignment.sql.

-- ---------------------------------------------------------------------------
-- 1. The columns.
--
--    `not null default false` rather than a nullable boolean: "did the evaluator
--    raise a flag" has two answers, not three, and a null here would show up in
--    the admin's filter as a third state meaning nothing. Existing rows take the
--    default, which is the true answer for every one of them.
-- ---------------------------------------------------------------------------

alter table mentoring_conversation
  add column if not exists follow_up_needed boolean not null default false,
  add column if not exists follow_up_note   text;

-- Guarded is not the same as self-healing, and the difference showed up while
-- mutation-testing this spec's harness. `add column if not exists` does nothing at
-- all once the column exists, so a re-run of this file could not restore a
-- constraint that had been dropped off it — the re-run reported success and left
-- the schema wrong. These three statements state the intent rather than the
-- creation, and every one of them is a no-op when the schema already agrees, so a
-- re-run now repairs instead of merely not failing.
update mentoring_conversation set follow_up_needed = false where follow_up_needed is null;
alter table mentoring_conversation alter column follow_up_needed set default false;
alter table mentoring_conversation alter column follow_up_needed set not null;

comment on column mentoring_conversation.follow_up_needed is
  'Raised by the assigned evaluator when the conversation is not finished. Surfaced to admins as a filter on the queue (tl-06).';
comment on column mentoring_conversation.follow_up_note is
  'What the evaluator wants the admin to know. The place an evaluator says a conversation should be dropped, since dismissing is not theirs.';

-- The admin's filter is "show me the ones still wanting something", which is a
-- handful of rows out of the workshop's whole queue. Partial, so the index holds
-- only the flagged rows rather than a boolean column that is false almost always.
create index if not exists mentoring_conversation_followup_idx
  on mentoring_conversation (workshop_id)
  where follow_up_needed;

-- ---------------------------------------------------------------------------
-- 2. Dismissal is not the assignee's, and now the database says so too.
--
--    tl-06 takes the Dismiss button off the evaluator's page: dropping an assigned
--    conversation is a decision by the person who assigned it, and an evaluator
--    who thinks it should be dropped raises the flag above instead. Writing the
--    harness for that found the gap — the rule was UI-only. tl-05's guard freezes
--    the assignment fields, the guidance and the trigger evidence, and `status` is
--    not among them for good reason (the assignee sets it to 'scheduled' and
--    'completed' all day), so `set status = 'dismissed'` from an assignee's own
--    session was accepted. The program's own success criterion is that every
--    cross-role attempt is "denied by RLS or RPC, not only by the UI", so this is
--    a gap to close rather than a note to leave.
--
--    A SECOND trigger rather than a `create or replace` of tl-05's, deliberately.
--    Replacing that function would put its body in two migration files with the
--    later one winning, and this repo has seven live branches reading those files
--    to learn the schema. Two narrow triggers, each owned by the spec that argued
--    for it, is worth more here than one function holding every rule.
--
--    The rule is written as a TRANSITION (old was not dismissed, new is) rather
--    than as a state, so an admin's own dismissal is untouched and a later update
--    by the assignee to an already-dismissed row is not refused for a value they
--    did not set.
-- ---------------------------------------------------------------------------

create or replace function mentoring_conversation_guard_dismissal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if has_workshop_role(new.workshop_id, array['chief_admin', 'admin']) then
    return new;
  end if;

  if new.status = 'dismissed' and old.status is distinct from 'dismissed' then
    raise exception 'only an administrator may drop a conversation; raise the follow-up flag instead'
      using errcode = '42501', detail = 'tl06.dismissal_is_not_yours';
  end if;

  return new;
end $$;

drop trigger if exists mentoring_conversation_dismiss_guard on mentoring_conversation;
create trigger mentoring_conversation_dismiss_guard
  before update on mentoring_conversation
  for each row execute function mentoring_conversation_guard_dismissal();
