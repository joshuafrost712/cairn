-- Cairn seed: a Bali-shaped OBT Crash Course with placeholder KSA content.
-- Idempotent via fixed UUIDs + on conflict do nothing. Apply after 0001_foundation_schema.sql.
-- KSA wording is PLACEHOLDER, pending authoring of the real rubric content.

-- Workshop
insert into workshop (id, name, start_date, end_date, location, languages) values
  ('11111111-1111-1111-1111-111111111111',
   'OBT Crash Course — Bali 2026', '2026-08-03', '2026-08-07', 'Bali, Indonesia',
   array['English'])
on conflict (id) do nothing;

-- Teams
insert into team (id, workshop_id, name) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Team Alpha'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Team Beta')
on conflict (id) do nothing;

-- Participants
insert into participant (id, workshop_id, name, registered_email, team_id, preferred_language) values
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Asha N.',   'asha@example.org',   '22222222-0000-0000-0000-000000000001', 'English'),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Budi S.',   'budi@example.org',   '22222222-0000-0000-0000-000000000001', 'English'),
  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Carmen R.', 'carmen@example.org', '22222222-0000-0000-0000-000000000002', 'English'),
  ('33333333-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Deepa K.',  'deepa@example.org',  '22222222-0000-0000-0000-000000000002', 'English')
on conflict (id) do nothing;

-- Activities (one sample day)
insert into activity (id, workshop_id, title, day, start_time, end_time, sort_order, genre_group) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Intro to Orality (lesson + discussion)', '2026-08-03', '2026-08-03T09:00:00+08', '2026-08-03T10:30:00+08', 1, 'Foundations'),
  ('44444444-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Team Exegesis Practice', '2026-08-03', '2026-08-03T11:00:00+08', '2026-08-03T12:30:00+08', 2, 'Practice'),
  ('44444444-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Internalization & Drafting Workshop', '2026-08-03', '2026-08-03T14:00:00+08', '2026-08-03T16:00:00+08', 3, 'Practice')
on conflict (id) do nothing;

-- KSAs (one placeholder per area; evidence_levels are 0-3, mapped to CBC sub-points)
insert into ksa (id, code, area, description, evaluator_facing_prompt, ai_facing_rubric, evidence_levels, cbc_subpoint_refs) values
  ('55555555-0000-0000-0000-000000000001', 'ORAL-1', 'Orality',
   'Understands orality as a preference for holistic mental storage, not a lack of literacy.',
   'Orality: do they treat oral methods as a strength, not a deficit?',
   'PLACEHOLDER. Look for language treating oral communication as a valid, preferred mode of holistic storage and recall, rather than framing non-literate contexts as deficient.',
   '{"0":"Frames orality as a deficit / lack of literacy.","1":"Acknowledges orality but defaults to literate assumptions.","2":"Applies oral methods appropriately with some prompting.","3":"Fluently frames and leverages orality as a strength."}',
   array['Modes of Communication','Adult Education']),
  ('55555555-0000-0000-0000-000000000002', 'WORK-1', 'OBT Workflow & Team Composition',
   'Knows the core OBT process steps and the roles on a translation team.',
   'Workflow: can they name the core steps and who does what?',
   'PLACEHOLDER. Evidence of correctly sequencing the OBT workflow and articulating team roles and relationships.',
   '{"0":"Cannot describe the workflow or roles.","1":"Partial / out-of-order understanding.","2":"Mostly correct with minor gaps.","3":"Clear, complete grasp of steps and roles."}',
   array['OBT Process','Team Dynamics']),
  ('55555555-0000-0000-0000-000000000003', 'EXEG-1', 'OBT Exegesis, Internalization, and Drafting',
   'Demonstrates sound exegesis feeding internalization and faithful drafting.',
   'Exegesis/Internalization/Drafting: is the draft faithful and well-internalized?',
   'PLACEHOLDER. Evidence linking exegetical findings to internalization technique to a faithful, natural oral draft.',
   '{"0":"Draft not grounded in exegesis.","1":"Some exegetical grounding, weak internalization.","2":"Faithful draft, internalization mostly solid.","3":"Excellent exegesis-to-draft fidelity and internalization."}',
   array['Hermeneutics','Translation Quality']),
  ('55555555-0000-0000-0000-000000000004', 'INTP-1', 'Interpersonal Interactions',
   'Shows godly, humble, cross-cultural team dynamics under pressure.',
   'Interpersonal: humble, constructive, cross-culturally aware?',
   'PLACEHOLDER. Evidence of humility, constructive conflict handling, and cross-cultural sensitivity during teamwork.',
   '{"0":"Disruptive or dismissive of others.","1":"Inconsistent / passive participation.","2":"Generally collaborative and respectful.","3":"Actively builds the team across cultures."}',
   array['Interpersonal Skills','Cross-Cultural Competence']),
  ('55555555-0000-0000-0000-000000000005', 'TECH-1', 'Technology & Resources',
   'Uses APM, exegetical tools, and FIA resources appropriately.',
   'Technology: do they use the tools/resources effectively?',
   'PLACEHOLDER. Evidence of appropriate, fluent use of the workshop technology and exegetical resources.',
   '{"0":"Avoids or misuses the tools.","1":"Uses tools only with heavy help.","2":"Uses tools competently.","3":"Uses tools fluently and helps others."}',
   array['Tools & Resources'])
on conflict (id) do nothing;

-- Link KSAs to activities (which questions appear under each activity)
insert into activity_ksa (activity_id, ksa_id, sort_order) values
  ('44444444-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', 1),  -- Orality lesson -> ORAL-1
  ('44444444-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000002', 2),  -- + WORK-1
  ('44444444-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000003', 1),  -- Exegesis -> EXEG-1
  ('44444444-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000004', 2),  -- + INTP-1
  ('44444444-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000003', 1),  -- Internalization -> EXEG-1
  ('44444444-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 2)   -- + TECH-1
on conflict (activity_id, ksa_id) do nothing;
