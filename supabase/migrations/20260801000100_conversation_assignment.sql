-- tl-05: a mentoring conversation gets an owner, and the admin who hands it over
-- gets somewhere to say how it should be opened.
--
-- Five columns and a narrowed policy set. The columns are the easy half; the
-- interesting half is that this table needs a rule RLS cannot express on its own.
--
-- WHY A TRIGGER AND NOT ONLY POLICIES.
--   The rule is "an assigned evaluator may record how the conversation went, and
--   may not reassign it or rewrite the guidance they were given". That is a
--   statement about which columns CHANGED, and a policy's `with check` sees only
--   NEW. It can say "the row must still be assigned to you", which stops an
--   evaluator handing their conversation to somebody else, but it cannot say "and
--   the guidance must be the guidance you were given" without comparing to OLD.
--   So the column rule lives in a BEFORE UPDATE trigger, which is the only place
--   in Postgres that can see both rows, and the policies keep the row-level half.
--
--   The alternative was column-level GRANTs, rejected because they apply to the
--   role, not to the caller's relationship to the row: `authenticated` is one
--   role holding both the admin and the assigned evaluator, so a grant narrow
--   enough to stop the evaluator would also stop the admin.
--
-- WHY NOT AN RPC, given tl-02 used three of them.
--   tl-02's membership changes are the server's decision and are online-only on
--   purpose. A conversation outcome is the opposite: an evaluator logs it in a
--   room with no signal and it must survive the walk back. So this table stays on
--   the offline-first outbox, and the enforcement moves into the database rather
--   than into a call the outbox cannot make.
--
-- Applies after 20260728000700_workshop_membership.sql (which already replaced
-- the original `using (true)` pilot policy this spec was written against) and
-- 20260730001200_verdict_and_observation_sync.sql (current_app_user_email).

-- ---------------------------------------------------------------------------
-- 1. The columns.
--
--    Orthogonal to `status` on purpose. The lifecycle describes what has happened
--    with the participant; assignment describes who owns it. Folding assignment
--    into the enum would make "assigned, and already scheduled" inexpressible.
-- ---------------------------------------------------------------------------

alter table mentoring_conversation
  add column if not exists assigned_to               text,
  add column if not exists assigned_by               text,
  add column if not exists assigned_at               timestamptz,
  add column if not exists admin_guidance            text,
  add column if not exists admin_guidance_updated_at timestamptz;

comment on column mentoring_conversation.assigned_to is
  'Lowercased email of the evaluator who owns this conversation; null when it is still in the pool.';
comment on column mentoring_conversation.admin_guidance is
  'How the admin wants this conversation opened. Written by admins only; tl-06 displays it to the assignee.';

-- The assignee lookup the read policy performs on every row, and the per-evaluator
-- load view the admin queue draws. lower() because the client stores whatever case
-- the person typed, exactly as tl-04's verdict ids do.
create index if not exists mentoring_conversation_assignee_idx
  on mentoring_conversation (workshop_id, lower(assigned_to));

-- ---------------------------------------------------------------------------
-- 2. Normalize what is already there.
--
--    No rows hold an assignment yet (the column was added a line ago), so this is
--    only a guard for re-running the migration against a database that has been
--    used: an email that arrived with capitals would otherwise be invisible to a
--    read policy that compares lowercased.
-- ---------------------------------------------------------------------------

update mentoring_conversation
   set assigned_to = lower(assigned_to)
 where assigned_to is not null
   and assigned_to <> lower(assigned_to);

-- ---------------------------------------------------------------------------
-- 3. The column guard.
--
--    Fires for every update. An admin of the row's workshop passes straight
--    through; anybody else must leave the admin-owned columns exactly as they
--    found them. The refusal carries a stable slug in `detail`, following tl-02's
--    shape, so the client can tell this apart from a generic denial.
--
--    `is distinct from` rather than `<>` throughout: every one of these columns is
--    nullable, and `null <> null` is null, which is not true, which would let a
--    null-to-value change through unnoticed.
--
--    Not `security definer`: the two helpers it calls already are, so the trigger
--    itself needs no elevated rights, and a trigger that runs as its owner is one
--    more thing to reason about at review time.
-- ---------------------------------------------------------------------------

create or replace function mentoring_conversation_guard_admin_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if has_workshop_role(new.workshop_id, array['chief_admin', 'admin']) then
    return new;
  end if;

  if new.assigned_to               is distinct from old.assigned_to
     or new.assigned_by            is distinct from old.assigned_by
     or new.assigned_at            is distinct from old.assigned_at
     or new.admin_guidance         is distinct from old.admin_guidance
     or new.admin_guidance_updated_at is distinct from old.admin_guidance_updated_at
  then
    raise exception 'only an administrator may assign a conversation or write its guidance'
      using errcode = '42501', detail = 'tl05.admin_fields_are_not_yours';
  end if;

  -- The trigger fields identify WHICH low observation called for the conversation.
  -- An assignee rewriting them would move somebody else's evidence onto their own
  -- record while leaving the row looking untouched, so they are frozen by the same
  -- rule even though they predate this spec.
  if new.workshop_id              is distinct from old.workshop_id
     or new.participant_id        is distinct from old.participant_id
     or new.trigger_observation_id is distinct from old.trigger_observation_id
     or new.trigger_ksa_code      is distinct from old.trigger_ksa_code
     or new.trigger_designation   is distinct from old.trigger_designation
  then
    raise exception 'the evidence a conversation was triggered by is not editable'
      using errcode = '42501', detail = 'tl05.trigger_is_immutable';
  end if;

  return new;
end $$;

drop trigger if exists mentoring_conversation_guard on mentoring_conversation;
create trigger mentoring_conversation_guard
  before update on mentoring_conversation
  for each row execute function mentoring_conversation_guard_admin_fields();

-- ---------------------------------------------------------------------------
-- 4. Policies.
--
--    tl-01 already replaced the original permissive pilot policy with
--    `is_workshop_member(workshop_id)`, which is per-workshop but not per-person:
--    every member of the workshop could read every follow-up conversation about
--    every participant, and a `participant` member could read their own. This
--    narrows it to the two people with a reason to see one.
--
--    Read: the workshop's administrators see the queue they are running; everyone
--    else sees exactly the rows handed to them.
--    Insert: administrators only. Conversations are derived on every device from
--    the same observations and the same deterministic id, so letting evaluators
--    push them would have twenty devices racing to create identical rows, and the
--    queue is an administrator's surface besides.
--    Update: administrators anywhere in their workshop, assignees on their own row
--    (with the guard above deciding which columns).
--    Delete: unchanged from tl-01 — the workshop's authors.
-- ---------------------------------------------------------------------------

drop policy if exists mentoring_conversation_select on mentoring_conversation;
create policy mentoring_conversation_select on mentoring_conversation
  for select to authenticated
  using (
    has_workshop_role(workshop_id, array['chief_admin', 'admin'])
    or lower(assigned_to) = current_app_user_email()
  );

drop policy if exists mentoring_conversation_insert on mentoring_conversation;
create policy mentoring_conversation_insert on mentoring_conversation
  for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists mentoring_conversation_update on mentoring_conversation;
create policy mentoring_conversation_update on mentoring_conversation
  for update to authenticated
  using (
    has_workshop_role(workshop_id, array['chief_admin', 'admin'])
    or lower(assigned_to) = current_app_user_email()
  )
  with check (
    has_workshop_role(workshop_id, array['chief_admin', 'admin'])
    or lower(assigned_to) = current_app_user_email()
  );

-- The `with check` half above is what stops an assignee from handing the
-- conversation on: a row they update must still be theirs afterwards. The guard
-- trigger makes that redundant in practice and it is kept anyway, because the two
-- express different rules and the cheap one should not depend on the clever one.

drop policy if exists mentoring_conversation_delete on mentoring_conversation;
create policy mentoring_conversation_delete on mentoring_conversation
  for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin', 'chief_evaluator']));
