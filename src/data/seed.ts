import type { Activity, ActivityKsa, Ksa, Participant, Team, Workshop } from '../lib/types'

// Local mirror of supabase/seed.sql, used when Supabase is not configured so the
// foundation app is demoable offline. Keep in sync with seed.sql if you change either.
//
// Content is the real KSA framework from the Psalms Workshop plan (OBT CDT
// Workshop 3, Bali, 24 Aug – 4 Sep 2026). The 0–3 evidence_levels are DRAFT
// scaffolding derived from each Skill statement, pending facilitator authoring.
// Participants/teams are placeholders (the real CIT roster is TBD).

export const seedWorkshops: Workshop[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Psalms Workshop — OBT CDT Workshop 3 (Bali 2026)',
    start_date: '2026-08-24',
    end_date: '2026-09-04',
    location: 'Bali, Indonesia',
    languages: ['English'],
  },
]

export const seedTeams: Team[] = [
  { id: '22222222-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, name: 'Music Team A' },
  { id: '22222222-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, name: 'Music Team B' },
]

// Placeholder consultants-in-training (CITs); replace with the real roster.
export const seedParticipants: Participant[] = [
  { id: '33333333-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, name: 'CIT One', registered_email: 'cit1@example.org', team_id: seedTeams[0].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, name: 'CIT Two', registered_email: 'cit2@example.org', team_id: seedTeams[0].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, name: 'CIT Three', registered_email: 'cit3@example.org', team_id: seedTeams[1].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000004', workshop_id: seedWorkshops[0].id, name: 'CIT Four', registered_email: 'cit4@example.org', team_id: seedTeams[1].id, preferred_language: 'English' },
]

// Afternoon practicums + Week 2 checking are the primary evaluation windows.
export const seedActivities: Activity[] = [
  { id: '44444444-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, title: 'Genre Repertoire Mapping with MTTs', day: '2026-08-24', start_time: '2026-08-24T14:00:00+08:00', end_time: '2026-08-24T17:00:00+08:00', sort_order: 1, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, title: 'Scripture Goals, Genre Matching & Feature Analysis (Psalm 1)', day: '2026-08-25', start_time: '2026-08-25T14:00:00+08:00', end_time: '2026-08-25T17:00:00+08:00', sort_order: 2, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, title: 'Facilitating MTT Internalization & Crafting (Psalm 1)', day: '2026-08-26', start_time: '2026-08-26T14:00:00+08:00', end_time: '2026-08-26T17:00:00+08:00', sort_order: 3, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000004', workshop_id: seedWorkshops[0].id, title: 'Psalm 1 Refinement & Psalm 13 Initiation', day: '2026-08-27', start_time: '2026-08-27T14:00:00+08:00', end_time: '2026-08-27T17:00:00+08:00', sort_order: 4, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000005', workshop_id: seedWorkshops[0].id, title: 'Psalm 1 Refinement & Psalm 13 Group Exegesis/Internalization', day: '2026-08-28', start_time: '2026-08-28T14:00:00+08:00', end_time: '2026-08-28T17:00:00+08:00', sort_order: 5, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000006', workshop_id: seedWorkshops[0].id, title: 'Community Check of Psalm 1', day: '2026-08-31', start_time: '2026-08-31T14:00:00+08:00', end_time: '2026-08-31T17:00:00+08:00', sort_order: 6, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000007', workshop_id: seedWorkshops[0].id, title: 'Consultant Check of Psalm 1', day: '2026-09-01', start_time: '2026-09-01T14:00:00+08:00', end_time: '2026-09-01T17:00:00+08:00', sort_order: 7, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000008', workshop_id: seedWorkshops[0].id, title: 'Checking & Revising Psalm 13 (full day)', day: '2026-09-02', start_time: '2026-09-02T09:00:00+08:00', end_time: '2026-09-02T16:00:00+08:00', sort_order: 8, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000009', workshop_id: seedWorkshops[0].id, title: 'Integration Conversations (CLAT Step 7) & APPLY with Artists', day: '2026-09-04', start_time: '2026-09-04T09:00:00+08:00', end_time: '2026-09-04T12:00:00+08:00', sort_order: 9, genre_group: 'Week 2 · Integration' },
]

export const seedKsas: Ksa[] = [
  {
    id: '55555555-0000-0000-0000-000000000001',
    code: 'CLAT',
    area: 'The CLAT Process and Translation of Aesthetic Language',
    description:
      'Knows the Creating Local Arts Together (CLAT) conversations and how to adapt them as a workflow for translating aesthetic portions of Scripture using the macro translation principles for aesthetic language.',
    evaluator_facing_prompt: 'CLAT facilitation: are they leading the conversations well and producing a draft that is both faithful and excellent in the local genre?',
    ai_facing_rubric:
      'Knowledge: knows the CLAT conversations and how they adapt into a workflow for translating aesthetic Scripture via the macro principles. Attitude: values CLAT as a disciplined, community-rooted process; trusts local artists as essential partners; committed to capturing aesthetic qualities because they shape emotion, identity, worship, and clarity of meaning. Skill: can lead a team and local artists through a contextualized CLAT process and facilitate translating Psalms into a functionally matched local genre with attention to both fidelity and genre excellence. Evaluation: quality of CLAT facilitation with MTTs/artists, how the Psalm 1 and 13 drafts function as both faithful renderings and excellent genre examples (esp. at community check and mentored consulting), and clarity of documented reasoning.',
    evidence_levels: {
      '0': 'Cannot lead the CLAT conversations; drafts ignore source fidelity or genre.',
      '1': 'Leads parts with heavy support; draft weak on fidelity or on genre excellence.',
      '2': 'Leads the CLAT conversations competently; draft is faithful and fits the genre.',
      '3': 'Leads fluently; draft is faithful AND an excellent example of the local genre, with clear documented reasoning.',
    },
    cbc_subpoint_refs: ['Guiding Translation Teams', 'Translation Practice', 'Adult Education'],
  },
  {
    id: '55555555-0000-0000-0000-000000000002',
    code: 'AESTH',
    area: 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
    description:
      'Knows that aesthetic language is a universal human phenomenon for sacred, identity-forming, and emotionally significant content; knows ethnopoetics as the framework; knows the role and functions of aesthetic language in the Hebrew Bible and wider ancient Near East.',
    evaluator_facing_prompt: 'Aesthetic language / ethnopoetics: can they explain it and articulate its biblical and ANE social/theological function?',
    ai_facing_rubric:
      'Knowledge: aesthetic language as universal; ethnopoetics as the study framework; its central role and social/theological functions in the Hebrew Bible and ancient Near East. Attitude: holds aesthetic language in high regard as a divinely sanctioned means of forming identity, shaping emotion, and passing on sacred knowledge. Skill: can describe aesthetic language and ethnopoetics in their own words, identify aesthetic passages across Scripture, and articulate the functions these forms served. Evaluation: how well they explain ethnopoetics and the role of aesthetic language, and how that foundation informs their MTT interactions.',
    evidence_levels: {
      '0': 'Cannot describe aesthetic language / ethnopoetics or its biblical function.',
      '1': 'Partial or vague grasp; struggles to connect it to Scripture / the ANE.',
      '2': 'Explains ethnopoetics and the biblical/ANE function clearly.',
      '3': 'Explains fluently and uses the framework to inform interactions with the MTTs.',
    },
    cbc_subpoint_refs: ['Hermeneutics', 'Modes of Communication'],
  },
  {
    id: '55555555-0000-0000-0000-000000000003',
    code: 'GENRE',
    area: 'Genre Theory, Discovery, and Matching',
    description:
      'Knows that every culture has a repertoire of genres with distinct functions, features, and norms; knows the principal Psalm genres and genre theory as a tool for discovering genres in a community and matching them across languages for faithful translation.',
    evaluator_facing_prompt: 'Genre work: good culturally-appropriate mapping questions, sound feature analysis, and a convincing functional match?',
    ai_facing_rubric:
      'Knowledge: every culture has a genre repertoire (functions, features, norms); principal Psalm genres; genre theory for discovery and cross-language matching. Attitude: approaches local genres with genuine appreciation as rich resources, committed to functional matches rather than forcing biblical forms. Skill: can ask culturally appropriate questions to map a community genre repertoire, identify functions/features of psalm and candidate local genres, and reason convincingly about why a local genre is a faithful functional match. Evaluation: quality of the genre-mapping facilitation, coherence of feature documentation, and how well-reasoned the proposed matches are.',
    evidence_levels: {
      '0': 'Cannot map or match genres; forces biblical forms onto local ones.',
      '1': 'Maps with heavy prompting; matching reasoning is thin.',
      '2': 'Maps the repertoire, analyzes features, proposes a sound functional match.',
      '3': 'Facilitates rich mapping; feature analysis is coherent; the match argument is convincing and well-documented.',
    },
    cbc_subpoint_refs: ['Guiding Translation Teams', 'Modes of Communication', 'Multicultural Environment'],
  },
  {
    id: '55555555-0000-0000-0000-000000000004',
    code: 'EXEG',
    area: 'Psalms Exegesis and Internalization',
    description:
      'Knows the exegesis of Psalms 1 and 13 (genre, structure, rhetorical features, theology) and relevant Hebrew poetic conventions; knows the internalization frameworks from earlier workshops (the Four Es and SENSES).',
    evaluator_facing_prompt: 'Exegesis/internalization: deep personal internalization, and skilled facilitation of MTT internalization using the Four Es / SENSES?',
    ai_facing_rubric:
      'Knowledge: exegesis of Psalms 1 and 13 (genre, structure, rhetoric, theology); relevant Hebrew poetic conventions; internalization frameworks (Four Es, SENSES). Attitude: treats exegesis as the foundation for faithful translation and internalization as the essential bridge to drafting; does not rush either. Skill: can exegete and internalize a psalm deeply, facilitate internalization for an MTT using the frameworks, and draw on Scripture-as-Resources, spoken English Bible materials, FIA materials, and AI exegetical tools. Evaluation: depth of demonstrated internalization, effectiveness facilitating MTT internalization per best practices, and use of exegetical resources. A pre-workshop exegetical write-up, if assigned, is a baseline indicator (not pass/fail).',
    evidence_levels: {
      '0': 'Exegesis / internalization absent or superficial.',
      '1': 'Some exegesis; internalization shallow or facilitation weak.',
      '2': 'Solid personal internalization; facilitates MTT internalization per the frameworks.',
      '3': 'Deep internalization; facilitates skillfully using the Four Es / SENSES and the exegetical resources.',
    },
    cbc_subpoint_refs: ['Hermeneutics', 'Translation Practice'],
  },
  {
    id: '55555555-0000-0000-0000-000000000005',
    code: 'CHECK',
    area: 'Checking Artistic Translations',
    description:
      'Knows best practices for community and consultant checking of artistic translations, how to ask open-ended and inferential questions suited to aesthetic content, and the framework of the Concise Handbook on the Consultant Checking Conversation.',
    evaluator_facing_prompt: 'Checking: good consulting questions/plan; humble, skilled facilitation leading from issue identification through resolution?',
    ai_facing_rubric:
      'Knowledge: best practices for community and consultant checking of artistic translations; open-ended/inferential questions for aesthetic content; the Concise Handbook framework as shared vocabulary. Attitude: treats checking as collaborative, humble, servant-hearted (not adversarial or purely technical); recognizes MTTs/artists as co-laborers. Skill: can prepare consulting questions and plans suited to the genre/content, facilitate community and consultant checking, lead a conversation from issue identification to resolution, and give/receive peer feedback. Evaluation: quality of preparation and execution of the Psalm 1 and 13 checks, quality of consulting questions, peer reports, and facilitator observation notes.',
    evidence_levels: {
      '0': 'No usable consulting questions/plan; cannot lead a check.',
      '1': 'Questions/plan thin; leads only with support.',
      '2': 'Prepares suitable questions/plan; facilitates community and consultant checks competently.',
      '3': 'Excellent questions/plan; leads from issue identification through resolution with humility and skill.',
    },
    cbc_subpoint_refs: ['Consulting Process Skills', 'Translation Practice', 'Interpersonal Skills'],
  },
  {
    id: '55555555-0000-0000-0000-000000000006',
    code: 'ADVOC',
    area: 'Advocacy and Community Integration',
    description:
      'Knows how to build a case for local-genre Scripture translation (genre theory, ethnopoetics, the social function of aesthetic language, examples from Scripture and the stakeholders’ own milieu) and how to develop a plan for integrating artistic translations into communities.',
    evaluator_facing_prompt: 'Advocacy/integration: compelling inductive case for why a local-art-form psalm is still faithful, and a realistic integration plan?',
    ai_facing_rubric:
      'Knowledge: how to build a case for local-genre Scripture translation using genre theory, ethnopoetics, the social function of aesthetic language, and scriptural/cultural examples; the rationale and plan for community integration. Attitude: embraces the ambassador role for faithful local-genre translation (which makes meaning clearer, not obscured); values community integration and Scripture impact as the goal. Skill: can make a compelling, inductively framed case to community leaders that a psalm in a local art form is still a faithful translation, and can work with artists/MTTs on a realistic integration plan with follow-up. Evaluation: clarity of the case and the realism, cultural sensitivity, and scope of the integration plans produced.',
    evidence_levels: {
      '0': 'Cannot make the case; integration plan absent.',
      '1': 'Case is weak; plan is unrealistic.',
      '2': 'Makes a clear case; produces a realistic integration plan.',
      '3': 'Compelling inductive case; culturally sensitive, well-scoped plan with follow-up.',
    },
    cbc_subpoint_refs: ['Interpersonal Skills', 'Multicultural Environment', 'Adult Education'],
  },
]

// Links from the document's "KSAs addressed" notes for each afternoon/activity.
export const seedActivityKsas: ActivityKsa[] = [
  // Genre Repertoire Mapping -> Genre, Aesthetic
  { activity_id: seedActivities[0].id, ksa_id: seedKsas[2].id, sort_order: 1 },
  { activity_id: seedActivities[0].id, ksa_id: seedKsas[1].id, sort_order: 2 },
  // Scripture Goals / Matching / Feature Analysis (Psalm 1) -> CLAT, Genre
  { activity_id: seedActivities[1].id, ksa_id: seedKsas[0].id, sort_order: 1 },
  { activity_id: seedActivities[1].id, ksa_id: seedKsas[2].id, sort_order: 2 },
  // Internalization & Crafting (Psalm 1) -> CLAT, Exegesis
  { activity_id: seedActivities[2].id, ksa_id: seedKsas[0].id, sort_order: 1 },
  { activity_id: seedActivities[2].id, ksa_id: seedKsas[3].id, sort_order: 2 },
  // Psalm 1 Refinement & Psalm 13 Initiation -> CLAT, Genre, Exegesis
  { activity_id: seedActivities[3].id, ksa_id: seedKsas[0].id, sort_order: 1 },
  { activity_id: seedActivities[3].id, ksa_id: seedKsas[2].id, sort_order: 2 },
  { activity_id: seedActivities[3].id, ksa_id: seedKsas[3].id, sort_order: 3 },
  // Psalm 1 Refinement & Psalm 13 group exegesis/internalization -> CLAT, Genre, Exegesis
  { activity_id: seedActivities[4].id, ksa_id: seedKsas[0].id, sort_order: 1 },
  { activity_id: seedActivities[4].id, ksa_id: seedKsas[2].id, sort_order: 2 },
  { activity_id: seedActivities[4].id, ksa_id: seedKsas[3].id, sort_order: 3 },
  // Community Check of Psalm 1 -> Checking
  { activity_id: seedActivities[5].id, ksa_id: seedKsas[4].id, sort_order: 1 },
  // Consultant Check of Psalm 1 -> Checking
  { activity_id: seedActivities[6].id, ksa_id: seedKsas[4].id, sort_order: 1 },
  // Checking & Revising Psalm 13 -> Checking, Exegesis
  { activity_id: seedActivities[7].id, ksa_id: seedKsas[4].id, sort_order: 1 },
  { activity_id: seedActivities[7].id, ksa_id: seedKsas[3].id, sort_order: 2 },
  // Integration & APPLY -> Advocacy, CLAT
  { activity_id: seedActivities[8].id, ksa_id: seedKsas[5].id, sort_order: 1 },
  { activity_id: seedActivities[8].id, ksa_id: seedKsas[0].id, sort_order: 2 },
]
