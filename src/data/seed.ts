import type { Activity, ActivityKsa, Ksa, Participant, Team, Workshop } from '../lib/types'

// Local mirror of supabase/seed.sql, used when Supabase is not configured so the
// foundation app is demoable offline. Keep in sync with seed.sql if you change either.

export const seedWorkshops: Workshop[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'OBT Crash Course — Bali 2026',
    start_date: '2026-08-03',
    end_date: '2026-08-07',
    location: 'Bali, Indonesia',
    languages: ['English'],
  },
]

export const seedTeams: Team[] = [
  { id: '22222222-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, name: 'Team Alpha' },
  { id: '22222222-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, name: 'Team Beta' },
]

export const seedParticipants: Participant[] = [
  { id: '33333333-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, name: 'Asha N.', registered_email: 'asha@example.org', team_id: seedTeams[0].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, name: 'Budi S.', registered_email: 'budi@example.org', team_id: seedTeams[0].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, name: 'Carmen R.', registered_email: 'carmen@example.org', team_id: seedTeams[1].id, preferred_language: 'English' },
  { id: '33333333-0000-0000-0000-000000000004', workshop_id: seedWorkshops[0].id, name: 'Deepa K.', registered_email: 'deepa@example.org', team_id: seedTeams[1].id, preferred_language: 'English' },
]

export const seedActivities: Activity[] = [
  { id: '44444444-0000-0000-0000-000000000001', workshop_id: seedWorkshops[0].id, title: 'Intro to Orality (lesson + discussion)', day: '2026-08-03', start_time: '2026-08-03T09:00:00+08:00', end_time: '2026-08-03T10:30:00+08:00', sort_order: 1, genre_group: 'Foundations' },
  { id: '44444444-0000-0000-0000-000000000002', workshop_id: seedWorkshops[0].id, title: 'Team Exegesis Practice', day: '2026-08-03', start_time: '2026-08-03T11:00:00+08:00', end_time: '2026-08-03T12:30:00+08:00', sort_order: 2, genre_group: 'Practice' },
  { id: '44444444-0000-0000-0000-000000000003', workshop_id: seedWorkshops[0].id, title: 'Internalization & Drafting Workshop', day: '2026-08-03', start_time: '2026-08-03T14:00:00+08:00', end_time: '2026-08-03T16:00:00+08:00', sort_order: 3, genre_group: 'Practice' },
]

export const seedKsas: Ksa[] = [
  { id: '55555555-0000-0000-0000-000000000001', code: 'ORAL-1', area: 'Orality', description: 'Understands orality as a preference for holistic mental storage, not a lack of literacy.', evaluator_facing_prompt: 'Orality: do they treat oral methods as a strength, not a deficit?', ai_facing_rubric: 'PLACEHOLDER. Look for language treating oral communication as a valid, preferred mode of holistic storage and recall, rather than framing non-literate contexts as deficient.', evidence_levels: { '0': 'Frames orality as a deficit / lack of literacy.', '1': 'Acknowledges orality but defaults to literate assumptions.', '2': 'Applies oral methods appropriately with some prompting.', '3': 'Fluently frames and leverages orality as a strength.' }, cbc_subpoint_refs: ['Modes of Communication', 'Adult Education'] },
  { id: '55555555-0000-0000-0000-000000000002', code: 'WORK-1', area: 'OBT Workflow & Team Composition', description: 'Knows the core OBT process steps and the roles on a translation team.', evaluator_facing_prompt: 'Workflow: can they name the core steps and who does what?', ai_facing_rubric: 'PLACEHOLDER. Evidence of correctly sequencing the OBT workflow and articulating team roles and relationships.', evidence_levels: { '0': 'Cannot describe the workflow or roles.', '1': 'Partial / out-of-order understanding.', '2': 'Mostly correct with minor gaps.', '3': 'Clear, complete grasp of steps and roles.' }, cbc_subpoint_refs: ['OBT Process', 'Team Dynamics'] },
  { id: '55555555-0000-0000-0000-000000000003', code: 'EXEG-1', area: 'OBT Exegesis, Internalization, and Drafting', description: 'Demonstrates sound exegesis feeding internalization and faithful drafting.', evaluator_facing_prompt: 'Exegesis/Internalization/Drafting: is the draft faithful and well-internalized?', ai_facing_rubric: 'PLACEHOLDER. Evidence linking exegetical findings to internalization technique to a faithful, natural oral draft.', evidence_levels: { '0': 'Draft not grounded in exegesis.', '1': 'Some exegetical grounding, weak internalization.', '2': 'Faithful draft, internalization mostly solid.', '3': 'Excellent exegesis-to-draft fidelity and internalization.' }, cbc_subpoint_refs: ['Hermeneutics', 'Translation Quality'] },
  { id: '55555555-0000-0000-0000-000000000004', code: 'INTP-1', area: 'Interpersonal Interactions', description: 'Shows godly, humble, cross-cultural team dynamics under pressure.', evaluator_facing_prompt: 'Interpersonal: humble, constructive, cross-culturally aware?', ai_facing_rubric: 'PLACEHOLDER. Evidence of humility, constructive conflict handling, and cross-cultural sensitivity during teamwork.', evidence_levels: { '0': 'Disruptive or dismissive of others.', '1': 'Inconsistent / passive participation.', '2': 'Generally collaborative and respectful.', '3': 'Actively builds the team across cultures.' }, cbc_subpoint_refs: ['Interpersonal Skills', 'Cross-Cultural Competence'] },
  { id: '55555555-0000-0000-0000-000000000005', code: 'TECH-1', area: 'Technology & Resources', description: 'Uses APM, exegetical tools, and FIA resources appropriately.', evaluator_facing_prompt: 'Technology: do they use the tools/resources effectively?', ai_facing_rubric: 'PLACEHOLDER. Evidence of appropriate, fluent use of the workshop technology and exegetical resources.', evidence_levels: { '0': 'Avoids or misuses the tools.', '1': 'Uses tools only with heavy help.', '2': 'Uses tools competently.', '3': 'Uses tools fluently and helps others.' }, cbc_subpoint_refs: ['Tools & Resources'] },
]

export const seedActivityKsas: ActivityKsa[] = [
  { activity_id: seedActivities[0].id, ksa_id: seedKsas[0].id, sort_order: 1 },
  { activity_id: seedActivities[0].id, ksa_id: seedKsas[1].id, sort_order: 2 },
  { activity_id: seedActivities[1].id, ksa_id: seedKsas[2].id, sort_order: 1 },
  { activity_id: seedActivities[1].id, ksa_id: seedKsas[3].id, sort_order: 2 },
  { activity_id: seedActivities[2].id, ksa_id: seedKsas[2].id, sort_order: 1 },
  { activity_id: seedActivities[2].id, ksa_id: seedKsas[4].id, sort_order: 2 },
]
