import type { Activity, ActivityKsa, Ksa, Participant, Team, Workshop } from '../lib/types'

// Local mirror of supabase/seed.sql, used when Supabase is not configured so the
// foundation app is demoable offline. Keep in sync with seed.sql if you change either.
//
// Content is the real KSA framework from the Psalms Workshop plan (OBT CDT
// Workshop 3, Bali, 24 Aug – 4 Sep 2026). Evaluator prompts are framed as neutral
// observation cues (not yes/no verdicts), guiding_questions enumerate the
// sub-dimensions to watch, and evidence_levels are a single developmental
// progression (0 = not yet, 3 = fluent/exemplary). These are authored drafts for
// facilitator review, not the earlier mock scaffolding.
// Participants are the real CIT roster from the sign-up form responses (names only; no emails).

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

// Real CIT roster from "OBT Consultant Development Track Workshop 3 - Psalms (Responses)"
// Google Sheets ID: 125K4bY-XPWF1fJcn9XtykEB2-Na48X6JATRibd6QFzc
// Names only; registered_email is null (names are kept in the roster sheet, not here).
export const seedParticipants: Participant[] = [
  { id: '33333333-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, name: 'Keem Leong', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, name: 'Sajesh Pradhan', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, name: 'Amos Khokhar', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000004', workshop_id: seedWorkshops[0].id, name: 'Mathew Thomas', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000005', workshop_id: seedWorkshops[0].id, name: 'Eliphas Mukhim', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000006', workshop_id: seedWorkshops[0].id, name: 'Mukesh Kumar Nayak', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000007', workshop_id: seedWorkshops[0].id, name: 'Sunita Kumari', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000008', workshop_id: seedWorkshops[0].id, name: 'Young Whan Song', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000009', workshop_id: seedWorkshops[0].id, name: 'Suelen Campelo', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000010', workshop_id: seedWorkshops[0].id, name: 'Santpaul Singh', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000011', workshop_id: seedWorkshops[0].id, name: 'Anjali Lama', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000012', workshop_id: seedWorkshops[0].id, name: 'Jaime Jill Fianza', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000013', workshop_id: seedWorkshops[0].id, name: 'Chula Danuwar', registered_email: null, team_id: seedTeams[0].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000014', workshop_id: seedWorkshops[0].id, name: 'Robert Tilton', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000015', workshop_id: seedWorkshops[0].id, name: 'Kristina Tarp', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000016', workshop_id: seedWorkshops[0].id, name: 'Hiramba Deb Adhikary', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000017', workshop_id: seedWorkshops[0].id, name: 'Martin Landert', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000018', workshop_id: seedWorkshops[0].id, name: 'Rea Joy Lumawan', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000019', workshop_id: seedWorkshops[0].id, name: 'Anna Seidel', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000020', workshop_id: seedWorkshops[0].id, name: 'Joemar Cabading', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000021', workshop_id: seedWorkshops[0].id, name: 'Rosemary Bolton', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000022', workshop_id: seedWorkshops[0].id, name: 'Sibaji Digal', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000023', workshop_id: seedWorkshops[0].id, name: 'Tammy Cortimilia', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000024', workshop_id: seedWorkshops[0].id, name: 'Raissa Santos', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000025', workshop_id: seedWorkshops[0].id, name: 'Chhotray Aind', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
  { id: '33333333-0000-0000-0000-000000000026', workshop_id: seedWorkshops[0].id, name: 'Bijili K Abraham Kuppackal', registered_email: null, team_id: seedTeams[1].id, preferred_language: null },
]

// Two evaluation windows per day: the morning teaching sessions (interpersonal
// interaction among CITs, consultants, and instructors) and the afternoon
// practicums / Week 2 checking (the KSA competencies). sort_order interleaves so
// each morning precedes its afternoon; the two days whose mornings are already
// evaluation activities (Sep 2 full-day checking, Sep 4 integration) get no
// separate teaching row.
export const seedActivities: Activity[] = [
  { id: '44444444-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, title: 'Genre Repertoire Mapping with MTTs', day: '2026-08-24', start_time: '2026-08-24T14:00:00+08:00', end_time: '2026-08-24T17:00:00+08:00', sort_order: 2, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, title: 'Scripture Goals, Genre Matching & Feature Analysis (Psalm 1)', day: '2026-08-25', start_time: '2026-08-25T14:00:00+08:00', end_time: '2026-08-25T17:00:00+08:00', sort_order: 4, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, title: 'Facilitating MTT Internalization & Crafting (Psalm 1)', day: '2026-08-26', start_time: '2026-08-26T14:00:00+08:00', end_time: '2026-08-26T17:00:00+08:00', sort_order: 6, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000004', workshop_id: seedWorkshops[0].id, title: 'Psalm 1 Refinement & Psalm 13 Initiation', day: '2026-08-27', start_time: '2026-08-27T14:00:00+08:00', end_time: '2026-08-27T17:00:00+08:00', sort_order: 8, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000005', workshop_id: seedWorkshops[0].id, title: 'Psalm 1 Refinement & Psalm 13 Group Exegesis/Internalization', day: '2026-08-28', start_time: '2026-08-28T14:00:00+08:00', end_time: '2026-08-28T17:00:00+08:00', sort_order: 10, genre_group: 'Week 1 · Practicum' },
  { id: '44444444-0000-0000-0000-000000000006', workshop_id: seedWorkshops[0].id, title: 'Community Check of Psalm 1', day: '2026-08-31', start_time: '2026-08-31T14:00:00+08:00', end_time: '2026-08-31T17:00:00+08:00', sort_order: 12, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000007', workshop_id: seedWorkshops[0].id, title: 'Consultant Check of Psalm 1', day: '2026-09-01', start_time: '2026-09-01T14:00:00+08:00', end_time: '2026-09-01T17:00:00+08:00', sort_order: 14, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000008', workshop_id: seedWorkshops[0].id, title: 'Checking & Revising Psalm 13 (full day)', day: '2026-09-02', start_time: '2026-09-02T09:00:00+08:00', end_time: '2026-09-02T16:00:00+08:00', sort_order: 15, genre_group: 'Week 2 · Checking' },
  { id: '44444444-0000-0000-0000-000000000009', workshop_id: seedWorkshops[0].id, title: 'Integration Conversations (CLAT Step 7) & APPLY with Artists', day: '2026-09-04', start_time: '2026-09-04T09:00:00+08:00', end_time: '2026-09-04T12:00:00+08:00', sort_order: 17, genre_group: 'Week 2 · Integration' },
  // Morning teaching sessions — evaluated on interpersonal interaction (INTERP) only.
  { id: '44444444-0000-0000-0000-0000000000a1', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Opening; Aesthetic Language & Ethnopoetics; Genres in the Psalms', day: '2026-08-24', start_time: '2026-08-24T09:00:00+08:00', end_time: '2026-08-24T12:00:00+08:00', sort_order: 1, genre_group: 'Week 1 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a2', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — CLAT Overview', day: '2026-08-25', start_time: '2026-08-25T09:00:00+08:00', end_time: '2026-08-25T12:00:00+08:00', sort_order: 3, genre_group: 'Week 1 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a3', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Translating Aesthetic Language; Psalm 1 Exegesis & Internalization', day: '2026-08-26', start_time: '2026-08-26T09:00:00+08:00', end_time: '2026-08-26T12:00:00+08:00', sort_order: 5, genre_group: 'Week 1 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a4', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Psalm 1 Debrief; Psalm 13 Exegesis & Internalization', day: '2026-08-27', start_time: '2026-08-27T09:00:00+08:00', end_time: '2026-08-27T12:00:00+08:00', sort_order: 7, genre_group: 'Week 1 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a5', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Debrief & Q&A; Hebrew Poetry Conventions', day: '2026-08-28', start_time: '2026-08-28T09:00:00+08:00', end_time: '2026-08-28T12:00:00+08:00', sort_order: 9, genre_group: 'Week 1 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a6', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Community & Consultant Checking of Artistic Translations', day: '2026-08-31', start_time: '2026-08-31T09:00:00+08:00', end_time: '2026-08-31T12:00:00+08:00', sort_order: 11, genre_group: 'Week 2 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a7', workshop_id: seedWorkshops[0].id, title: 'Morning — Consulting-Question Preparation Block', day: '2026-09-01', start_time: '2026-09-01T09:00:00+08:00', end_time: '2026-09-01T12:00:00+08:00', sort_order: 13, genre_group: 'Week 2 · Teaching' },
  { id: '44444444-0000-0000-0000-0000000000a8', workshop_id: seedWorkshops[0].id, title: 'Morning Teaching — Week 2 Day 4 Session (content TBD)', day: '2026-09-03', start_time: '2026-09-03T09:00:00+08:00', end_time: '2026-09-03T12:00:00+08:00', sort_order: 16, genre_group: 'Week 2 · Teaching' },
]

export const seedKsas: Ksa[] = [
  {
    id: '55555555-0000-0000-0000-000000000001',
    code: 'CLAT',
    area: 'The CLAT Process and Translation of Aesthetic Language',
    short_label: 'CLAT facilitation & drafting',
    description:
      'Knows the Creating Local Arts Together (CLAT) conversations and how to adapt them as a workflow for translating aesthetic portions of Scripture using the macro translation principles for aesthetic language.',
    evaluator_facing_prompt:
      'How did they lead the CLAT conversations, and what did the resulting draft show about fidelity and local-genre excellence?',
    ai_facing_rubric:
      'Knowledge: knows the CLAT conversations and how they adapt into a workflow for translating aesthetic Scripture via the macro principles. Attitude: values CLAT as a disciplined, community-rooted process; trusts local artists as essential partners; committed to capturing aesthetic qualities because they shape emotion, identity, worship, and clarity of meaning. Skill: can lead a team and local artists through a contextualized CLAT process and facilitate translating Psalms into a functionally matched local genre with attention to both fidelity and genre excellence. Evaluation: quality of CLAT facilitation with MTTs/artists, how the Psalm 1 and 13 drafts function as both faithful renderings and excellent genre examples (esp. at community check and mentored consulting), and clarity of documented reasoning.',
    evidence_levels: {
      '0': 'Not yet leading; relies on others to run the CLAT conversations, and the draft loses the source meaning or the genre.',
      '1': 'Leads parts with substantial support; the draft is either faithful or genre-fitting, but not yet both.',
      '2': 'Leads the conversations independently; the draft is faithful and fits the local genre.',
      '3': 'Leads fluently and adapts the process; the draft is faithful and an excellent example of the genre, with reasoning they can articulate.',
    },
    cbc_subpoint_refs: ['Guiding Translation Teams', 'Translation Practice', 'Adult Education'],
    guiding_questions: [
      'Do they move through the CLAT conversations in order, adapting rather than skipping steps?',
      'Does the draft hold the source meaning?',
      'Does the draft sound like a strong example of the local genre, not a flattened one?',
      'Can they explain why they made a given rendering choice?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000002',
    code: 'AESTH',
    area: 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
    short_label: 'Aesthetic language & ethnopoetics',
    description:
      'Knows that aesthetic language is a universal human phenomenon for sacred, identity-forming, and emotionally significant content; knows ethnopoetics as the framework; knows the role and functions of aesthetic language in the Hebrew Bible and wider ancient Near East.',
    evaluator_facing_prompt:
      'When it came up, how did they explain aesthetic language / ethnopoetics and its function in the Bible and the wider ancient Near East?',
    ai_facing_rubric:
      'Knowledge: aesthetic language as universal; ethnopoetics as the study framework; its central role and social/theological functions in the Hebrew Bible and ancient Near East. Attitude: holds aesthetic language in high regard as a divinely sanctioned means of forming identity, shaping emotion, and passing on sacred knowledge. Skill: can describe aesthetic language and ethnopoetics in their own words, identify aesthetic passages across Scripture, and articulate the functions these forms served. Evaluation: how well they explain ethnopoetics and the role of aesthetic language, and how that foundation informs their MTT interactions.',
    evidence_levels: {
      '0': 'Cannot yet describe aesthetic language or ethnopoetics, or treats it as mere decoration.',
      '1': 'Partial or vague grasp; struggles to tie it to Scripture or the ancient Near East.',
      '2': 'Explains ethnopoetics and the biblical / ANE function clearly.',
      '3': 'Explains it fluently and lets that framework shape how they guide the MTTs.',
    },
    cbc_subpoint_refs: ['Hermeneutics', 'Modes of Communication'],
    guiding_questions: [
      'Can they explain, in their own words, what aesthetic language and ethnopoetics are?',
      'Do they connect aesthetic forms to their function in Scripture and the ancient Near East?',
      'Do they treat aesthetic language as load-bearing meaning, or as decoration to strip away?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000003',
    code: 'GENRE',
    area: 'Genre Theory, Discovery, and Matching',
    short_label: 'Genre mapping & matching',
    description:
      'Knows that every culture has a repertoire of genres with distinct functions, features, and norms; knows the principal Psalm genres and genre theory as a tool for discovering genres in a community and matching them across languages for faithful translation.',
    evaluator_facing_prompt:
      "How did they map the community's genres and reason toward a functional match for the psalm?",
    ai_facing_rubric:
      'Knowledge: every culture has a genre repertoire (functions, features, norms); principal Psalm genres; genre theory for discovery and cross-language matching. Attitude: approaches local genres with genuine appreciation as rich resources, committed to functional matches rather than forcing biblical forms. Skill: can ask culturally appropriate questions to map a community genre repertoire, identify functions/features of psalm and candidate local genres, and reason convincingly about why a local genre is a faithful functional match. Evaluation: quality of the genre-mapping facilitation, coherence of feature documentation, and how well-reasoned the proposed matches are.',
    evidence_levels: {
      '0': 'Cannot yet map or match genres, or forces biblical forms onto local ones.',
      '1': 'Maps with heavy prompting; the matching reasoning is thin.',
      '2': 'Maps the repertoire, analyzes features, and proposes a sound functional match.',
      '3': 'Draws out a rich map; feature analysis is coherent and the match argument is convincing and documented.',
    },
    cbc_subpoint_refs: ['Guiding Translation Teams', 'Modes of Communication', 'Multicultural Environment'],
    guiding_questions: [
      'Are their mapping questions open-ended and culturally appropriate?',
      'Do they name the function of each local genre, not just its form?',
      'Do they look for a true functional match rather than forcing a biblical form?',
      'Is the proposed psalm-to-genre match well reasoned?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000004',
    code: 'EXEG',
    area: 'Psalms Exegesis and Internalization',
    short_label: 'Exegesis & internalization',
    description:
      'Knows the exegesis of Psalms 1 and 13 (genre, structure, rhetorical features, theology) and relevant Hebrew poetic conventions; knows the internalization frameworks from earlier workshops (the Four Es and SENSES).',
    evaluator_facing_prompt:
      "How deeply have they internalized the psalm themselves, and how did they facilitate the MTT's internalization?",
    ai_facing_rubric:
      'Knowledge: exegesis of Psalms 1 and 13 (genre, structure, rhetoric, theology); relevant Hebrew poetic conventions; internalization frameworks (Four Es, SENSES). Attitude: treats exegesis as the foundation for faithful translation and internalization as the essential bridge to drafting; does not rush either. Skill: can exegete and internalize a psalm deeply, facilitate internalization for an MTT using the frameworks, and draw on Scripture-as-Resources, spoken English Bible materials, FIA materials, and AI exegetical tools. Evaluation: depth of demonstrated internalization, effectiveness facilitating MTT internalization per best practices, and use of exegetical resources. A pre-workshop exegetical write-up, if assigned, is a baseline indicator (not pass/fail).',
    evidence_levels: {
      '0': 'Exegesis / internalization is absent or surface-level.',
      '1': 'Some exegesis, but internalization is shallow or the facilitation is weak.',
      '2': 'Solid personal internalization; facilitates MTT internalization using the frameworks.',
      '3': 'Deep internalization; facilitates skillfully with the Four Es / SENSES and the exegetical resources.',
    },
    cbc_subpoint_refs: ['Hermeneutics', 'Translation Practice'],
    guiding_questions: [
      'How deep is their own internalization of the psalm (recall, feeling, understanding)?',
      'Do they facilitate MTT internalization (Four Es / SENSES) before any drafting?',
      'Do they let internalization happen first, or rush to a draft?',
      'Do they draw on exegetical resources (Scripture-as-Resources, FIA, AI tools)?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000005',
    code: 'CHECK',
    area: 'Checking Artistic Translations',
    short_label: 'Checking facilitation',
    description:
      'Knows best practices for community and consultant checking of artistic translations, how to ask open-ended and inferential questions suited to aesthetic content, and the framework of the Concise Handbook on the Consultant Checking Conversation.',
    evaluator_facing_prompt:
      'How did they prepare and lead the check, from their consulting questions through the move from issue to resolution?',
    ai_facing_rubric:
      'Knowledge: best practices for community and consultant checking of artistic translations; open-ended/inferential questions for aesthetic content; the Concise Handbook framework as shared vocabulary. Attitude: treats checking as collaborative, humble, servant-hearted (not adversarial or purely technical); recognizes MTTs/artists as co-laborers. Skill: can prepare consulting questions and plans suited to the genre/content, facilitate community and consultant checking, lead a conversation from issue identification to resolution, and give/receive peer feedback. Evaluation: quality of preparation and execution of the Psalm 1 and 13 checks, quality of consulting questions, peer reports, and facilitator observation notes.',
    evidence_levels: {
      '0': 'No usable consulting questions or plan; cannot yet lead a check.',
      '1': 'Questions or plan are thin; leads only with support.',
      '2': 'Prepares suitable questions and a plan; facilitates community and consultant checks competently.',
      '3': 'Strong questions and plan; leads from issue to resolution with humility and skill.',
    },
    cbc_subpoint_refs: ['Consulting Process Skills', 'Translation Practice', 'Interpersonal Skills'],
    guiding_questions: [
      'Are their consulting questions open-ended and inferential, suited to a song?',
      'Do they lead from naming an issue to a resolution the team owns?',
      'Is their posture humble and collaborative rather than adversarial?',
      'Do they give and receive peer feedback well?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000006',
    code: 'ADVOC',
    area: 'Advocacy and Community Integration',
    short_label: 'Advocacy & integration',
    description:
      'Knows how to build a case for local-genre Scripture translation (genre theory, ethnopoetics, the social function of aesthetic language, examples from Scripture and the stakeholders’ own milieu) and how to develop a plan for integrating artistic translations into communities.',
    evaluator_facing_prompt:
      'How did they make the case for a local-genre psalm, and how realistic is their integration plan?',
    ai_facing_rubric:
      'Knowledge: how to build a case for local-genre Scripture translation using genre theory, ethnopoetics, the social function of aesthetic language, and scriptural/cultural examples; the rationale and plan for community integration. Attitude: embraces the ambassador role for faithful local-genre translation (which makes meaning clearer, not obscured); values community integration and Scripture impact as the goal. Skill: can make a compelling, inductively framed case to community leaders that a psalm in a local art form is still a faithful translation, and can work with artists/MTTs on a realistic integration plan with follow-up. Evaluation: clarity of the case and the realism, cultural sensitivity, and scope of the integration plans produced.',
    evidence_levels: {
      '0': 'Cannot yet make the case; no integration plan.',
      '1': 'The case is weak; the plan is unrealistic.',
      '2': 'Makes a clear case and a realistic integration plan.',
      '3': 'Compelling inductive case; a culturally sensitive, well-scoped plan with follow-up.',
    },
    cbc_subpoint_refs: ['Interpersonal Skills', 'Multicultural Environment', 'Adult Education'],
    guiding_questions: [
      'Can they make a compelling, inductive case that a local-art-form psalm is still faithful?',
      'Is their community-integration plan realistic and culturally sensitive?',
      'Do they plan for follow-up, not just a one-time presentation?',
    ],
  },
  {
    id: '55555555-0000-0000-0000-000000000007',
    code: 'INTERP',
    area: 'Interpersonal Interaction and Collaborative Posture',
    short_label: 'Interpersonal posture & collaboration',
    description:
      'Knows that consultant work is fundamentally relational and cross-cultural, and that how one engages fellow CITs, consultants, and instructors — collaboration, humility, and openness to feedback — shapes the work as much as technical skill. Observed in the teaching sessions rather than the practicum.',
    evaluator_facing_prompt:
      'How did they engage with fellow CITs, consultants, and instructors in this session — their collaboration, humility, openness to feedback, and sensitivity to cross-cultural difference?',
    ai_facing_rubric:
      'Knowledge: understands that consultant and translation work is relational and cross-cultural, and that how one engages colleagues, mentors, and teams shapes outcomes. Attitude: approaches others with openness, collegiality, and a posture of service; treats feedback and correction as collaborative rather than adversarial; genuinely values cultural difference. Skill: collaborates constructively in group learning, gives and receives peer and mentor feedback well, and navigates cross-cultural interaction with sensitivity. Evaluation: observed interpersonal conduct during the teaching sessions — collaboration with peers, interaction with consultants and instructors, humility under correction, and cross-cultural sensitivity. Grounded in the CBC General Core competencies Interpersonal Skills and Multicultural Environment.',
    evidence_levels: {
      '0': 'Disengaged, dismissive, or defensive; talks over others, resists correction, or shows little regard for cross-cultural difference.',
      '1': 'Participates unevenly; collaborates when prompted but is guarded about feedback or occasionally inattentive to others’ perspectives or cultural difference.',
      '2': 'Engages collegially and with humility; contributes to the group, receives feedback openly, and is attentive to cross-cultural dynamics.',
      '3': 'Actively builds the group up; draws others in, gives and receives feedback graciously, and navigates cross-cultural difference with evident sensitivity and service.',
    },
    cbc_subpoint_refs: ['Interpersonal Skills', 'Multicultural Environment'],
    guiding_questions: [
      'Do they engage collegially with fellow CITs and consultants, or stay disengaged / dominate the room?',
      'How do they receive feedback and correction from instructors and peers?',
      'Are they attentive and respectful across cultural difference?',
      'Do they contribute to a constructive, servant-hearted group dynamic?',
    ],
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
  // Morning teaching sessions -> Interpersonal interaction only
  { activity_id: seedActivities[9].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[10].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[11].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[12].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[13].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[14].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[15].id, ksa_id: seedKsas[6].id, sort_order: 1 },
  { activity_id: seedActivities[16].id, ksa_id: seedKsas[6].id, sort_order: 1 },
]
