-- Crash Course roster correction, 2026-08-18 (morning of Day One).
--
-- Joshua's roster as the course actually convened is seven participants:
--   Chhotray Aind, Bijili K Abraham Kuppackal, Jillian Figley, Jael Claybaugh,
--   Micah Limboo, Martin Landert, Rosemary Bolton.
--
-- tl-25 seeded four (Martin, Sibaji, Jael, Micah). This adds the four who are
-- in the room and were not on file. Sibaji Digal is deliberately left in place
-- pending Joshua's call: he holds zero observations, evaluations, mentoring
-- conversations and report assignments, so removing him later is a one-line
-- delete with nothing to cascade.
--
-- Full names, organizations, sex and emails come from the arrivals sheet
-- (docs.google.com/spreadsheets/d/1qPwnAsXg56AfmpKenK0Q6DOvCiGw6YQRrSyKxWMjuBE),
-- Master Roster tab, read 2026-08-18.
--
-- Names are spelled as the Psalms roster and the `person` table already spell
-- them, not as the arrivals sheet's legal-name column, so one human reads the
-- same in both workshops. The sheet's "Rosemary Ann Bolton" is her legal name;
-- her person row and Psalms row are "Rosemary Bolton".
--
-- Idempotent on fixed ids. Scoped to the Crash Course workshop throughout.
-- No DELETE, no unscoped UPDATE.

begin;

-- Jillian Figley is the one of the four with no Psalms participant row and so no
-- `person`. Chhotray, Bijili and Rosemary already have person rows keyed on the
-- same addresses the arrivals sheet gives, created by the Psalms roster load of
-- 2026-08-01, so the link below is the deterministic email basis rather than a
-- name guess.
insert into person (id, display_name, primary_email)
values ('cc600000-0000-4000-8000-000000000003', 'Jillian Figley', 'jillian_figley@sil.org')
on conflict (id) do update set display_name = excluded.display_name,
                               primary_email = excluded.primary_email;

insert into participant (
  id, workshop_id, name, registered_email, category,
  organization, sex, person_id, preferred_language
)
values
  ('cc400000-0000-4000-8000-000000000005',
   '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Chhotray Aind', 'chhotray@twftw.org', 'participant',
   'The Word for the World', 'male',
   (select id from person where primary_email = 'chhotray@twftw.org'),
   'English'),

  ('cc400000-0000-4000-8000-000000000006',
   '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Bijili K Abraham Kuppackal', 'bijili@twftw.org', 'participant',
   'The Word for the World', 'male',
   (select id from person where primary_email = 'bijili@twftw.org'),
   'English'),

  ('cc400000-0000-4000-8000-000000000007',
   '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Jillian Figley', 'jillian_figley@sil.org', 'participant',
   'SIL', null,
   'cc600000-0000-4000-8000-000000000003',
   'English'),

  ('cc400000-0000-4000-8000-000000000008',
   '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Rosemary Bolton', 'rosemary_bolton@wycliffe.org', 'participant',
   'Badan Penerjemahan Alkitab', 'female',
   (select id from person where primary_email = 'rosemary_bolton@wycliffe.org'),
   'English')

on conflict (id) do update set
  name = excluded.name,
  registered_email = excluded.registered_email,
  category = excluded.category,
  organization = excluded.organization,
  sex = excluded.sex,
  person_id = excluded.person_id;

commit;
