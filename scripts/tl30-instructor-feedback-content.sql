-- tl-30: the Instructor Practice goal, its three questions, and the event that
-- collects them. For both Bali workshops.
--
--   node scripts/apply-migration.mjs scripts/tl30-instructor-feedback-content.sql
--
-- NOT a migration, for the same reasons tl24-crash-course-content.sql is not: no
-- schema change, deliberately outside supabase/migrations/ so `db push` never
-- replays it, and idempotent on fixed ids so a re-run after Joshua edits a prompt
-- is how the edit is applied. Namespaces: 30100000 = goals, 30200000 = questions,
-- 30300000 = activities. No DELETE and no unscoped UPDATE anywhere in this file.
--
-- ## Three questions, and not a fourth
--
-- Joshua was explicit: "I don't want multiple categories available. I want there
-- to just be like one type of teacher feedback" — adult learning, teamwork, and
-- collaborative leadership. So there is one goal and there are three questions,
-- and the temptation to add a fourth for "content mastery" or "communication" is
-- the thing being refused, not an oversight. A facilitator being observed by four
-- colleagues during a week they are also teaching can answer three questions
-- honestly. Nine turns into a form.
--
-- ## The content is written once and inserted twice
--
-- The dimensions do not differ between the Crash Course and the Psalms workshop,
-- so the prose lives in ONE values list and is joined onto a per-workshop list of
-- ids and codes. Copying the text into two blocks would work today and diverge
-- the first time somebody fixes a typo in one of them.
--
-- Codes follow each workshop's own convention rather than a new one: the Crash
-- Course prefixes everything `CC-`, Psalms uses bare words. The goal code is
-- `INS` in both. It is NOT `IP`, which the Crash Course already spends on
-- "Interpersonal Interactions" and Psalms nearly spends on `G7`; `ksa.code` and
-- `goal.code` are unique per workshop, so reusing it would have been a collision
-- in one workshop and a confusion in the other.
--
-- ## Why the event is undated
--
-- Joshua chose one review per instructor per event rather than session by
-- session. An undated activity sorts out of the day schedule (see
-- groupActivitiesByDay in src/lib/schedule.ts) and appears in its own block, which
-- is what a whole-course judgment should look like: not a thing you do at 10:40
-- on Wednesday, a thing you do once when you have seen enough.

begin;

-- ---------------------------------------------------------------------------
-- 1. The goal. sort_order 90 so it lands after every teaching goal in both
--    workshops (Crash Course tops out at 4, Psalms at 6) without anybody having
--    to renumber the ones that are already authored.
-- ---------------------------------------------------------------------------

insert into goal (id, workshop_id, code, title, description, sort_order) values
  ('30100000-0000-4000-8000-000000000001', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'INS', 'Instructor Practice',
   'How the people teaching this course practise: adult learning, teamwork, and collaborative leadership. Evaluated by named colleagues, not by trainees, and read only by the person it is about and the course lead.', 90),
  ('30100000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111',
   'INS', 'Instructor Practice',
   'How the people teaching this workshop practise: adult learning, teamwork, and collaborative leadership. Evaluated by named colleagues, not by participants, and read only by the person it is about and the workshop lead.', 90)
on conflict (id) do update set
  code = excluded.code, title = excluded.title,
  description = excluded.description, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 2. The three questions.
--
--    `evidence_levels` covers 0-3, which is the scale both workshops run
--    (Crash Course: Not yet / Emerging / Competent / Strong; Psalms: the same
--    four in lower case). The descriptors are written for a colleague being
--    watched by a peer, not for a trainee being assessed: point 2 is what a good
--    facilitator does on an ordinary day, and point 0 describes a real failure
--    rather than an absence of talent.
--
--    `cbc_subpoint_refs` is empty. The CBC describes translation consulting
--    competencies; how somebody teaches adults is not one of them, and inventing
--    a mapping to fill the column would put a false citation in a report.
-- ---------------------------------------------------------------------------

insert into ksa (
  id, workshop_id, goal_id, code, short_label, description,
  evaluator_facing_prompt, ai_facing_rubric, evidence_levels,
  cbc_subpoint_refs, guiding_questions
)
select t.ksa_id, t.workshop_id, t.goal_id, t.code,
       c.short_label, c.description, c.prompt, c.rubric, c.levels,
       ARRAY[]::text[], c.guides
from (values
  ('30200000-0000-4000-8000-000000000011'::uuid, '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'::uuid,
   '30100000-0000-4000-8000-000000000001'::uuid, 'CC-INS1', 1),
  ('30200000-0000-4000-8000-000000000012'::uuid, '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'::uuid,
   '30100000-0000-4000-8000-000000000001'::uuid, 'CC-INS2', 2),
  ('30200000-0000-4000-8000-000000000013'::uuid, '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'::uuid,
   '30100000-0000-4000-8000-000000000001'::uuid, 'CC-INS3', 3),
  ('30200000-0000-4000-8000-000000000021'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
   '30100000-0000-4000-8000-000000000002'::uuid, 'INSTR1', 1),
  ('30200000-0000-4000-8000-000000000022'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
   '30100000-0000-4000-8000-000000000002'::uuid, 'INSTR2', 2),
  ('30200000-0000-4000-8000-000000000023'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
   '30100000-0000-4000-8000-000000000002'::uuid, 'INSTR3', 3)
) as t(ksa_id, workshop_id, goal_id, code, n)
join (values

-- 1. Adult learning -----------------------------------------------------------
(1,
 'Adult learning',
 'How this facilitator taught adults: what they did with the experience already in the room, how much of the session was practice rather than telling, how they found out whether it had landed, and what they changed when it had not.',
 'How did they teach the adults in this room? Think about what they did with what people already knew, how much the room practised rather than listened, and how they found out whether it had landed.',
 'Adult learning practice in a facilitated workshop. Knowledge: adults arrive with experience that is a resource rather than an obstacle, learn what they can immediately use, and need to try a thing before they own it. Attitude: treats the room as competent colleagues rather than an empty vessel, and treats a session that did not land as information about the teaching rather than about the learners. Skill: surfaces prior experience and builds on it by name, allocates real time to practice, checks understanding in a way that could actually return bad news, and adjusts pacing in the moment. Read the evidence as a colleague describing a peer, not as a grade: the evaluator is another facilitator who was in the room. Where the note describes a change the facilitator made mid-session, weight it heavily; that is the behaviour hardest to fake and most diagnostic of the competency.',
 '{"0":"Taught at the room. Delivered prepared material regardless of who was in front of them, treated questions as interruptions or as gaps in the listener, and left with no way of knowing whether anything landed.","1":"Made room for the group and asked whether there were questions, but the session stayed a delivery. Prior experience was invited in the abstract and not used once it arrived, and the check for understanding was one nobody could fail.","2":"Built on what the room already knew, naming it and using it. Gave real time to practice rather than to telling. Checked understanding in a way that could have returned bad news, and adjusted pace or example when it did.","3":"Taught the room actually present rather than the one planned for. Restructured a session in the moment on evidence that it was not landing, and could say afterwards what the evidence was. Left participants able to do the thing, not only able to describe it."}'::jsonb,
 ARRAY[
   'What did they do with the experience already in the room? Did they use it by name, or only invite it?',
   'How much of the session was people trying the thing, rather than hearing about it?',
   'How would they have known if it had not landed? Could their check have returned bad news?',
   'Did they change anything mid-session, and can they say what made them change it?'
 ]::text[]),

-- 2. Teamwork -----------------------------------------------------------------
(2,
 'Teamwork',
 'How this facilitator worked with the rest of the teaching team: preparation carried or dropped, handovers between sessions, covering for a colleague, and where disagreement got handled.',
 'How did they work with the rest of us? Think about preparation, handovers, what happened when something went wrong, and where disagreement got aired.',
 'Cooperative practice inside a co-facilitation team. Knowledge: a co-taught course is one continuous experience for the participants, so what happens between sessions is part of the teaching. Attitude: treats a colleague''s session as a shared responsibility rather than as their problem, and treats a disagreement about content as ordinary rather than as a threat. Skill: carries an agreed share of preparation on time, hands over in a way the next facilitator can use, notices and covers a gap without making it an event, and takes disagreement out of the room when airing it in front of the room would cost the participants. Read the evidence as a colleague describing a peer. Note that both directions matter: absorbing everything silently is not teamwork either, and a facilitator who never asks for help is describable at point 1 rather than point 3. Weight concrete incidents over general impressions.',
 '{"0":"Worked alone inside a team. Preparation agreed and not done, or done without telling anybody. Contradicted or corrected a colleague in front of the room, or let a colleague fail publicly rather than step in.","1":"Did their own part reliably and stopped at its edge. Handovers were an announcement rather than a handover, and a gap in somebody else''s session was noticed but not covered. Disagreement went unsaid rather than being handled.","2":"Carried their share and made the next person''s job easier: told them what the room had already covered, what had gone badly, and what to expect. Covered a colleague''s gap without turning it into an event. Raised disagreement, and raised it away from the participants.","3":"Actively made the team work better than its parts. Reorganised their own material because of what happened in somebody else''s session, asked for help before it became necessary, and handled a real disagreement in a way that improved the course and cost the room nothing."}'::jsonb,
 ARRAY[
   'Did the preparation they agreed to actually arrive, and on time?',
   'After their session, did the next facilitator know what the room had covered and what had gone badly?',
   'When something went wrong in somebody else''s session, what did they do?',
   'Where did disagreement get aired: in front of the participants, or away from them? And did it get aired at all?'
 ]::text[]),

-- 3. Collaborative leadership --------------------------------------------------
(3,
 'Collaborative leadership',
 'How this facilitator made decisions: who got consulted before a call was made, who was invited into the conversation, and how a decision was carried once it had been taken. Collaborative and conversational leadership in the sense SIL uses.',
 'How did they make decisions? Think about who they consulted first, who got invited into the conversation, and what they did once a decision was made that they had argued against.',
 'Collaborative and conversational leadership, in the sense used across SIL: a decision is arrived at through conversation with the people it affects, and the leader''s job is to hold the conversation well rather than to have the answer first. Knowledge: whose consent a decision needs, and the difference between consulting and informing. Attitude: treats being talked out of a position as a success of the process rather than a loss, and treats a decision made without the affected people as incomplete even when it is correct. Skill: consults before deciding rather than after, widens the conversation to the quieter and the more junior rather than only the confident, states clearly when a call is theirs alone, and carries a decision they lost without undermining it. Read the evidence as a colleague describing a peer. Distinguish carefully between genuine consultation and a decision already made being presented for comment; the second is a common failure and it reads at point 1, not point 2. Deciding quickly and alone in a genuine emergency is not a failure of this competency.',
 '{"0":"Decided alone and announced it, including on things that were not theirs to decide alone. Or would not decide at all, and left a room waiting. Undermined a decision they had lost once it was made.","1":"Consulted, but after the fact: the call was already made and what was invited was comment on it. Heard from whoever spoke first or loudest. Complied with a decision they disagreed with rather than carrying it.","2":"Consulted the people a decision affected before making it, and could be moved by what they heard. Said plainly when a call was theirs to make alone. Carried decisions they had argued against without relitigating them in front of the room.","3":"Held the conversation rather than dominating it: went and got the view of the person who had not spoken, made room for the more junior colleague to disagree, and named the trade-off honestly rather than selling the option they preferred. Changed their own position in public when the conversation warranted it."}'::jsonb,
 ARRAY[
   'Were the people a decision affected consulted before it was made, or after?',
   'Who got into the conversation? Only the confident, or the quieter and more junior too?',
   'Did they say clearly when a call was theirs alone, rather than dressing it as consultation?',
   'What did they do with a decision they had argued against and lost?'
 ]::text[])

) as c(n, short_label, description, prompt, rubric, levels, guides)
  on c.n = t.n
on conflict (id) do update set
  workshop_id = excluded.workshop_id, goal_id = excluded.goal_id, code = excluded.code,
  short_label = excluded.short_label, description = excluded.description,
  evaluator_facing_prompt = excluded.evaluator_facing_prompt,
  ai_facing_rubric = excluded.ai_facing_rubric, evidence_levels = excluded.evidence_levels,
  cbc_subpoint_refs = excluded.cbc_subpoint_refs, guiding_questions = excluded.guiding_questions;

-- ---------------------------------------------------------------------------
-- 3. The event. audience = 'instructor' is what gates it: activity_select shows
--    it only to somebody holding a reviewer pair in this workshop, or to an
--    administrator. sort_order 100 keeps it last for the administrator who does
--    see it alongside the teaching schedule.
-- ---------------------------------------------------------------------------

insert into activity (id, workshop_id, title, day, start_time, end_time, sort_order, genre_group, audience) values
  ('30300000-0000-4000-8000-000000000001', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b',
   'Instructor feedback', null, null, null, 100, 'Instructor feedback', 'instructor'),
  ('30300000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Instructor feedback', null, null, null, 100, 'Instructor feedback', 'instructor')
on conflict (id) do update set
  title = excluded.title, day = excluded.day, sort_order = excluded.sort_order,
  genre_group = excluded.genre_group, audience = excluded.audience;

-- ---------------------------------------------------------------------------
-- 4. Wiring. Three questions on the one event, in the order Joshua named them.
--    No prompt_override: there is one event, so a per-event wording would be a
--    second copy of the question with nothing to distinguish it.
-- ---------------------------------------------------------------------------

insert into activity_ksa (activity_id, ksa_id, sort_order) values
  ('30300000-0000-4000-8000-000000000001', '30200000-0000-4000-8000-000000000011', 0),
  ('30300000-0000-4000-8000-000000000001', '30200000-0000-4000-8000-000000000012', 1),
  ('30300000-0000-4000-8000-000000000001', '30200000-0000-4000-8000-000000000013', 2),
  ('30300000-0000-4000-8000-000000000002', '30200000-0000-4000-8000-000000000021', 0),
  ('30300000-0000-4000-8000-000000000002', '30200000-0000-4000-8000-000000000022', 1),
  ('30300000-0000-4000-8000-000000000002', '30200000-0000-4000-8000-000000000023', 2)
on conflict (activity_id, ksa_id) do update set sort_order = excluded.sort_order;

commit;

-- Acceptance, counted rather than asserted. Applying and verifying are one act,
-- as in tl-24. Every number below is what the next step depends on.
select jsonb_pretty(jsonb_build_object(
  'goals', (select jsonb_agg(jsonb_build_object('w', w.name, 'code', g.code, 'title', g.title, 'sort', g.sort_order) order by w.name)
            from goal g join workshop w on w.id = g.workshop_id where g.code = 'INS'),
  'questions', (select jsonb_agg(jsonb_build_object(
                   'w', w.name, 'code', k.code, 'label', k.short_label,
                   'levels', (select count(*) from jsonb_each_text(k.evidence_levels) e where btrim(e.value) <> ''),
                   'guides', coalesce(array_length(k.guiding_questions, 1), 0),
                   'has_rubric', k.ai_facing_rubric is not null) order by w.name, k.code)
                from ksa k join workshop w on w.id = k.workshop_id
                join goal g on g.id = k.goal_id where g.code = 'INS'),
  'events', (select jsonb_agg(jsonb_build_object(
                'w', w.name, 'title', a.title, 'audience', a.audience,
                'wired', (select count(*) from activity_ksa ak where ak.activity_id = a.id)) order by w.name)
             from activity a join workshop w on w.id = a.workshop_id where a.audience = 'instructor'),
  -- The invariant most likely to be broken by a mis-scoped insert: the teaching
  -- schedule and the teaching questions must be exactly as tl-24 and the seed
  -- left them. 17 activities and 9 questions in the Crash Course, 17 and 7 in
  -- Psalms, none of them touched by this file.
  'untouched', (select jsonb_agg(jsonb_build_object(
                   'w', w.name,
                   'teaching_activities', (select count(*) from activity a where a.workshop_id = w.id and a.audience = 'participant'),
                   'teaching_questions', (select count(*) from ksa k join goal g on g.id = k.goal_id
                                          where k.workshop_id = w.id and g.code <> 'INS')) order by w.name)
                from workshop w where w.id in ('74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', '11111111-1111-1111-1111-111111111111'))
));
