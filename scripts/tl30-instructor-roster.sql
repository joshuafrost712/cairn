-- tl-30: who the instructors are, and who may review each of them.
--
--   node scripts/apply-migration.mjs scripts/tl30-instructor-roster.sql
--
-- NOT a migration, for the same reasons tl25-crash-course-roster.sql is not.
-- Idempotent on fixed ids so a re-run after Joshua corrects a name or an address
-- is how the correction is applied. Namespaces: 30400000 = instructor participant
-- rows, 30600000 = person rows this file creates. No DELETE and no unscoped
-- UPDATE anywhere in the file.
--
-- ## The eighteen pairs, and why they are not a formula
--
-- Joshua's rules very nearly reduce to "everyone reviews everyone except
-- themselves". They do not, because of one person: **Viji Mathew is reviewed only
-- by Nikki Mustin and Angeline Foo**, while himself reviewing all the other
-- facilitators. He is at both workshops as a lead rather than as a co-teacher,
-- and Joshua's instruction was specific. So every grant is written out. Eighteen
-- rows is more typing than a flag and it is the only form in which the exception
-- is visible to the next person who reads this file.
--
--   Crash Course (four instructors: Joshua, Mathew Thomas, Irene, Viji)
--     Joshua          -> Mathew, Irene
--     Mathew Thomas   -> Joshua, Irene
--     Irene           -> Joshua, Mathew
--     Nikki Mustin    -> Joshua, Mathew, Irene, Viji
--     Viji Mathew     -> Joshua, Mathew, Irene
--
--   Psalms / songs workshop (two instructors: Joshua, Viji)
--     Nikki Mustin    -> Joshua, Viji
--     Angeline Foo    -> Joshua, Viji
--     Viji Mathew     -> Joshua
--
-- Nobody reviews themselves, and the trigger installed by the migration refuses
-- such a row even if a future edit to this file tries to write one.
--
-- ## Three of the five reviewers have no account yet
--
-- As of 2026-08-17 the database holds accounts for Joshua, Katie, Irene and
-- Mathew only. Nikki and Viji hold PENDING Crash Course invitations from tl-25;
-- Angie has never been invited. This is exactly why `instructor_reviewer` is
-- keyed on email rather than on `app_user_id`: the pairs below are written now
-- and begin working the moment each person signs in, with nobody having to
-- remember to come back and fill in an id.
--
-- Two consequences worth stating rather than discovering:
--
--   * **Nikki and Viji must sign up at the address they were invited at**
--     (nikkicm23@gmail.com and viji_mathew@sil.org). Their pairs, their pending
--     invitations, and Viji's person link below are all keyed on those. Viji is
--     allowlisted at a second address, viji@sall.com; an account created there
--     would satisfy neither his invitation nor these pairs.
--   * **Nikki and Viji need no membership work here.** `handle_new_user` runs the
--     invitation loop AND tl-01's allowlist bridge, in that order, so signing up
--     gives each of them their Crash Course membership from the pending
--     invitation and their Psalms membership from the allowlist's
--     `default_workshop_id`. Verified by reading the function, asserted in
--     scripts/tl30-verify.sql rather than assumed.
--
-- ## Angeline Foo, who goes by Angie
--
-- Joshua, 2026-08-17: her SIL official name is **Angeline Foo**, which is the name
-- on the account she will sign up with; she usually goes by **Angie**, and is also
-- referred to as **Angie Seow**. All three name one person, and the display string
-- on her `person` row below carries the first two so a reader recognizes her under
-- either. Nothing in this file keys on a name.
--
-- ## Angie gets `participant`, which nobody has held before
--
-- She is a songs-workshop attendee, not a trainee evaluator. Inviting her as
-- `evaluator` to give her one button would hand her the whole 22-person roster
-- and every assessment written about it. `participant` is the lowest role in
-- WORKSHOP_ROLES, has never been issued in this deployment, and after the tl-30
-- migration it reads nothing: `has_evaluating_role()` excludes it from every
-- trainee-facing policy. Her two reviewer pairs are her entire app.
--
-- ## Mathew and Irene already have no songs-workshop access
--
-- Joshua asked for it to be taken away. It was never granted: tl-25 invited them
-- to the Crash Course only, and the live `workshop_member` table confirms it.
-- Nothing is revoked here because there is nothing to revoke; the verify script
-- asserts the state instead, so a future invitation that re-opens it fails a test
-- rather than passing unnoticed. Their Psalms TRAINEE rows are untouched and they
-- go on being evaluated there, which is what Joshua chose.
--
-- ## Two people are called Mathew
--
-- Mathew Thomas (mathewtperumal@gmail.com) and Viji Mathew
-- (viji_mathew@sil.org). Every row below keys on an id or an address. Nothing
-- keys on a display name.

begin;

-- ---------------------------------------------------------------------------
-- 1. A person row for Viji, who has never been in this database as a human.
--
--    Joshua, Mathew Thomas and Irene already hold person rows (created by the
--    Psalms roster load of 2026-08-01 and by tl-25), keyed on the same addresses
--    they sign in at, so their instructor rows below just point at them.
--    `app_user_link_person` will attach Viji's account to this row the moment he
--    signs up, because the primary email matches.
-- ---------------------------------------------------------------------------

-- Angeline gets one too, for a different reason: she is a REVIEWER rather than an
-- instructor, so she has no roster row, and until she signs up there is nothing in
-- the database carrying her name at all. The Setup grid would show an administrator
-- a bare address in the row where a person should be. See the note on her name
-- below for why the display string carries three forms of it.
insert into person (id, display_name, primary_email, created_by) values
  ('30600000-0000-4000-8000-000000000001', 'Viji Mathew', 'viji_mathew@sil.org',
   'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('30600000-0000-4000-8000-000000000002', 'Angeline Foo (Angie)', 'angeline_foo@sil.org',
   'b7e5f597-de75-4116-bcc3-f24b27b33407')
on conflict (id) do update set
  display_name = excluded.display_name, primary_email = excluded.primary_email;

-- ---------------------------------------------------------------------------
-- 1b. Angeline's name, and why it is written the way it is.
--
--    Joshua, 2026-08-17: "Angie doesn't have a name that fits into Western naming
--    conventions easily. Her email Angeline Foo is her SIL official name, though
--    she often goes by Angie. She should be referenceable by either name, as well
--    as Angie Seow as we are talking."
--
--    Three forms, and `person` holds ONE `display_name` with no alias column. The
--    options were to add one for a single person, or to put the forms in the string
--    somebody actually reads. The string wins: nothing in this app searches people
--    by name — `mergeCandidates` matches names only to propose merging duplicates,
--    which is a different question — so "referenceable" here means legible to a
--    human scanning a list, and a column no surface reads would not deliver it.
--
--    So: `display_name` carries the official name with the everyday one beside it,
--    the headline carries her actual role, and `notes` records "Angie Seow" as a
--    third form in use. If a real people-search ever lands, that note is the
--    evidence an alias column is owed, and this comment is the reason.
--
--    `visibility` is 'workshop', the default, and deliberately not narrowed: her
--    title is the reason her feedback on a facilitator carries weight, and it is
--    public professional information rather than anything personal.
-- ---------------------------------------------------------------------------

insert into person_profile (person_id, headline, notes, visibility, updated_at, updated_by) values
  ('30600000-0000-4000-8000-000000000002',
   'International Coordinator for Translation Research and Practice; Senior Translation Consultant; Board Member, SIL International',
   'Officially Angeline Foo, which is the name on her SIL account. Usually goes by Angie, and is also referred to as Angie Seow. All three name the same person.',
   'workshop', now(), 'josh_frost@sil.org')
on conflict (person_id) do update set
  headline = excluded.headline, notes = excluded.notes,
  updated_at = excluded.updated_at, updated_by = excluded.updated_by;

-- ---------------------------------------------------------------------------
-- 2. The instructor roster rows.
--
--    category = 'instructor' is the whole distinction. These are `participant`
--    rows so that routing, observation and report building need no new entity,
--    and they are invisible to the ordinary capture roster because
--    CaptureActivity filters on the same column. team_id is null: a facilitator
--    is not on a peer-review team.
--
--    Irene's PARTICIPANT row is named "Irene van Riezen" while her `person` row
--    still reads "Irene", which is what the Psalms roster load put there. The
--    person row is left alone deliberately: renaming it is a cross-workshop
--    identity edit that belongs to whoever fixes the Psalms roster, and tl-25
--    already logged that as a finding.
-- ---------------------------------------------------------------------------

insert into participant (id, workshop_id, name, registered_email, team_id, person_id, category) values
  -- Crash Course
  ('30400000-0000-4000-8000-000000000011', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Joshua C. Frost',    'josh_frost@sil.org',       null, 'a5e4194e-958e-4be3-a156-215e03bd9b88', 'instructor'),
  ('30400000-0000-4000-8000-000000000012', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Mathew Thomas',      'mathewtperumal@gmail.com', null, 'ecf16808-00a9-48ad-8f95-abe2a0ff656d', 'instructor'),
  ('30400000-0000-4000-8000-000000000013', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Irene van Riezen',   'irene@sall.com',           null, '1be44bf4-49d2-457b-b37a-032aac3b32a9', 'instructor'),
  ('30400000-0000-4000-8000-000000000014', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Viji Mathew',        'viji_mathew@sil.org',      null, '30600000-0000-4000-8000-000000000001', 'instructor'),
  -- Psalms / songs workshop
  ('30400000-0000-4000-8000-000000000021', '11111111-1111-1111-1111-111111111111',
   'Joshua C. Frost',    'josh_frost@sil.org',       null, 'a5e4194e-958e-4be3-a156-215e03bd9b88', 'instructor'),
  ('30400000-0000-4000-8000-000000000022', '11111111-1111-1111-1111-111111111111',
   'Viji Mathew',        'viji_mathew@sil.org',      null, '30600000-0000-4000-8000-000000000001', 'instructor')
on conflict (id) do update set
  workshop_id = excluded.workshop_id, name = excluded.name,
  registered_email = excluded.registered_email, person_id = excluded.person_id,
  category = excluded.category;

-- ---------------------------------------------------------------------------
-- 3. The eighteen grants.
--
--    Written as plain inserts rather than through set_instructor_review_pair(),
--    for the reason tl-25 gives about its own roster rows: this file runs as
--    `postgres`, the RPC exists to let Joshua fix a pair from the app, and
--    round-tripping through an RLS impersonation block here would test the RPC
--    rather than establish the data. The guard trigger still fires, so a self-
--    review pair or a non-instructor target fails here exactly as it would there.
-- ---------------------------------------------------------------------------

insert into instructor_reviewer (workshop_id, reviewer_email, instructor_participant_id, granted_by) values
  -- Crash Course: the three co-teachers review each other.
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'josh_frost@sil.org',       '30400000-0000-4000-8000-000000000012', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'josh_frost@sil.org',       '30400000-0000-4000-8000-000000000013', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'mathewtperumal@gmail.com', '30400000-0000-4000-8000-000000000011', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'mathewtperumal@gmail.com', '30400000-0000-4000-8000-000000000013', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'irene@sall.com',           '30400000-0000-4000-8000-000000000011', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'irene@sall.com',           '30400000-0000-4000-8000-000000000012', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  -- Crash Course: Nikki reviews all four, and is the only route to Viji here
  -- besides Angie, who is not at this workshop.
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000011', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000012', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000013', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000014', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  -- Crash Course: Viji reviews the three co-teachers. Note there is no row
  -- granting any of them a review of HIM; that asymmetry is Joshua's decision.
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'viji_mathew@sil.org',      '30400000-0000-4000-8000-000000000011', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'viji_mathew@sil.org',      '30400000-0000-4000-8000-000000000012', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'viji_mathew@sil.org',      '30400000-0000-4000-8000-000000000013', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  -- Songs workshop: Nikki and Angie review both leads; Viji reviews Joshua.
  ('11111111-1111-1111-1111-111111111111', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000021', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('11111111-1111-1111-1111-111111111111', 'nikkicm23@gmail.com',      '30400000-0000-4000-8000-000000000022', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('11111111-1111-1111-1111-111111111111', 'angeline_foo@sil.org',     '30400000-0000-4000-8000-000000000021', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('11111111-1111-1111-1111-111111111111', 'angeline_foo@sil.org',     '30400000-0000-4000-8000-000000000022', 'b7e5f597-de75-4116-bcc3-f24b27b33407'),
  ('11111111-1111-1111-1111-111111111111', 'viji_mathew@sil.org',      '30400000-0000-4000-8000-000000000021', 'b7e5f597-de75-4116-bcc3-f24b27b33407')
on conflict (workshop_id, reviewer_email, instructor_participant_id) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- 4. Angie's invitation, issued as Joshua through tl-11's RPC.
--
--    Outside the transaction above because it impersonates: the RPC resolves the
--    actor from auth.uid(), so the block sets a JWT claim and resets it. tl-25
--    got this wrong twice and wrote down why, so the two traps are honoured here.
--    Joshua's auth id is resolved BEFORE the role switch (app_user_select hides
--    everyone from a caller with no valid uid, so the read must happen as
--    postgres), and every failure is captured rather than allowed to abort.
--
--    Sign-up mail is metered by signup_budget_per_hour(), so the `opens_at` the
--    scheduler returns is the time to put in the message Joshua sends her.
-- ---------------------------------------------------------------------------

create temp table if not exists tl30_invite_log (who text, email text, role text, outcome text);

do $$
declare
  _josh uuid;
  _out  jsonb;
  _log  jsonb := '[]'::jsonb;
begin
  select auth_user_id into _josh from app_user where email = 'josh_frost@sil.org';
  if _josh is null then
    raise exception 'tl-30: no auth_user_id for josh_frost@sil.org; cannot issue invitations as him';
  end if;

  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _josh, 'role', 'authenticated')::text, false);

  begin
    _out := invite_to_workshop('11111111-1111-1111-1111-111111111111',
                               'angeline_foo@sil.org', 'participant');
    _log := _log || jsonb_build_object('who', 'Angeline Foo (Angie)', 'email', 'angeline_foo@sil.org',
                                       'role', 'participant', 'outcome', _out->>'outcome');
  exception when others then
    _log := _log || jsonb_build_object('who', 'Angeline Foo (Angie)', 'email', 'angeline_foo@sil.org',
                                       'role', 'participant',
                                       'outcome', format('REFUSED [%s] %s', sqlstate, sqlerrm));
  end;

  perform set_config('request.jwt.claims', '', false);
  reset role;

  insert into tl30_invite_log
  select e->>'who', e->>'email', e->>'role', e->>'outcome' from jsonb_array_elements(_log) e;
end $$;

-- Acceptance. Applying and verifying are one act, as in tl-24 and tl-25. The
-- invariant most worth reading is `trainee_rosters`: a mis-scoped insert into
-- `participant` is exactly the mistake that would not announce itself, and the
-- Crash Course must still read 4 trainees and Psalms 22.
select jsonb_pretty(jsonb_build_object(
  'instructors', (select jsonb_agg(jsonb_build_object(
                     'w', case when p.workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' then 'Crash Course' else 'Songs' end,
                     'name', p.name, 'email', p.registered_email,
                     'person_linked', p.person_id is not null,
                     'reviewers', (select count(*) from instructor_reviewer r where r.instructor_participant_id = p.id))
                   order by p.workshop_id, p.name)
                  from participant p where p.category = 'instructor'),
  'pairs_by_reviewer', (select jsonb_agg(x order by x->>'email')
                        from (select jsonb_build_object(
                                'email', r.reviewer_email,
                                'crash_course', count(*) filter (where r.workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
                                'songs', count(*) filter (where r.workshop_id = '11111111-1111-1111-1111-111111111111')) as x
                              from instructor_reviewer r group by r.reviewer_email) s),
  'pair_total', (select count(*) from instructor_reviewer),
  'trainee_rosters', (select jsonb_object_agg(
                        case when workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' then 'crash_course' else 'songs' end, n)
                      from (select workshop_id, count(*) as n from participant
                             where category = 'participant'
                               and workshop_id in ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','11111111-1111-1111-1111-111111111111')
                             group by workshop_id) t),
  'invitation', (select jsonb_agg(jsonb_build_object(
                    'who', l.who, 'email', l.email, 'role', l.role, 'outcome', l.outcome,
                    'signup_opens', to_char(i.opens_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI UTC')))
                 from tl30_invite_log l
                 left join workshop_invitation i
                   on lower(i.email) = l.email and i.workshop_id = '11111111-1111-1111-1111-111111111111'),
  -- Joshua asked for Mathew and Irene to lose songs-workshop access. They never
  -- had it. This is the count that must stay at zero.
  'angeline', (select jsonb_build_object(
      'display_name', p.display_name, 'email', p.primary_email,
      'headline', pr.headline, 'pairs', (select count(*) from instructor_reviewer r
                                          where r.reviewer_email = p.primary_email))
    from person p left join person_profile pr on pr.person_id = p.id
   where p.id = '30600000-0000-4000-8000-000000000002'),
  'mathew_irene_songs_memberships', (select count(*) from workshop_member m
                                     join app_user u on u.id = m.app_user_id
                                     where m.workshop_id = '11111111-1111-1111-1111-111111111111'
                                       and lower(u.email) in ('mathewtperumal@gmail.com','irene@sall.com'))
));
