-- Honest Eval — Wave 2, W2-4: "did the email actually go out" becomes a shared fact.
--
-- Outgoing documents have lived only in Dexie since they were built, which means
-- their per-recipient send state is knowable ONLY on the laptop that generated
-- and sent them. A chief admin on any other device sees nothing at all, and
-- cannot tell that from "nothing has been sent yet". Joshua asked for a way to
-- see the progress on everything; this table is what makes that answerable.
--
-- ## Why this table's RLS is narrower than every other table here
--
-- Every other data table in this schema reads with `is_workshop_member`.
-- This one does NOT, and the difference is deliberate: `workshop_member`
-- includes the `participant` role, and a participant email contains that
-- participant's assessment while a facilitator digest contains the whole
-- cohort's. A member-wide read policy would publish the evaluations to the
-- people being evaluated. All four verbs therefore gate on the author roles,
-- the same set that can already generate and approve these documents.
--
-- ## What is stored, and what that means
--
-- The approved snapshot is the frozen text that was actually sent, plus the
-- observations each claim rested on at the moment of approval. Putting it here
-- is more evaluation prose on the server, though not a new KIND of sensitivity:
-- the observations it is rendered from are already in `observation`.
--
-- `id` is the client's deterministic draft id
-- (`${kind}::${subjectKey}::${dateLabel}::r${revision}`), not a fresh uuid.
-- Regenerating the same evening's email on two devices has to land on the same
-- row, and only the client-derived id gives that.
--
-- Apply after 20260728001000_report_assignment.sql.

create table if not exists doc_draft (
  id                  text primary key,
  -- Nullable to mirror DraftDoc.workshopId, which is nullable. Note that a null
  -- here makes the row invisible to every policy below, so the client refuses to
  -- push such a draft and reports it instead of silently dropping it.
  workshop_id         uuid references workshop(id) on delete cascade,
  kind                text not null,
  subject_key         text not null,
  title               text not null default '',
  subject             text not null default '',
  date_label          text not null default '',
  revision            integer not null default 1,
  supersedes          text,
  fanout              text not null default 'per-recipient',
  status              text not null default 'draft'
                        check (status in ('draft','approved','sending','sent','superseded')),
  recipients          jsonb not null default '[]'::jsonb,
  segments            jsonb not null default '[]'::jsonb,
  overrides           jsonb not null default '[]'::jsonb,
  orphans             jsonb not null default '[]'::jsonb,
  flags               jsonb not null default '[]'::jsonb,
  gate_override       boolean not null default false,
  gate_override_reason text,
  generated_at        timestamptz,
  -- The merge's tie-breaker. Not `default now()`: it is the CLIENT's timestamp,
  -- because the question the merge asks is which device edited the draft last,
  -- and a server default would answer "whichever pushed last" instead.
  updated_at          timestamptz not null,
  approved_by         text,
  approved_at         timestamptz,
  approved_snapshot   jsonb
);

comment on table doc_draft is
  'Outgoing documents and their per-recipient send state, shared across devices. Merge rules live in src/db/draftSync.ts: status only ever advances, and otherwise the newer updated_at wins.';

create index if not exists doc_draft_workshop_idx on doc_draft (workshop_id, status);

alter table doc_draft enable row level security;

-- Chief roles only, on all four verbs. See the header: this is NOT
-- is_workshop_member, and the difference is the point.
create policy doc_draft_select on doc_draft for select to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy doc_draft_insert on doc_draft for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy doc_draft_update on doc_draft for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

create policy doc_draft_delete on doc_draft for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));
