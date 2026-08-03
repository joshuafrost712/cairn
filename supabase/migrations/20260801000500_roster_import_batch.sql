-- Honest Eval — tl-10: the roster import batch, which exists so an import can be undone.
--
-- The spec's whole point is that an import never writes on the first pass: it
-- parses, maps, validates, and shows a per-row verdict, and only then commits.
-- This table is the second half of that safety. A dry run protects against the
-- import you can see is wrong; a batch record protects against the one you only
-- see is wrong afterwards, when twenty-eight rows are already in the roster and
-- nobody remembers which of them were there before.
--
-- Apply after 20260801000400_invitations.sql (tl-11).
--
-- MIGRATION VERSION CLAIMED IN THE PLAN, not chosen here. tl-06 and tl-09 both
-- shipped 20260801000200 on 2026-08-01 because neither branch could see the
-- other's migrations folder, and `supabase_migrations` records a version rather
-- than a filename, so the second to merge would have been read as already
-- applied. tl-10 and tl-11 ran concurrently on 2026-08-01 with 000400 and 000500
-- claimed in 00-program-throughline.md before either branch was cut.
--
-- Three decisions worth reading before changing anything here.
--
--   * THE BEFORE-VALUES LIVE IN THIS ROW. Undo has to put back what the import
--     overwrote, and the only moment those values are known is the moment they
--     are overwritten. Storing "which participants were updated" without storing
--     what they held would make undo able to delete but not to revert, which is
--     the half of undo that matters on a re-import.
--   * AN UNDONE BATCH IS MARKED, NOT DELETED. The row is the record that an
--     import happened at all, and deleting it on undo would erase the one trace
--     of the mistake being corrected. `undone_at` is the flag; the import history
--     stays readable.
--   * IT IS AN ADMIN'S TABLE. An evaluator has no reason to read who imported
--     what, so this follows setup_change_log rather than the roster: readable by
--     the workshop's administrators only, even though the participants it
--     describes are readable by every member.
--
-- Unlike setup_change_log, writes here go through RLS policies rather than an
-- RPC, because the client legitimately owns every value in the row: it is the
-- device that read the file. `actor_email` is therefore advisory in the same way
-- the client's copy of a setup-log actor is, and nothing authorizes off it.

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------

create table if not exists roster_import_batch (
  -- Client-generated, so a batch created offline keeps one identity across the
  -- reference outbox and the eventual insert, and a replayed queue cannot
  -- double-record an import.
  id                     text primary key,
  workshop_id            uuid not null references workshop(id) on delete cascade,
  actor_email            text,
  -- What the administrator will recognize the batch by, a week later.
  filename               text not null,
  -- Rows the file held that were selected for commit, which is not the same as
  -- created + updated: a row that matched with nothing to change is committed and
  -- creates nothing.
  row_count              integer not null default 0,
  -- Participant ids this batch brought into existence. Undo deletes these.
  created_participants   jsonb not null default '[]'::jsonb,
  -- Team ids this batch brought into existence. Undo deletes those still empty.
  created_teams          jsonb not null default '[]'::jsonb,
  -- [{ id, before: { name, registered_email, team_id, preferred_language } }].
  -- Undo writes `before` back, field by field, over whatever is there now.
  updated_participants   jsonb not null default '[]'::jsonb,
  at                     timestamptz not null default now(),
  undone_at              timestamptz,
  undone_by              text
);

create index if not exists roster_import_batch_workshop_at_idx
  on roster_import_batch (workshop_id, at desc);

alter table roster_import_batch enable row level security;

-- Read, write, and undo are all the workshop's administrators. `has_workshop_role`
-- is tl-01's helper and resolves the caller from auth.uid(); `workshop_id` in the
-- row is therefore checked against a membership the client cannot assert.
drop policy if exists roster_import_batch_select on roster_import_batch;
create policy roster_import_batch_select on roster_import_batch for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

drop policy if exists roster_import_batch_insert on roster_import_batch;
create policy roster_import_batch_insert on roster_import_batch for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

-- Update exists for one reason: marking a batch undone. Both clauses name the
-- same workshop, so a row cannot be moved into another workshop by an update.
drop policy if exists roster_import_batch_update on roster_import_batch;
create policy roster_import_batch_update on roster_import_batch for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin', 'admin']))
  with check (has_workshop_role(workshop_id, array['chief_admin', 'admin']));

-- No delete policy on purpose: an import that happened stays recorded, and undo
-- is an update rather than an erasure. The cascade from `workshop` still removes
-- these rows with the workshop they describe.
drop policy if exists roster_import_batch_delete on roster_import_batch;

grant select, insert, update on roster_import_batch to authenticated;
revoke delete on roster_import_batch from authenticated, anon;
