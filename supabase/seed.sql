-- Cairn seed: the Psalms Workshop (OBT CDT Workshop 3, Bali, 24 Aug – 4 Sep 2026).
-- Idempotent via fixed UUIDs + on conflict do nothing. Apply after 0001_foundation_schema.sql.
-- KSA content is the real 6-area framework from the Psalms Workshop plan. The 0–3
-- evidence_levels are DRAFT scaffolding derived from each Skill statement, pending
-- facilitator authoring. Participants/teams are placeholders (real CIT roster TBD).

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

-- Participants (placeholder CITs)
insert into participant (id, workshop_id, name, registered_email, team_id, preferred_language) values
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'CIT One',   'cit1@example.org', '22222222-0000-0000-0000-000000000001', 'English'),
  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'CIT Two',   'cit2@example.org', '22222222-0000-0000-0000-000000000001', 'English'),
  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'CIT Three', 'cit3@example.org', '22222222-0000-0000-0000-000000000002', 'English'),
  ('33333333-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'CIT Four',  'cit4@example.org', '22222222-0000-0000-0000-000000000002', 'English')
on conflict (id) do nothing;

-- Activities (afternoon practicums + Week 2 checking = the primary evaluation windows)
insert into activity (id, workshop_id, title, day, start_time, end_time, sort_order, genre_group) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Genre Repertoire Mapping with MTTs', '2026-08-24', '2026-08-24T14:00:00+08', '2026-08-24T17:00:00+08', 1, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Scripture Goals, Genre Matching & Feature Analysis (Psalm 1)', '2026-08-25', '2026-08-25T14:00:00+08', '2026-08-25T17:00:00+08', 2, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Facilitating MTT Internalization & Crafting (Psalm 1)', '2026-08-26', '2026-08-26T14:00:00+08', '2026-08-26T17:00:00+08', 3, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Psalm 1 Refinement & Psalm 13 Initiation', '2026-08-27', '2026-08-27T14:00:00+08', '2026-08-27T17:00:00+08', 4, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Psalm 1 Refinement & Psalm 13 Group Exegesis/Internalization', '2026-08-28', '2026-08-28T14:00:00+08', '2026-08-28T17:00:00+08', 5, 'Week 1 · Practicum'),
  ('44444444-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Community Check of Psalm 1', '2026-08-31', '2026-08-31T14:00:00+08', '2026-08-31T17:00:00+08', 6, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'Consultant Check of Psalm 1', '2026-09-01', '2026-09-01T14:00:00+08', '2026-09-01T17:00:00+08', 7, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'Checking & Revising Psalm 13 (full day)', '2026-09-02', '2026-09-02T09:00:00+08', '2026-09-02T16:00:00+08', 8, 'Week 2 · Checking'),
  ('44444444-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'Integration Conversations (CLAT Step 7) & APPLY with Artists', '2026-09-04', '2026-09-04T09:00:00+08', '2026-09-04T12:00:00+08', 9, 'Week 2 · Integration')
on conflict (id) do nothing;

-- KSAs (the 6 Psalms Workshop areas; evidence_levels are DRAFT 0–3 scaffolding)
insert into ksa (id, code, area, description, evaluator_facing_prompt, ai_facing_rubric, evidence_levels, cbc_subpoint_refs) values
  ('55555555-0000-0000-0000-000000000001', 'CLAT', 'The CLAT Process and Translation of Aesthetic Language',
   'Knows the Creating Local Arts Together (CLAT) conversations and how to adapt them as a workflow for translating aesthetic portions of Scripture using the macro translation principles for aesthetic language.',
   'CLAT facilitation: are they leading the conversations well and producing a draft that is both faithful and excellent in the local genre?',
   'Knowledge: knows the CLAT conversations and how they adapt into a workflow for translating aesthetic Scripture via the macro principles. Attitude: values CLAT as a disciplined, community-rooted process; trusts local artists as essential partners; committed to capturing aesthetic qualities because they shape emotion, identity, worship, and clarity of meaning. Skill: can lead a team and local artists through a contextualized CLAT process and facilitate translating Psalms into a functionally matched local genre with attention to both fidelity and genre excellence. Evaluation: quality of CLAT facilitation with MTTs/artists, how the Psalm 1 and 13 drafts function as both faithful renderings and excellent genre examples (esp. at community check and mentored consulting), and clarity of documented reasoning.',
   '{"0":"Cannot lead the CLAT conversations; drafts ignore source fidelity or genre.","1":"Leads parts with heavy support; draft weak on fidelity or on genre excellence.","2":"Leads the CLAT conversations competently; draft is faithful and fits the genre.","3":"Leads fluently; draft is faithful AND an excellent example of the local genre, with clear documented reasoning."}',
   array['Guiding Translation Teams','Translation Practice','Adult Education']),
  ('55555555-0000-0000-0000-000000000002', 'AESTH', 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
   'Knows that aesthetic language is a universal human phenomenon for sacred, identity-forming, and emotionally significant content; knows ethnopoetics as the framework; knows the role and functions of aesthetic language in the Hebrew Bible and wider ancient Near East.',
   'Aesthetic language / ethnopoetics: can they explain it and articulate its biblical and ANE social/theological function?',
   'Knowledge: aesthetic language as universal; ethnopoetics as the study framework; its central role and social/theological functions in the Hebrew Bible and ancient Near East. Attitude: holds aesthetic language in high regard as a divinely sanctioned means of forming identity, shaping emotion, and passing on sacred knowledge. Skill: can describe aesthetic language and ethnopoetics in their own words, identify aesthetic passages across Scripture, and articulate the functions these forms served. Evaluation: how well they explain ethnopoetics and the role of aesthetic language, and how that foundation informs their MTT interactions.',
   '{"0":"Cannot describe aesthetic language / ethnopoetics or its biblical function.","1":"Partial or vague grasp; struggles to connect it to Scripture / the ANE.","2":"Explains ethnopoetics and the biblical/ANE function clearly.","3":"Explains fluently and uses the framework to inform interactions with the MTTs."}',
   array['Hermeneutics','Modes of Communication']),
  ('55555555-0000-0000-0000-000000000003', 'GENRE', 'Genre Theory, Discovery, and Matching',
   'Knows that every culture has a repertoire of genres with distinct functions, features, and norms; knows the principal Psalm genres and genre theory as a tool for discovering genres in a community and matching them across languages for faithful translation.',
   'Genre work: good culturally-appropriate mapping questions, sound feature analysis, and a convincing functional match?',
   'Knowledge: every culture has a genre repertoire (functions, features, norms); principal Psalm genres; genre theory for discovery and cross-language matching. Attitude: approaches local genres with genuine appreciation as rich resources, committed to functional matches rather than forcing biblical forms. Skill: can ask culturally appropriate questions to map a community genre repertoire, identify functions/features of psalm and candidate local genres, and reason convincingly about why a local genre is a faithful functional match. Evaluation: quality of the genre-mapping facilitation, coherence of feature documentation, and how well-reasoned the proposed matches are.',
   '{"0":"Cannot map or match genres; forces biblical forms onto local ones.","1":"Maps with heavy prompting; matching reasoning is thin.","2":"Maps the repertoire, analyzes features, proposes a sound functional match.","3":"Facilitates rich mapping; feature analysis is coherent; the match argument is convincing and well-documented."}',
   array['Guiding Translation Teams','Modes of Communication','Multicultural Environment']),
  ('55555555-0000-0000-0000-000000000004', 'EXEG', 'Psalms Exegesis and Internalization',
   'Knows the exegesis of Psalms 1 and 13 (genre, structure, rhetorical features, theology) and relevant Hebrew poetic conventions; knows the internalization frameworks from earlier workshops (the Four Es and SENSES).',
   'Exegesis/internalization: deep personal internalization, and skilled facilitation of MTT internalization using the Four Es / SENSES?',
   'Knowledge: exegesis of Psalms 1 and 13 (genre, structure, rhetoric, theology); relevant Hebrew poetic conventions; internalization frameworks (Four Es, SENSES). Attitude: treats exegesis as the foundation for faithful translation and internalization as the essential bridge to drafting; does not rush either. Skill: can exegete and internalize a psalm deeply, facilitate internalization for an MTT using the frameworks, and draw on Scripture-as-Resources, spoken English Bible materials, FIA materials, and AI exegetical tools. Evaluation: depth of demonstrated internalization, effectiveness facilitating MTT internalization per best practices, and use of exegetical resources. A pre-workshop exegetical write-up, if assigned, is a baseline indicator (not pass/fail).',
   '{"0":"Exegesis / internalization absent or superficial.","1":"Some exegesis; internalization shallow or facilitation weak.","2":"Solid personal internalization; facilitates MTT internalization per the frameworks.","3":"Deep internalization; facilitates skillfully using the Four Es / SENSES and the exegetical resources."}',
   array['Hermeneutics','Translation Practice']),
  ('55555555-0000-0000-0000-000000000005', 'CHECK', 'Checking Artistic Translations',
   'Knows best practices for community and consultant checking of artistic translations, how to ask open-ended and inferential questions suited to aesthetic content, and the framework of the Concise Handbook on the Consultant Checking Conversation.',
   'Checking: good consulting questions/plan; humble, skilled facilitation leading from issue identification through resolution?',
   'Knowledge: best practices for community and consultant checking of artistic translations; open-ended/inferential questions for aesthetic content; the Concise Handbook framework as shared vocabulary. Attitude: treats checking as collaborative, humble, servant-hearted (not adversarial or purely technical); recognizes MTTs/artists as co-laborers. Skill: can prepare consulting questions and plans suited to the genre/content, facilitate community and consultant checking, lead a conversation from issue identification to resolution, and give/receive peer feedback. Evaluation: quality of preparation and execution of the Psalm 1 and 13 checks, quality of consulting questions, peer reports, and facilitator observation notes.',
   '{"0":"No usable consulting questions/plan; cannot lead a check.","1":"Questions/plan thin; leads only with support.","2":"Prepares suitable questions/plan; facilitates community and consultant checks competently.","3":"Excellent questions/plan; leads from issue identification through resolution with humility and skill."}',
   array['Consulting Process Skills','Translation Practice','Interpersonal Skills']),
  ('55555555-0000-0000-0000-000000000006', 'ADVOC', 'Advocacy and Community Integration',
   'Knows how to build a case for local-genre Scripture translation (genre theory, ethnopoetics, the social function of aesthetic language, examples from Scripture and the stakeholders’ own milieu) and how to develop a plan for integrating artistic translations into communities.',
   'Advocacy/integration: compelling inductive case for why a local-art-form psalm is still faithful, and a realistic integration plan?',
   'Knowledge: how to build a case for local-genre Scripture translation using genre theory, ethnopoetics, the social function of aesthetic language, and scriptural/cultural examples; the rationale and plan for community integration. Attitude: embraces the ambassador role for faithful local-genre translation (which makes meaning clearer, not obscured); values community integration and Scripture impact as the goal. Skill: can make a compelling, inductively framed case to community leaders that a psalm in a local art form is still a faithful translation, and can work with artists/MTTs on a realistic integration plan with follow-up. Evaluation: clarity of the case and the realism, cultural sensitivity, and scope of the integration plans produced.',
   '{"0":"Cannot make the case; integration plan absent.","1":"Case is weak; plan is unrealistic.","2":"Makes a clear case; produces a realistic integration plan.","3":"Compelling inductive case; culturally sensitive, well-scoped plan with follow-up."}',
   array['Interpersonal Skills','Multicultural Environment','Adult Education'])
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
  ('44444444-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000001', 2)
on conflict (activity_id, ksa_id) do nothing;
