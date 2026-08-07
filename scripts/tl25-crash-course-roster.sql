-- tl-25: the Crash Course roster, and the people who are in two workshops at once.
--
-- Fills workshop 74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b with four participants and
-- two teams, and issues four memberships through tl-11's invitation RPC.
--
--   node scripts/apply-migration.mjs scripts/tl25-crash-course-roster.sql
--
-- NOT a migration, for the same reasons tl24-crash-course-content.sql is not: no
-- schema change, deliberately outside supabase/migrations/ so `db push` never
-- replays it, and idempotent on fixed ids so a re-run after Joshua edits a name is
-- how the edit is applied. cc4 = participants, cc5 = teams, cc6 = person rows this
-- spec creates. No DELETE and no unscoped UPDATE anywhere in the file.
--
-- ## The spec's stated current state was six days stale, and checking cost nothing
--
-- tl-25 says "Psalms holds 22 participants and none of them has an email on file"
-- and "`person` currently holds two rows". Both were true of tl-12's record on
-- 2026-08-01 and neither was true of the live database on 2026-08-07: the Psalms
-- roster load of 2026-08-01 (vault: `Psalms roster load 2026-08-01.sql`) put a real
-- address on all 22 and its backfill created 24 person rows at 21:31 that day.
--
-- That inverts step 4. The spec expected to work a suggestion screen by hand
-- because email was unavailable; in fact every cross-workshop human already has a
-- `person` keyed on their real address, so the link is the `certain` email basis
-- and it is deterministic. Three consequences, each encoded below rather than
-- argued:
--
--   * Martin Landert and Sibaji Digal are linked here, by matching the exact
--     normalized address their Psalms row already carries. This is what
--     `personIdForEmail` (src/lib/people.ts) does when the app creates a
--     participant; it is not a new rule.
--   * Irene van Riezen and Mathew Thomas need NOTHING done to them. Their Psalms
--     person rows hold irene@sall.com and mathewtperumal@gmail.com, which are the
--     addresses they are invited at below, so `app_user_link_person` links their
--     accounts to those same rows the moment they sign up. Asserted in
--     scripts/tl25-verify.sql rather than assumed.
--   * Nothing calls merge_persons(), and the merge screen is not needed. Had the
--     spec's reading held, Irene would have been unlinkable anyway: her Psalms row
--     is named "Irene", and initialKey() returns null on a single-word name while
--     nameKey() and the one-edit rule both fail against "Irene van Riezen", so
--     mergeCandidates() would never have offered her at all.
--
-- ## Jael Claybaugh has no Psalms row in this database, and that is a Psalms bug
--
-- She is a Psalms participant: she is on the workshop bcc list, on the arrivals
-- document's list of 22, and booked to depart 5 September. The app does not hold
-- her because the roster load of 2026-08-01 deliberately left her out "pending her
-- details", which arrived on 3-4 August. In the same window Tammy Cortimilia
-- withdrew ("I am not going to participate this time", 2026-07-31) and is still on
-- file. So Psalms reads 22 and is wrong by two names in opposite directions, which
-- is why the count invariant below passes while saying nothing about correctness.
--
-- Fixing Psalms' roster is out of scope here and is left as a finding. The
-- consequence for this file is only that Jael gets a fresh person row, and her
-- Crash Course card will show one workshop until Psalms is corrected.
--
-- ## Joshua's decisions, 2026-08-07, encoded rather than argued
--
--   * Viji Mathew is the ninth name in the arrivals document's week-1 table, which
--     tl-25 read as a chore-rotation number and dropped. He is Head of the Global
--     Consulting Pool and he is invited as an evaluator.
--   * The role table stands: Nikki Mustin chief_evaluator, Irene and Mathew
--     evaluator. Nobody gets `admin`, so nobody but Joshua can rewrite the
--     questions mid-workshop.
--   * Two teams of two, so Wednesday's Peer Review Passage 1 is not circular.
--     Martin with Jael, Sibaji with Micah.
--
-- `sex` is left null on all four. The spec says fill it only where the roster
-- already carries it, and the registration form does not ask.

begin;

-- ---------------------------------------------------------------------------
-- 1. Teams, before participants, because participant.team_id references them.
--
--    Named for their members rather than "Team A", per the spec, and not for the
--    passages because the course does not name them yet. Rename freely once it
--    does; the ids are what the participant rows point at.
-- ---------------------------------------------------------------------------

insert into team (id, workshop_id, name) values
  ('cc500000-0000-4000-8000-000000000001', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'Martin and Jael'),
  ('cc500000-0000-4000-8000-000000000002', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'Sibaji and Micah')
on conflict (id) do update set name = excluded.name, workshop_id = excluded.workshop_id;

-- ---------------------------------------------------------------------------
-- 2. The two person rows this spec creates.
--
--    Only for the two participants who have none. Martin's and Sibaji's already
--    exist from the Psalms load and are looked up, never inserted: `primary_email`
--    is unique, so an insert on an address already held would abort the whole
--    file, and re-creating an identity is precisely the failure the person layer
--    exists to prevent.
--
--    `created_by` is Joshua's app_user id rather than the default
--    current_app_user_id(), which is null when this file runs as postgres. A
--    person row with a null creator is readable only through a workshop it is
--    already in, and these two are linked to a participant in the next statement,
--    so it is belt-and-braces rather than load-bearing.
-- ---------------------------------------------------------------------------

insert into person (id, display_name, primary_email, created_by) values
  ('cc600000-0000-4000-8000-000000000001', 'Jael Claybaugh', 'jael.claybaugh@ywammontana.org',
   'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('cc600000-0000-4000-8000-000000000002', 'Micah Limboo',   'micah@sall.com',
   'b7e5f597-de75-4116-bcc3-f24b27b33407')
on conflict (id) do update set
  display_name = excluded.display_name,
  primary_email = excluded.primary_email,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Four participants.
--
--    Names are spelled exactly as the Psalms rows spell them for the two who have
--    one, which is what turns the link into an identity rather than a judgement.
--
--    `person_id` is resolved by exact normalized email against `person`, the same
--    `certain` basis the app uses, and coalesced to the row this file created so
--    the statement is correct on a re-run in either order. Addresses, and where
--    each came from:
--
--      Martin Landert  martin_landert@wycliffe.sg      his registration form; also his Psalms row
--      Sibaji Digal    sibajidigal2018@gmail.com       his Psalms row; no registration form yet
--      Jael Claybaugh  jael.claybaugh@ywammontana.org  her registration form AND the address she
--                                                      writes from. The workshop bcc list uses
--                                                      jaelclaybaugh@nbseminary.ca; taking her own
--                                                      submission is the rule the Psalms roster load
--                                                      applied to Raissa's two domains, and the
--                                                      conflict is flagged rather than silently picked.
--      Micah Limboo    micah@sall.com                  his registration form; he writes from it too
--
--    `organization` is self-reported on the registration form. Sibaji has not sent
--    one, so his is null rather than guessed. `years_of_service` is asked for
--    nowhere and is null for all four.
-- ---------------------------------------------------------------------------

insert into participant (
  id, workshop_id, name, registered_email, team_id, preferred_language, organization, person_id
)
select v.id, '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', v.name, v.email, v.team_id, 'English', v.org,
       (select p.id from person p where p.primary_email = lower(btrim(v.email)))
from (values
  ('cc400000-0000-4000-8000-000000000001'::uuid, 'Martin Landert', 'martin_landert@wycliffe.sg',
   'cc500000-0000-4000-8000-000000000001'::uuid, 'Wycliffe'),
  ('cc400000-0000-4000-8000-000000000002'::uuid, 'Jael Claybaugh', 'jael.claybaugh@ywammontana.org',
   'cc500000-0000-4000-8000-000000000001'::uuid, 'YWAM'),
  ('cc400000-0000-4000-8000-000000000003'::uuid, 'Sibaji Digal', 'sibajidigal2018@gmail.com',
   'cc500000-0000-4000-8000-000000000002'::uuid, null),
  ('cc400000-0000-4000-8000-000000000004'::uuid, 'Micah Limboo', 'micah@sall.com',
   'cc500000-0000-4000-8000-000000000002'::uuid, '3 Strands')
) as v(id, name, email, team_id, org)
on conflict (id) do update set
  workshop_id = excluded.workshop_id,
  name = excluded.name,
  registered_email = excluded.registered_email,
  team_id = excluded.team_id,
  organization = excluded.organization,
  person_id = excluded.person_id;

-- A person row with no participant and no account is invisible to every read
-- policy, so this asserts the link landed rather than trusting the subselect.
do $$
declare _unlinked int;
begin
  select count(*) into _unlinked from participant
   where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and person_id is null;
  if _unlinked > 0 then
    raise exception 'tl-25: % Crash Course participant(s) have no person_id; the email lookup missed', _unlinked;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Micah Limboo's note.
--
--    He is Crash Course only and flies out on 24 August as Psalms begins. The
--    spec asks for it "wherever the roster carries a note", and `participant` has
--    no note column, so it goes on his profile headline — the same field the
--    Psalms roster load used for status, and the one an evaluator reads before
--    watching somebody. `visibility` is left at the default so the room can see it.
--
--    Nothing is written for the other three: a headline that repeats what the card
--    already shows is noise on a screen whose whole argument is that attention is
--    scarce.
-- ---------------------------------------------------------------------------

insert into person_profile (person_id, headline, visibility, updated_at, updated_by) values
  ('cc600000-0000-4000-8000-000000000002',
   'Crash Course only. Departs 24 August as the Psalms Workshop begins.',
   'workshop', now(), 'josh_frost@sil.org')
on conflict (person_id) do update set
  headline = excluded.headline,
  updated_at = now(),
  updated_by = excluded.updated_by;

commit;

-- ---------------------------------------------------------------------------
-- 5. Four memberships, through tl-11's RPC and not by inserting workshop_member.
--
--    tl-01 REVOKED the client grants on workshop_member rather than omitting a
--    policy, and `invite_to_workshop` is the only path. This file takes that path
--    rather than working around it, which means impersonating Joshua: the RPC
--    resolves its actor from auth.uid(), which is null under the `postgres` role
--    this script runs as, and would refuse with tl02.no_account.
--
--    Setting request.jwt.claims is the harness pattern this repo already uses in
--    every tl*-rls-tests.sql since tl-01, and it is the honest version of the act:
--    can_grant runs against Joshua's real chief_admin role, and an invitation he
--    is not entitled to issue still fails. It is NOT a way round the permission,
--    it is the permission being exercised.
--
--    Outside the transaction above, and each call caught, because the RPC raises
--    on an already-pending invitation and a partial re-run should report that
--    rather than roll back the roster.
--
--    No email leaves the building here. Nothing in this deployment mails an
--    invitation; the row is a standing instruction to handle_new_user, and the
--    person is admitted when they sign up at that address. Telling them to sign up
--    is Joshua's act, not this file's.
-- ---------------------------------------------------------------------------

create temp table tl25_invite_log (who text, email text, role text, outcome text);

-- Outcomes accumulate in a local array and are written after `reset role`: while
-- the block is impersonating, it holds `authenticated` and has no rights on a temp
-- table of its own making. Worth keeping as a comment because the first version of
-- this file lost four invitations to it — the failing INSERT was the one inside the
-- exception handler, so the handler could not report its own failure.
do $$
declare
  _r record;
  _out jsonb;
  _log jsonb := '[]'::jsonb;
  _josh uuid;
begin
  -- Resolved BEFORE the role switch, and this is the second thing this block got
  -- wrong: `app_user_select` hides anybody you do not already share a workshop
  -- with, so reading Joshua's auth id while holding `authenticated` with no valid
  -- uid returned nothing, the claim went in as {"sub": null}, and all four
  -- invitations came back tl02.no_account. RLS filters rather than refusing, so
  -- the empty subselect said nothing on its way past.
  select auth_user_id into _josh from app_user where email = 'josh_frost@sil.org';
  if _josh is null then
    raise exception 'tl-25: no auth_user_id for josh_frost@sil.org; cannot issue invitations as him';
  end if;

  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, false);

  for _r in select * from (values
    ('nikkicm23@gmail.com',    'chief_evaluator', 'Nikki Mustin'),
    ('irene@sall.com',         'evaluator',       'Irene van Riezen'),
    ('mathewtperumal@gmail.com','evaluator',      'Mathew Thomas'),
    ('viji_mathew@sil.org',    'evaluator',       'Viji Mathew')
  ) as t(email, role, who)
  loop
    begin
      _out := invite_to_workshop('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', _r.email, _r.role);
      _log := _log || jsonb_build_object('who', _r.who, 'email', _r.email, 'role', _r.role,
                                         'outcome', _out->>'outcome');
    exception when others then
      _log := _log || jsonb_build_object('who', _r.who, 'email', _r.email, 'role', _r.role,
                                         'outcome', format('REFUSED [%s] %s', sqlstate, sqlerrm));
    end;
  end loop;

  perform set_config('request.jwt.claims', '', false);
  reset role;

  insert into tl25_invite_log
  select e->>'who', e->>'email', e->>'role', e->>'outcome' from jsonb_array_elements(_log) e;
end $$;


-- ---------------------------------------------------------------------------
-- 6. Acceptance. Applying and verifying are one act, as in tl-24.
--
--    The Psalms row is the invariant this spec is most likely to break, because a
--    mis-scoped insert into `participant` is exactly the mistake that would not
--    announce itself. It says nothing about whether Psalms' roster is CORRECT; see
--    the header on Jael and Tammy.
--
--    The invitation log rides along in the same object because the Management API
--    returns the last result set only, and an invitation that was refused is the
--    half of this file most worth reading. `signup_opens` is the window the
--    admission scheduler gave each one: sign-up mail is metered at
--    signup_budget_per_hour(), which is 2 on this project's built-in mailer with
--    no custom SMTP, so four invitations do not all open at once and these are the
--    times to put in the message Joshua sends.
-- ---------------------------------------------------------------------------

select jsonb_pretty(jsonb_build_object(
  'invitations', (select jsonb_agg(jsonb_build_object(
      'who', l.who, 'email', l.email, 'role', l.role, 'outcome', l.outcome,
      'signup_opens', to_char(i.opens_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI UTC')
    ) order by i.opens_at nulls last)
    from tl25_invite_log l
    left join workshop_invitation i
      on i.workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and i.email = l.email),
  'crash_course', (select jsonb_build_object(
      'participants', (select count(*) from participant where workshop_id = w.id),
      'participants_with_person', (select count(*) from participant
                                    where workshop_id = w.id and person_id is not null),
      'participants_with_email', (select count(*) from participant
                                   where workshop_id = w.id
                                     and registered_email is not null and btrim(registered_email) <> ''),
      'teams', (select count(*) from team where workshop_id = w.id),
      'unteamed', (select count(*) from participant where workshop_id = w.id and team_id is null),
      'members', (select count(*) from workshop_member where workshop_id = w.id),
      'invitations_pending', (select count(*) from workshop_invitation
                               where workshop_id = w.id and status = 'pending'),
      'goals', (select count(*) from goal where workshop_id = w.id),
      'questions', (select count(*) from ksa where workshop_id = w.id),
      'activities', (select count(*) from activity where workshop_id = w.id)
    ) from workshop w where w.id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
  'psalms_unchanged', (select jsonb_build_object(
      'participants', (select count(*) from participant where workshop_id = w.id),
      'activities', (select count(*) from activity where workshop_id = w.id),
      'goals', (select count(*) from goal where workshop_id = w.id),
      'questions', (select count(*) from ksa where workshop_id = w.id)
    ) from workshop w where w.id = '11111111-1111-1111-1111-111111111111')
)) as acceptance;
