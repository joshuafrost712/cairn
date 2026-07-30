-- Honest Eval — tl-04: observations and verdicts get a backend.
--
-- Until now an observation lived in exactly one place: the IndexedDB of whichever
-- device imported it. A grep for `from('observation')` across src/ returned
-- nothing. Verdicts were shared, but only by each evaluator owning a JSON file in
-- a private GitHub repo, which means every evaluator's phone held a write-scoped
-- personal access token. Both facts have the same consequence, and Joshua hit it:
-- evaluations captured on his phone never counted toward participants, because the
-- reports were built on his computer and the two stores never met.
--
-- This migration is the transport. After it, Supabase is the evaluator-facing path
-- for observations coming down and verdicts going up, and GitHub is an
-- administrator's routing mechanism only (tl-03 removes the UI).
--
-- Apply after 20260728001100_doc_draft.sql.
--
-- Behaviour changes worth knowing before applying:
--   * The foundation `observation` table is retired to `observation_legacy` and a
--     client-shaped one takes its name. Nothing read or wrote the old one, so no
--     data moves; see section 1 for why it could not simply be reused.
--   * Observations are written by a workshop's administrators, not by evaluators.
--     An evaluator device that still holds manually-imported observations will
--     record an RLS refusal against them rather than pushing them. That is the
--     honest outcome and it is what tl-18 surfaces and recovers.
--   * A verdict may only be written under the caller's own email address. This is
--     the first table in the schema with a per-row author check.

-- ---------------------------------------------------------------------------
-- 1. Retire the foundation `observation` table.
--
--    It predates routing and matches nothing the client writes: a uuid primary
--    key where the client's id is the string `${capture_client_id}::${index}`,
--    `evaluation_id` and `ksa_id` uuid foreign keys where the client carries a
--    `capture_client_id` and a `ksa_code`, no `confidence`, `needs_review`,
--    `origin`, `evaluator_email` or `imported_at`, and a `routing_status` column
--    meaning something unrelated. Reusing it would have meant a join table and a
--    resolution step on every push, for a row shape nothing benefits from.
--
--    Renamed rather than dropped, because a rename is reversible in one statement
--    and this is a live project. Its policies are dropped and its grants revoked,
--    so with RLS still enabled and no policy left it is unreachable from any
--    client. It can be dropped once tl-18 has confirmed the recovery landed.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'observation'
  ) and not exists (
    -- The client-shaped table has a text id; the foundation one has uuid. If the
    -- text column is already there, this migration has run and there is nothing
    -- to retire.
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'observation'
      and column_name = 'id' and data_type = 'text'
  ) then
    for r in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = 'observation'
    loop
      execute format('drop policy %I on public.observation;', r.policyname);
    end loop;
    revoke all on public.observation from anon, authenticated;
    alter table public.observation rename to observation_legacy;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The observation table the client actually produces.
--
--    Mirrors ObservationRecord (src/lib/types.ts) field for field, plus the
--    workshop_id the client resolves at ingest.
--
--    `participant_id` is text with no foreign key, and that is deliberate. The
--    value comes from a model matching an evaluator's spoken name against the
--    roster. A uuid foreign key would reject the entire observation whenever that
--    match came back wrong, losing the evidence to protect a join the reports
--    already do client-side and already tolerate failing (an unmatched
--    observation lands in the "unattributed" bucket). Evidence loss is the worse
--    failure, so the constraint is not taken.
-- ---------------------------------------------------------------------------

create table if not exists observation (
  id                   text primary key,
  capture_client_id    text not null,
  workshop_id          uuid not null references workshop(id) on delete cascade,
  participant_id       text,
  participant_name     text not null default '',
  ksa_code             text not null,
  text                 text not null default '',
  source_excerpt       text not null default '',
  evidence_designation smallint not null check (evidence_designation between 0 and 3),
  sentiment_flag       text not null check (sentiment_flag in ('strong','weak','neutral')),
  confidence           text not null check (confidence in ('low','medium','high')),
  needs_review         boolean not null default false,
  origin               text not null check (origin in ('individual','group')),
  imported_at          timestamptz not null default now(),
  evaluator_email      text
);

comment on table observation is
  'Individual-level observations produced by routing a capture. Written by a workshop''s administrators (routing is an administrator''s act from tl-03), read by every member so the multi-evaluator verification gate can run on any device.';

-- "everything in this workshop" is the pull; "the observations behind this
-- capture" is what the capture detail and the report rollup ask for.
create index if not exists observation_workshop_idx on observation (workshop_id);
create index if not exists observation_capture_idx on observation (capture_client_id);
create index if not exists observation_participant_idx on observation (workshop_id, participant_id);

alter table observation enable row level security;
revoke all on public.observation from anon;
grant select, insert, update, delete on public.observation to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The verdict table.
--
--    `id` is the existing composite `${observation_id}::${evaluator_email}`,
--    which already gives exactly one current verdict per evaluator per
--    observation and makes an upsert idempotent.
--
--    `workshop_id` is carried on the row rather than resolved through the
--    observation on every read, because the pull is "every verdict in this
--    workshop" and a policy that joined to observation would make the whole
--    verdict set unreadable for as long as its observations were mid-push.
--    Section 5 keeps the two consistent.
-- ---------------------------------------------------------------------------

create table if not exists verification_verdict (
  id                   text primary key,
  observation_id       text not null,
  capture_client_id    text not null,
  workshop_id          uuid not null references workshop(id) on delete cascade,
  evaluator_email      text not null,
  decision             text not null check (decision in ('confirm','adjust','reject')),
  adjusted_designation smallint check (adjusted_designation between 0 and 3),
  note                 text,
  at                   timestamptz not null default now()
);

comment on table verification_verdict is
  'One evaluator''s current verdict on one observation. Shared through the backend so the multi-evaluator gate reaches its threshold without every phone holding a GitHub token.';

create index if not exists verification_verdict_workshop_idx
  on verification_verdict (workshop_id);
create index if not exists verification_verdict_observation_idx
  on verification_verdict (observation_id);

alter table verification_verdict enable row level security;
revoke all on public.verification_verdict from anon;
grant select, insert, update, delete on public.verification_verdict to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Two helpers.
--
--    `current_app_user_email` is the first time a policy needs to know WHO the
--    caller is rather than what role they hold, because a verdict is signed. It
--    reads app_user rather than the JWT claim: the email on the JWT is settable
--    at signup in some auth configurations, and app_user.email is the row the
--    invite-only allowlist trigger wrote. Lowercased on both sides of every
--    comparison, since the client stores whatever case the person typed and the
--    verdict id is built from it.
-- ---------------------------------------------------------------------------

create or replace function current_app_user_email()
returns text
language sql stable security definer set search_path = public
as $$ select lower(email) from app_user where auth_user_id = auth.uid() $$;

create or replace function workshop_of_observation(_observation_id text)
returns uuid
language sql stable security definer set search_path = public
as $$ select workshop_id from observation where id = _observation_id $$;

-- ---------------------------------------------------------------------------
-- 5. Policies.
--
--    observation: read by any member of its workshop; written only by that
--    workshop's authors, the same set that edits the roster. Routing is an
--    administrator's act, so an evaluator inserting an observation is not a
--    workflow this app has — it is somebody putting evidence into a participant's
--    record without a capture behind it.
-- ---------------------------------------------------------------------------

drop policy if exists observation_select on observation;
create policy observation_select on observation for select to authenticated
  using (is_workshop_member(workshop_id));

drop policy if exists observation_insert on observation;
create policy observation_insert on observation for insert to authenticated
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists observation_update on observation;
create policy observation_update on observation for update to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']))
  with check (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

drop policy if exists observation_delete on observation;
create policy observation_delete on observation for delete to authenticated
  using (has_workshop_role(workshop_id, array['chief_admin','admin','chief_evaluator']));

-- verification_verdict: read by any member, because seeing that a colleague
-- confirmed is the entire point of a multi-evaluator gate. Written only under
-- your own address.
--
-- The third clause on insert and update keeps the denormalized workshop_id honest
-- against the observation's own, and tolerates the observation not being on the
-- server yet: `coalesce(... , true)` passes when the lookup returns null. Without
-- that tolerance the first sync cycle of the recovery would deny every verdict
-- whose observation happened to be later in the same push.

drop policy if exists verification_verdict_select on verification_verdict;
create policy verification_verdict_select on verification_verdict for select to authenticated
  using (is_workshop_member(workshop_id));

drop policy if exists verification_verdict_insert on verification_verdict;
create policy verification_verdict_insert on verification_verdict for insert to authenticated
  with check (
    is_workshop_member(workshop_id)
    and lower(evaluator_email) = current_app_user_email()
    and coalesce(workshop_of_observation(observation_id) = workshop_id, true)
  );

drop policy if exists verification_verdict_update on verification_verdict;
create policy verification_verdict_update on verification_verdict for update to authenticated
  using (
    is_workshop_member(workshop_id)
    and lower(evaluator_email) = current_app_user_email()
  )
  with check (
    is_workshop_member(workshop_id)
    and lower(evaluator_email) = current_app_user_email()
    and coalesce(workshop_of_observation(observation_id) = workshop_id, true)
  );

-- Un-verifying is withdrawing your own signature, so it is your own act. A
-- chief who disagrees resolves the discrepancy rather than deleting somebody
-- else's verdict, which is what the inbox is for.
drop policy if exists verification_verdict_delete on verification_verdict;
create policy verification_verdict_delete on verification_verdict for delete to authenticated
  using (
    is_workshop_member(workshop_id)
    and lower(evaluator_email) = current_app_user_email()
  );

-- ---------------------------------------------------------------------------
-- 6. Realtime on observation, so a newly routed observation reaches the
--    evaluator who has to verify it without waiting for the interval pull.
--    Additive: the 30-second pull stays the reliable path.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'observation'
  ) then
    alter publication supabase_realtime add table public.observation;
  end if;
end $$;
