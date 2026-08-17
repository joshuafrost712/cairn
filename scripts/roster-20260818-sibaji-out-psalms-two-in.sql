-- Roster corrections, 2026-08-18, second pass. Joshua's calls this morning.
--
-- 1. Sibaji Digal cancelled. Remove him from the CRASH COURSE roster.
--    Verified zero rows before the delete in every table that references him:
--    observation (by id and by name), evaluation.focus_participant_id,
--    mentoring_conversation, report_assignment, instructor_reviewer.
--    His `person` row is deliberately KEPT, so a future OBT-CDT workshop can
--    still find him. His Psalms participant row is deliberately NOT touched;
--    that removal is a separate decision and is not what was asked for.
--
-- 2. Jael Claybaugh and Jillian Figley join the PSALMS roster. Both were
--    already known to this database as Crash Course participants with `person`
--    rows; this is the second workshop on each of their track histories.
--    Jael's absence is the gap tl-25 recorded: the roster load of 2026-08-01
--    left her out pending her details, which arrived on the 3rd and 4th.
--
-- Details from the arrivals sheet, Master Roster tab, read 2026-08-18:
--   Jael Claybaugh    YWAM   CiT (Psalms)                    arr Sun 16 Aug, dep Fri 4 Sep
--   Jillian Figley    SIL    CiT (Crash Course + Psalms)     arr Mon 17 Aug, dep Sun 30 Aug
--
-- Neither is given a team. Every other Psalms participant sits in Music Team A
-- or B, so these two read as unassigned until Joshua places them; a guessed
-- music team is worse than a blank one.
--
-- Idempotent. Every statement scoped to one workshop by id.

begin;

-- 1. Sibaji out of the Crash Course.
delete from participant
where id = 'cc400000-0000-4000-8000-000000000003'
  and workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';

-- 2. Jael and Jillian into Psalms. Ids continue the Psalms roster's own
-- sequence; 27 and 28 are the next free.
insert into participant (
  id, workshop_id, name, registered_email, category,
  organization, sex, person_id, preferred_language
)
values
  ('33333333-0000-0000-0000-000000000027',
   '11111111-1111-1111-1111-111111111111',
   'Jael Claybaugh', 'jael.claybaugh@ywammontana.org', 'participant',
   'YWAM', null,
   'cc600000-0000-4000-8000-000000000001',
   'English'),

  ('33333333-0000-0000-0000-000000000028',
   '11111111-1111-1111-1111-111111111111',
   'Jillian Figley', 'jillian_figley@sil.org', 'participant',
   'SIL', null,
   'cc600000-0000-4000-8000-000000000003',
   'English')

on conflict (id) do update set
  name = excluded.name,
  registered_email = excluded.registered_email,
  category = excluded.category,
  organization = excluded.organization,
  person_id = excluded.person_id;

commit;
