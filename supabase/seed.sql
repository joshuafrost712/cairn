-- Cairn seed: the Psalms Workshop (OBT CDT Workshop 3, Bali, 24 Aug – 4 Sep 2026).
-- Idempotent via fixed UUIDs + on conflict do nothing. Apply after 0001_foundation_schema.sql.
-- KSA content is the real 6-area framework from the Psalms Workshop plan. Evaluator
-- prompts are neutral observation cues, evidence_levels are a single developmental
-- 0–3 progression, and guiding_questions enumerate the sub-dimensions to watch.
-- These are authored drafts for facilitator review. Keep in sync with src/data/seed.ts.
-- Participants are the real Psalms-workshop roster (see src/data/seed.ts).

-- Workshop
insert into workshop (id, name, start_date, end_date, location, languages) values
  ('11111111-1111-1111-1111-111111111111',
   'Psalms Workshop — OBT CDT Workshop 3 (Bali 2026)', '2026-08-24', '2026-09-04', 'Bali, Indonesia',
   array['English'])
on conflict (id) do nothing;

-- Teams
insert into team (id, workshop_id, name) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Music Team A'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Music Team B')
on conflict (id) do nothing;

-- Participants (real Psalms-workshop roster; kept in sync with src/data/seed.ts).
insert into participant (id, workshop_id, name, registered_email, team_id, preferred_language) values
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Keem Leong', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Sajesh Pradhan', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Amos Khokhar', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Mathew Thomas', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Eliphas Mukhim', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Mukesh Kumar Nayak', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'Sunita Kumari', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'Young Whan Song', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'Suelen Campelo', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'Santpaul Singh', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'Anjali Lama', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'Jaime Jill Fianza', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', 'Chula Danuwar', null, '22222222-0000-0000-0000-000000000001', null),
  ('33333333-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', 'Robert Tilton', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000015', '11111111-1111-1111-1111-111111111111', 'Kristina Tarp', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000016', '11111111-1111-1111-1111-111111111111', 'Hiramba Deb Adhikary', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000017', '11111111-1111-1111-1111-111111111111', 'Martin Landert', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000018', '11111111-1111-1111-1111-111111111111', 'Rea Joy Lumawan', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000019', '11111111-1111-1111-1111-111111111111', 'Anna Seidel', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000020', '11111111-1111-1111-1111-111111111111', 'Joemar Cabading', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000021', '11111111-1111-1111-1111-111111111111', 'Rosemary Bolton', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000022', '11111111-1111-1111-1111-111111111111', 'Sibaji Digal', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000023', '11111111-1111-1111-1111-111111111111', 'Tammy Cortimilia', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000024', '11111111-1111-1111-1111-111111111111', 'Raissa Santos', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000025', '11111111-1111-1111-1111-111111111111', 'Chhotray Aind', null, '22222222-0000-0000-0000-000000000002', null),
  ('33333333-0000-0000-0000-000000000026', '11111111-1111-1111-1111-111111111111', 'Bijili K Abraham Kuppackal', null, '22222222-0000-0000-0000-000000000002', null)
on conflict (id) do nothing;

-- Activities. Two evaluation windows per day: morning teaching sessions (interpersonal
-- interaction) and afternoon practicums / Week 2 checking (the KSA competencies).
-- sort_order interleaves so each morning precedes its afternoon; Sep 2 (full-day
-- checking) and Sep 4 (integration) get no separate teaching row.
insert into activity (id, workshop_id, title, day, start_time, end_time, sort_order, genre_group) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Genre Repertoire Mapping with MTTs', '2026-08-24', '2026-08-24T14:00:00+08', '2026-08-24T17:00:00+08', 2, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Scripture Goals, Genre Matching & Feature Analysis (Psalm 1)', '2026-08-25', '2026-08-25T14:00:00+08', '2026-08-25T17:00:00+08', 4, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Facilitating MTT Internalization & Crafting (Psalm 1)', '2026-08-26', '2026-08-26T14:00:00+08', '2026-08-26T17:00:00+08', 6, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Psalm 1 Refinement & Psalm 13 Initiation', '2026-08-27', '2026-08-27T14:00:00+08', '2026-08-27T17:00:00+08', 8, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Psalm 1 Refinement & Psalm 13 Group Exegesis/Internalization', '2026-08-28', '2026-08-28T14:00:00+08', '2026-08-28T17:00:00+08', 10, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Community Check of Psalm 1', '2026-08-31', '2026-08-31T14:00:00+08', '2026-08-31T17:00:00+08', 12, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'Consultant Check of Psalm 1', '2026-09-01', '2026-09-01T14:00:00+08', '2026-09-01T17:00:00+08', 14, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'Checking & Revising Psalm 13 (full day)', '2026-09-02', '2026-09-02T09:00:00+08', '2026-09-02T16:00:00+08', 15, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'Integration Conversations (CLAT Step 7) & APPLY with Artists', '2026-09-04', '2026-09-04T09:00:00+08', '2026-09-04T12:00:00+08', 17, 'Week 2 · Integration'),
  ('44444444-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Opening; Aesthetic Language & Ethnopoetics; Genres in the Psalms', '2026-08-24', '2026-08-24T09:00:00+08', '2026-08-24T12:00:00+08', 1, 'Week 1 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — CLAT Overview', '2026-08-25', '2026-08-25T09:00:00+08', '2026-08-25T12:00:00+08', 3, 'Week 1 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Translating Aesthetic Language; Psalm 1 Exegesis & Internalization', '2026-08-26', '2026-08-26T09:00:00+08', '2026-08-26T12:00:00+08', 5, 'Week 1 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a4', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Psalm 1 Debrief; Psalm 13 Exegesis & Internalization', '2026-08-27', '2026-08-27T09:00:00+08', '2026-08-27T12:00:00+08', 7, 'Week 1 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a5', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Debrief & Q&A; Hebrew Poetry Conventions', '2026-08-28', '2026-08-28T09:00:00+08', '2026-08-28T12:00:00+08', 9, 'Week 1 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a6', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Community & Consultant Checking of Artistic Translations', '2026-08-31', '2026-08-31T09:00:00+08', '2026-08-31T12:00:00+08', 11, 'Week 2 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a7', '11111111-1111-1111-1111-111111111111', 'Morning — Consulting-Question Preparation Block', '2026-09-01', '2026-09-01T09:00:00+08', '2026-09-01T12:00:00+08', 13, 'Week 2 · Teaching'),
  ('44444444-0000-0000-0000-0000000000a8', '11111111-1111-1111-1111-111111111111', 'Morning Teaching — Week 2 Day 4 Session (content TBD)', '2026-09-03', '2026-09-03T09:00:00+08', '2026-09-03T12:00:00+08', 16, 'Week 2 · Teaching')
on conflict (id) do nothing;

-- KSAs (the 6 Psalms Workshop areas). short_label heads the capture card;
-- evaluator_facing_prompt is the observation cue; evidence_levels are a single
-- developmental 0–3 progression; guiding_questions are the sub-dimensions to watch.
insert into ksa (id, code, area, short_label, description, evaluator_facing_prompt, ai_facing_rubric, evidence_levels, cbc_subpoint_refs, guiding_questions) values
  ('55555555-0000-0000-0000-000000000001', 'CLAT', 'The CLAT Process and Translation of Aesthetic Language',
   'CLAT facilitation & drafting',
   'Knows the Creating Local Arts Together (CLAT) conversations and how to adapt them as a workflow for translating aesthetic portions of Scripture using the macro translation principles for aesthetic language.',
   'How did they lead the CLAT conversations, and what did the resulting draft show about fidelity and local-genre excellence?',
   'Knowledge: knows the CLAT conversations and how they adapt into a workflow for translating aesthetic Scripture via the macro principles. Attitude: values CLAT as a disciplined, community-rooted process; trusts local artists as essential partners; committed to capturing aesthetic qualities because they shape emotion, identity, worship, and clarity of meaning. Skill: can lead a team and local artists through a contextualized CLAT process and facilitate translating Psalms into a functionally matched local genre with attention to both fidelity and genre excellence. Evaluation: quality of CLAT facilitation with MTTs/artists, how the Psalm 1 and 13 drafts function as both faithful renderings and excellent genre examples (esp. at community check and mentored consulting), and clarity of documented reasoning.',
   '{"0":"Not yet leading; relies on others to run the CLAT conversations, and the draft loses the source meaning or the genre.","1":"Leads parts with substantial support; the draft is either faithful or genre-fitting, but not yet both.","2":"Leads the conversations independently; the draft is faithful and fits the local genre.","3":"Leads fluently and adapts the process; the draft is faithful and an excellent example of the genre, with reasoning they can articulate."}',
   array['Guiding Translation Teams','Translation Practice','Adult Education'],
   array['Do they move through the CLAT conversations in order, adapting rather than skipping steps?','Does the draft hold the source meaning?','Does the draft sound like a strong example of the local genre, not a flattened one?','Can they explain why they made a given rendering choice?']),
  ('55555555-0000-0000-0000-000000000002', 'AESTH', 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
   'Aesthetic language & ethnopoetics',
   'Knows that aesthetic language is a universal human phenomenon for sacred, identity-forming, and emotionally significant content; knows ethnopoetics as the framework; knows the role and functions of aesthetic language in the Hebrew Bible and wider ancient Near East.',
   'When it came up, how did they explain aesthetic language / ethnopoetics and its function in the Bible and the wider ancient Near East?',
   'Knowledge: aesthetic language as universal; ethnopoetics as the study framework; its central role and social/theological functions in the Hebrew Bible and ancient Near East. Attitude: holds aesthetic language in high regard as a divinely sanctioned means of forming identity, shaping emotion, and passing on sacred knowledge. Skill: can describe aesthetic language and ethnopoetics in their own words, identify aesthetic passages across Scripture, and articulate the functions these forms served. Evaluation: how well they explain ethnopoetics and the role of aesthetic language, and how that foundation informs their MTT interactions.',
   '{"0":"Cannot yet describe aesthetic language or ethnopoetics, or treats it as mere decoration.","1":"Partial or vague grasp; struggles to tie it to Scripture or the ancient Near East.","2":"Explains ethnopoetics and the biblical / ANE function clearly.","3":"Explains it fluently and lets that framework shape how they guide the MTTs."}',
   array['Hermeneutics','Modes of Communication'],
   array['Can they explain, in their own words, what aesthetic language and ethnopoetics are?','Do they connect aesthetic forms to their function in Scripture and the ancient Near East?','Do they treat aesthetic language as load-bearing meaning, or as decoration to strip away?']),
  ('55555555-0000-0000-0000-000000000003', 'GENRE', 'Genre Theory, Discovery, and Matching',
   'Genre mapping & matching',
   'Knows that every culture has a repertoire of genres with distinct functions, features, and norms; knows the principal Psalm genres and genre theory as a tool for discovering genres in a community and matching them across languages for faithful translation.',
   'How did they map the community''s genres and reason toward a functional match for the psalm?',
   'Knowledge: every culture has a genre repertoire (functions, features, norms); principal Psalm genres; genre theory for discovery and cross-language matching. Attitude: approaches local genres with genuine appreciation as rich resources, committed to functional matches rather than forcing biblical forms. Skill: can ask culturally appropriate questions to map a community genre repertoire, identify functions/features of psalm and candidate local genres, and reason convincingly about why a local genre is a faithful functional match. Evaluation: quality of the genre-mapping facilitation, coherence of feature documentation, and how well-reasoned the proposed matches are.',
   '{"0":"Cannot yet map or match genres, or forces biblical forms onto local ones.","1":"Maps with heavy prompting; the matching reasoning is thin.","2":"Maps the repertoire, analyzes features, and proposes a sound functional match.","3":"Draws out a rich map; feature analysis is coherent and the match argument is convincing and documented."}',
   array['Guiding Translation Teams','Modes of Communication','Multicultural Environment'],
   array['Are their mapping questions open-ended and culturally appropriate?','Do they name the function of each local genre, not just its form?','Do they look for a true functional match rather than forcing a biblical form?','Is the proposed psalm-to-genre match well reasoned?']),
  ('55555555-0000-0000-0000-000000000004', 'EXEG', 'Psalms Exegesis and Internalization',
   'Exegesis & internalization',
   'Knows the exegesis of Psalms 1 and 13 (genre, structure, rhetorical features, theology) and relevant Hebrew poetic conventions; knows the internalization frameworks from earlier workshops (the Four Es and SENSES).',
   'How deeply have they internalized the psalm themselves, and how did they facilitate the MTT''s internalization?',
   'Knowledge: exegesis of Psalms 1 and 13 (genre, structure, rhetoric, theology); relevant Hebrew poetic conventions; internalization frameworks (Four Es, SENSES). Attitude: treats exegesis as the foundation for faithful translation and internalization as the essential bridge to drafting; does not rush either. Skill: can exegete and internalize a psalm deeply, facilitate internalization for an MTT using the frameworks, and draw on Scripture-as-Resources, spoken English Bible materials, FIA materials, and AI exegetical tools. Evaluation: depth of demonstrated internalization, effectiveness facilitating MTT internalization per best practices, and use of exegetical resources. A pre-workshop exegetical write-up, if assigned, is a baseline indicator (not pass/fail).',
   '{"0":"Exegesis / internalization is absent or surface-level.","1":"Some exegesis, but internalization is shallow or the facilitation is weak.","2":"Solid personal internalization; facilitates MTT internalization using the frameworks.","3":"Deep internalization; facilitates skillfully with the Four Es / SENSES and the exegetical resources."}',
   array['Hermeneutics','Translation Practice'],
   array['How deep is their own internalization of the psalm (recall, feeling, understanding)?','Do they facilitate MTT internalization (Four Es / SENSES) before any drafting?','Do they let internalization happen first, or rush to a draft?','Do they draw on exegetical resources (Scripture-as-Resources, FIA, AI tools)?']),
  ('55555555-0000-0000-0000-000000000005', 'CHECK', 'Checking Artistic Translations',
   'Checking facilitation',
   'Knows best practices for community and consultant checking of artistic translations, how to ask open-ended and inferential questions suited to aesthetic content, and the framework of the Concise Handbook on the Consultant Checking Conversation.',
   'How did they prepare and lead the check, from their consulting questions through the move from issue to resolution?',
   'Knowledge: best practices for community and consultant checking of artistic translations; open-ended/inferential questions for aesthetic content; the Concise Handbook framework as shared vocabulary. Attitude: treats checking as collaborative, humble, servant-hearted (not adversarial or purely technical); recognizes MTTs/artists as co-laborers. Skill: can prepare consulting questions and plans suited to the genre/content, facilitate community and consultant checking, lead a conversation from issue identification to resolution, and give/receive peer feedback. Evaluation: quality of preparation and execution of the Psalm 1 and 13 checks, quality of consulting questions, peer reports, and facilitator observation notes.',
   '{"0":"No usable consulting questions or plan; cannot yet lead a check.","1":"Questions or plan are thin; leads only with support.","2":"Prepares suitable questions and a plan; facilitates community and consultant checks competently.","3":"Strong questions and plan; leads from issue to resolution with humility and skill."}',
   array['Consulting Process Skills','Translation Practice','Interpersonal Skills'],
   array['Are their consulting questions open-ended and inferential, suited to a song?','Do they lead from naming an issue to a resolution the team owns?','Is their posture humble and collaborative rather than adversarial?','Do they give and receive peer feedback well?']),
  ('55555555-0000-0000-0000-000000000006', 'ADVOC', 'Advocacy and Community Integration',
   'Advocacy & integration',
   'Knows how to build a case for local-genre Scripture translation (genre theory, ethnopoetics, the social function of aesthetic language, examples from Scripture and the stakeholders’ own milieu) and how to develop a plan for integrating artistic translations into communities.',
   'How did they make the case for a local-genre psalm, and how realistic is their integration plan?',
   'Knowledge: how to build a case for local-genre Scripture translation using genre theory, ethnopoetics, the social function of aesthetic language, and scriptural/cultural examples; the rationale and plan for community integration. Attitude: embraces the ambassador role for faithful local-genre translation (which makes meaning clearer, not obscured); values community integration and Scripture impact as the goal. Skill: can make a compelling, inductively framed case to community leaders that a psalm in a local art form is still a faithful translation, and can work with artists/MTTs on a realistic integration plan with follow-up. Evaluation: clarity of the case and the realism, cultural sensitivity, and scope of the integration plans produced.',
   '{"0":"Cannot yet make the case; no integration plan.","1":"The case is weak; the plan is unrealistic.","2":"Makes a clear case and a realistic integration plan.","3":"Compelling inductive case; a culturally sensitive, well-scoped plan with follow-up."}',
   array['Interpersonal Skills','Multicultural Environment','Adult Education'],
   array['Can they make a compelling, inductive case that a local-art-form psalm is still faithful?','Is their community-integration plan realistic and culturally sensitive?','Do they plan for follow-up, not just a one-time presentation?']),
  ('55555555-0000-0000-0000-000000000007', 'INTERP', 'Interpersonal Interaction and Collaborative Posture',
   'Interpersonal posture & collaboration',
   'Knows that consultant work is fundamentally relational and cross-cultural, and that how one engages fellow CITs, consultants, and instructors — collaboration, humility, and openness to feedback — shapes the work as much as technical skill. Observed in the teaching sessions rather than the practicum.',
   'How did they engage with fellow CITs, consultants, and instructors in this session — their collaboration, humility, openness to feedback, and sensitivity to cross-cultural difference?',
   'Knowledge: understands that consultant and translation work is relational and cross-cultural, and that how one engages colleagues, mentors, and teams shapes outcomes. Attitude: approaches others with openness, collegiality, and a posture of service; treats feedback and correction as collaborative rather than adversarial; genuinely values cultural difference. Skill: collaborates constructively in group learning, gives and receives peer and mentor feedback well, and navigates cross-cultural interaction with sensitivity. Evaluation: observed interpersonal conduct during the teaching sessions — collaboration with peers, interaction with consultants and instructors, humility under correction, and cross-cultural sensitivity. Grounded in the CBC General Core competencies Interpersonal Skills and Multicultural Environment.',
   '{"0":"Disengaged, dismissive, or defensive; talks over others, resists correction, or shows little regard for cross-cultural difference.","1":"Participates unevenly; collaborates when prompted but is guarded about feedback or occasionally inattentive to others'' perspectives or cultural difference.","2":"Engages collegially and with humility; contributes to the group, receives feedback openly, and is attentive to cross-cultural dynamics.","3":"Actively builds the group up; draws others in, gives and receives feedback graciously, and navigates cross-cultural difference with evident sensitivity and service."}',
   array['Interpersonal Skills','Multicultural Environment'],
   array['Do they engage collegially with fellow CITs and consultants, or stay disengaged / dominate the room?','How do they receive feedback and correction from instructors and peers?','Are they attentive and respectful across cultural difference?','Do they contribute to a constructive, servant-hearted group dynamic?'])
on conflict (id) do nothing;

-- Link KSAs to activities (from the document's "KSAs addressed" notes)
insert into activity_ksa (activity_id, ksa_id, sort_order) values
  ('44444444-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000003', 1),
  ('44444444-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000002', 2),
  ('44444444-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000001', 1),
  ('44444444-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000003', 2),
  ('44444444-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000001', 1),
  ('44444444-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000004', 2),
  ('44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000001', 1),
  ('44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000003', 2),
  ('44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000004', 3),
  ('44444444-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000001', 1),
  ('44444444-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000003', 2),
  ('44444444-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000004', 3),
  ('44444444-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 1),
  ('44444444-0000-0000-0000-000000000007', '55555555-0000-0000-0000-000000000005', 1),
  ('44444444-0000-0000-0000-000000000008', '55555555-0000-0000-0000-000000000005', 1),
  ('44444444-0000-0000-0000-000000000008', '55555555-0000-0000-0000-000000000004', 2),
  ('44444444-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000006', 1),
  ('44444444-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000001', 2),
  ('44444444-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a4', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a5', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a6', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a7', '55555555-0000-0000-0000-000000000007', 1),
  ('44444444-0000-0000-0000-0000000000a8', '55555555-0000-0000-0000-000000000007', 1)
on conflict (activity_id, ksa_id) do nothing;
