-- tl-24: the OBT Crash Course, authored.
--
-- Fills workshop 74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b with the content drafted in
-- the vault at `Projects/OBT/OBT Consultant Track/OBT Crash Course/Bali 2026/OBT
-- Crash Course Rubric.md`, which was authored from the canonical facilitator guide
-- (Drive id 1J3_qwp1qi2YibLOLCNA5waJJMMXPKGbd, exported 2026-08-07) and never from
-- either diverged vault copy.
--
--   node scripts/apply-migration.mjs scripts/tl24-crash-course-content.sql
--
-- NOT a migration: it changes no schema and is deliberately outside
-- supabase/migrations/ so `db push` never replays it. It IS idempotent — every
-- statement is an upsert on a fixed id — so a re-run after Joshua revises a
-- descriptor is the intended way to apply the revision.
--
-- Two properties this file is built around, both of them Joshua's explicit
-- constraint that the Bali Psalms workshop is not touched:
--   * every statement names the Crash Course workshop id in its VALUES or its
--     WHERE. There is no unscoped UPDATE. The single DELETE, added by the
--     2026-08-18 revision in section 7, names two Crash Course ids in its WHERE
--     and can reach nothing else.
--   * ids are fixed and deterministic (cc1 = goals, cc2 = questions, cc3 =
--     activities), so a second run updates the same nine rows rather than
--     inserting nine more. `importScenarioDraft` would have suffixed duplicates;
--     this cannot.
--
-- Joshua's decisions of 2026-08-07, encoded here rather than argued:
--   nine questions (CC-WF1 and CC-WF2 NOT merged); scale labels as drafted;
--   CC-TR1 at three sessions, dropped at Passage 2 Draft and Record; seventeen
--   activities, no eighteenth passage yet.
--
-- Revision of 2026-08-18. The Day One orality lesson was written after these
-- questions were, and it does not do what they assumed. The lesson (Drive id
-- 1XATTFQl0Xu56F-uOYzeILIVLtjT7JWcWr48Ga1jUVxs) derives orality inductively from
-- a tabernacle enactment, a bead-and-container activity, and the four shifts that
-- literacy produced, then closes on the process/product distinction and on tone
-- of voice. It never builds the OBT process on a board and never discusses team
-- composition, which is precisely what CC-WF1's and CC-WF2's prompts told an
-- evaluator to watch for. Joshua's decisions, 2026-08-18:
--   * CC-WF1 and CC-WF2 move off the orality session. Both now sit at Welcome and
--     Overview as a provisional first read, and at a new Day Five discussion,
--     which is the session to settle the score at. Welcome and Overview is mostly
--     presented rather than discussed, so its two prompts say so and tell the
--     evaluator it is fine to leave the question unrated there.
--   * the orality slot is renamed 'Orality and OBT'. The old title's second
--     clause, "and what does it take to make it happen?", promised the workflow
--     content the lesson does not carry.
--   * the devotion enactment that opens the session stays unrated, consistent
--     with devotionals being off the calendar. Rating begins at the debrief.
--   * prompts and guiding questions were rewritten; the 0-3 descriptors were not,
--     with one authorized exception. CC-OR1's point 3 awarded a 3 for reasoning
--     from skopos, a term this lesson never raises, so that point was unreachable
--     as written. It is rewritten against the reasoning the session does reach.
--   * eighteen activities now, not seventeen.
--
-- Three `ai_facing_rubric` values also gained a router note. That is not a
-- descriptor edit: the router is a reader of these questions exactly as an
-- evaluator is, and a rubric that still asks it for board-built evidence would
-- mark participants down for the absence of something the course never collects.
-- CC-WF1's rubric already carried such a note; this follows its precedent.
--
-- Second revision of 2026-08-18, applied before Exegete Passage 1 at 14:30 WITA on
-- Day One. Joshua: "the exegesis evaluations should include a spot for how people
-- are engaging. Additionally, we may not be reading the notes that they take
-- during the time. Instead, we need to also be paying attention to how people are
-- doing exegesis in their groups later in the day."
--
-- That reverses a recommendation made in writing the same morning. tl-24's gap
-- ledger item 3 and tl-27's memo item 3 are the same gap seen twice: the canonical
-- guide has been asking since April 2025 for "a step ... that allows for
-- evaluation of how well they can conduct a holistic exegesis conversation", and
-- Exegete Passage 1 defers "the participants' ability to communicate exegesis
-- findings in an oral fashion" to a session the week does not contain. The memo
-- priced closing it as a curriculum change and parked it for Crash Course 3.0.
-- Joshua's decision is to close it now, in the rubric, and it costs no schedule
-- change because the session it needs is already on the calendar. The memo's
-- item 3 is amended rather than left reading as parked.
--
-- What changes, and both halves answer one sentence of his each:
--   * CC-EX1 stops being a notes question. Its evidence is now what a facilitator
--     watches a team do while it exegetes, with the turned-in notes corroborating
--     where anybody reads them, so the question still resolves on a night nobody
--     does. `short_label` moves from 'Exegesis notes' to 'Exegesis' because the
--     label is what an evaluator sees on the card.
--   * CC-EX2 is new: the spot for how people are engaging. It is the observed
--     conversation, which is what a consultant will actually spend their time
--     doing, and its guiding questions carry the oral-communication half of the
--     gap that had no site at all.
--
-- CC-EX1's four descriptors are rewritten, which is the second authorized
-- descriptor edit in this file and it discharges an amendment owed since
-- 2026-08-07. tl-26 routed five real captures against them and found that levels 0,
-- 2 and 3 all turned on "the eight areas", a clause nobody speaking aloud ever
-- supplies: the router mentioned the areas zero times in five observations, so
-- every 2 and 3 it awarded asserted coverage the evidence did not contain. Its two
-- low descriptors were also conjunctive, and two real participants fitted neither.
-- Each point now names ONE distinguishing property, which is tl-26's own cheaper
-- fix. The eight areas survive in the guiding questions and the AI rubric, where a
-- reader can consult them, rather than in the descriptors, where a rater had to
-- have counted them.
--
-- Ten course questions now, not nine, and forty descriptors, not thirty-six.
-- Distribution moves to OR 1, WF 3, EID 4, IP 1, TR 1.

begin;

-- 1. Basics. The name currently carries three hyphens where Psalms carries a
-- proper em dash: an em-dash paste that lost a character on the way into the form.
update workshop set
  name = 'OBT Crash Course — OBT CDT (Bali 2026)',
  start_date = '2026-08-18',
  end_date = '2026-08-22',
  location = 'YWAM Jimbaran, Bali, Indonesia',
  languages = ARRAY['English']::text[],
  goal_label = 'KSA area'
where id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';

-- 2. The scale, authored before the descriptors because all thirty-six are written
-- against these four sentences. Four points, not five: the CBC scale is 0-3, and
-- `src/reports/discrepancyEmail.ts` hardcodes `/3` in four occurrences across
-- three lines, so a five-point workshop would print "4/3" in a real discrepancy
-- email. `is_low_trigger` is left as the defaults set it (0 and 1 true).
update scale_point set label = 'Not yet', description =
  'Not yet shown in a form a consultant could rely on. What was produced or said would need to be redone rather than refined.'
  where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and value = 0;
update scale_point set label = 'Emerging', description =
  'The idea is visible but the execution is not. A facilitator can see what the participant was reaching for and would have to supply the rest.'
  where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and value = 1;
update scale_point set label = 'Competent', description =
  'The course''s bar. This person could do this on a real project with a colleague available for questions.'
  where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and value = 2;
update scale_point set label = 'Strong', description =
  'Does it well enough to model it for a mother-tongue translation team, anticipating what will go wrong rather than only handling what does.'
  where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and value = 3;

-- 3. Five goals, one per KSA area, in the canonical table's order. Each
-- description carries that area's CBC overlaps verbatim, so the mapping is visible
-- where an administrator edits rather than only in a Google Doc.
insert into goal (id, workshop_id, code, title, description, sort_order) values
  ('cc100000-0000-4000-8000-000000000001', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'OR', 'Orality',
   'CBC overlaps: Modes of communication; Hermeneutics; Adult Education.', 0),
  ('cc100000-0000-4000-8000-000000000002', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'WF', 'OBT Workflow & Team Composition',
   'CBC overlaps: Program design and engagement; Consulting skills; Translation principles; Translation practice; Guiding translation teams.', 1),
  ('cc100000-0000-4000-8000-000000000003', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'EID', 'OBT Exegesis, Internalization, and Drafting',
   'The canonical KSA table lists CBC overlaps for four of the five areas and none for this one. The blank is faithful to the source rather than an omission here; whether the omission is deliberate is a question in the tl-27 memo. Do not invent overlaps to fill it.', 2),
  ('cc100000-0000-4000-8000-000000000004', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'IP', 'Interpersonal Interactions',
   'CBC overlaps: Interpersonal skills; Multicultural environment; Adult Education.', 3),
  ('cc100000-0000-4000-8000-000000000005', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'TR', 'Technology & Resources',
   'CBC overlaps: Technology for consulting; Translation resources.', 4)
on conflict (id) do update set
  code = excluded.code, title = excluded.title,
  description = excluded.description, sort_order = excluded.sort_order;

-- 4 and 5. Nine questions, each with an evidence descriptor at all four points.
-- Thirty-six descriptors, and they are this spec's deliverable.
--
-- `area` is deliberately left null: it is the pre-tl-08 free-text group string that
-- `goal_id` replaced, and `src/lib/types.ts` says app code must neither read nor
-- write it. Psalms' rows still carry it, which is legacy rather than a pattern.
--
-- `ai_facing_rubric` is what the router reads (`src/ai/contract.ts:81` and
-- `workspace.ts:203`), so each one states the area's Knowledge / Attitude / Skill /
-- Evaluation from the canonical KSA table. Leaving it null would have made tl-26's
-- routing rehearsal a test of an empty prompt.
insert into ksa (
  id, workshop_id, goal_id, code, short_label, description,
  evaluator_facing_prompt, ai_facing_rubric, evidence_levels,
  cbc_subpoint_refs, guiding_questions
) values

-- CC-OR1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000001', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000001',
 'CC-OR1', 'Defines orality, adapts steps',
 'Defines orality as a preference for holistic, internally stored communication rather than as a lack of literacy, and reasons about how translation steps change for an oral community. Canonical evaluation line: "How well the participants define orality and are able to reason about the way to adapt translation steps for oral communication."',
 'How does this person talk about orality once the discussion gets specific, and what do they say has to change about a translation when the audience listens rather than reads?',
 'Knowledge: orality is not a lack of literacy but a preference for holistic communication, shaped by the need or preference to have all information stored mentally rather than reference-able through an external source, and it has been the primary way people think and communicate throughout history. Attitude: sees orality as a beautiful aspect of how God created humans, acted in sacred history, and sanctioned for the growth of his church. Skill: can assess how oral a people group is and think critically about a translation team''s skopos and stated workflow in light of that orality. Evaluation: how well they define orality and reason about adapting translation steps for oral communication, including whether they can tell an OBT process from an audio recording of a written translation. Note for the router: the lesson builds the definition inductively, from a tabernacle enactment, a bead-and-container activity about oral transmission and writing, and the four shifts literacy produced, and it closes on the process/product distinction and on tone of voice. It never uses the word skopos and never walks the OBT steps, so judge the reasoning rather than the vocabulary, and do not treat the absence of either term as weakness.',
 '{"0":"Talks about orality as illiteracy, or as a problem to work around. When the group reasons about adapting a step, they wait rather than contribute, or they offer the written-translation answer unchanged.","1":"States a definition close to the one taught, but it stays a definition. Asked what would change for an oral team, they say that something should change without naming which step or why.","2":"Defines orality as a preference for holistic, internally stored communication rather than as a deficit, and reasons about at least one step concretely: names the step, says what changes, and ties the reason to how this community would actually receive the text. Can tell an OBT process from an audio recording of a written translation.","3":"Reasons from what the translation is actually for in a particular community, and lets that drive which steps change and by how much, rather than working from a checklist. Can say where the line is beyond which a process stops being OBT, and what an oral product needs that an audio recording of a written translation will never have. Their contributions move the group''s thinking rather than following it."}'::jsonb,
 ARRAY['Modes of communication','Hermeneutics','Adult Education']::text[],
 ARRAY[
   'Do they treat orality as a lack of literacy, or as a preference for holistic communication?',
   'When the group names symbol, ritual, story and community, do they contribute or wait?',
   'Can they say why recording a written translation does not make it oral, and what an oral product would need instead?',
   'Do they connect the shifts literacy produced to how a community they know actually receives a text?',
   'Once the discussion turns to Bible translation, do they reach for the Lausanne course or the Frost, Mustin and Beal article?'
 ]::text[]),

-- CC-WF1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000002', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000002',
 'CC-WF1', 'Names the OBT steps and why',
 'Names the core steps of the OBT process in order and says what quality problem each step exists to catch. Canonical evaluation line: "name the steps in the OBT process, describe their importance." The guide deferred this evaluation to an MTT training activity that the course is not running, so what is collected here is reasoning in discussion rather than a demonstration of teaching.',
 'What can this person name of the OBT process unprompted, and what do they say is lost when a step is skipped?',
 'Knowledge: all the core components necessary for an OBT workflow to produce a quality translation, the significance of each step, and what competencies and relationships each step needs. Attitude: values each component of the process and will advocate for it being done to the highest quality. Skill: can state all the core processes and their order. Evaluation: how well they name the steps and describe their importance, and whether they treat the sequence as load-bearing rather than conventional. Note for the router: the guide deferred this to an MTT training activity that is not happening, and the Day One orality lesson does not build the process on a board as an earlier draft of this question assumed. Two sites collect it instead. Welcome and Overview is mostly presented rather than discussed, so evidence there is a first impression and may be absent entirely; the Day Five discussion is the real capture point, where four days of having worked the process is itself part of what they are drawing on. Do not mark a participant down for the absence of evidence the course never collects.',
 '{"0":"Cannot name the core steps without the board in front of them. Treats the sequence as arbitrary, or as one they would reorder for convenience.","1":"Names most steps in roughly the right order. Explains importance in general terms, \"it''s important to check\", without saying what specifically goes wrong when the step is missing.","2":"Names all the core steps in order and, for at least exegesis, internalization, drafting and community testing, says what quality problem each step exists to catch. Treats the sequence as load-bearing rather than conventional.","3":"Explains the process as a chain of quality checks, naming what each step catches that no other step would, and can reason about where a real team under pressure would be tempted to cut and what that would cost them. Could teach the sequence to a team."}'::jsonb,
 ARRAY['Program design and engagement','Consulting skills','Translation principles','Translation practice','Guiding translation teams']::text[],
 ARRAY[
   'Can they name the core steps without a list in front of them?',
   'For exegesis, internalization, drafting and community testing, do they say what specifically goes wrong when the step is missing?',
   'Do they treat the order as load-bearing, or as one they would reorder for convenience?',
   'Having now worked the process for four days, can they say what each step caught that no other step would have?'
 ]::text[]),

-- CC-WF2 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000003', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000002',
 'CC-WF2', 'Team composition and relationships',
 'Reasons about which competencies and relationships each step of the OBT process requires, and who on a real team would hold them. Canonical evaluation line: "describe what competencies and relationships are necessary for each step." The pedagogy note this question was authored against, "At each step of the process, discuss what skills and relationships are necessary to accomplish the step", belonged to a board exercise the Day One orality lesson does not contain; the Day Five discussion added on 2026-08-18 is where that discussion now happens.',
 'When this person talks about a step of the process, do they think in roles and relationships, or only in tasks?',
 'Knowledge: what competencies and relationships are necessary at each step of an OBT workflow. Attitude: values each component of the process and will advocate for it being done to the highest quality. Skill: can state what is necessary to accomplish each core process. Evaluation: whether they name the competencies a step needs and who on a real team would hold them, whether they identify a relationship the step fails without, and whether they can reason about gaps and substitutions when nobody on the team holds a needed competency. Note for the router: this is cumulative. It is capturable in passing all week, provisionally at Welcome and Overview, and properly at the Day Five discussion. Weigh the Day Five evidence most heavily, and read a thin or missing Welcome and Overview capture as a session that gave them little chance to speak rather than as a weak participant.',
 '{"0":"Talks about the work without talking about who does it. Assumes the consultant or the facilitator absorbs whatever is missing.","1":"Names roles such as translator, consultant and community member, but attaches them to steps loosely, and treats relationship as goodwill rather than as a requirement of the work.","2":"For a given step, names the competencies it needs and who on a real team would hold them, and identifies at least one relationship the step fails without: community trust before testing, or team trust before peer critique. Notices when a team as described is missing something.","3":"Reasons about gaps and substitutions. What does a team do when nobody holds a needed competency, who can be trained into it, and what should an outside consultant decline to absorb? Distinguishes what the team must own from what can be borrowed."}'::jsonb,
 ARRAY['Program design and engagement','Consulting skills','Translation principles','Translation practice','Guiding translation teams']::text[],
 ARRAY[
   'For a given step, do they name who is needed and what relationship has to exist first?',
   'Do they treat relationship as goodwill, or as a requirement of the work?',
   'When a team as described is missing a competency, do they notice?',
   'What do they think an outside consultant should decline to absorb?',
   'Looking back at the week, can they say which relationships their own group depended on to get the passage done?'
 ]::text[]),

-- CC-EX1 ---------------------------------------------------------------------
-- Revised 2026-08-18. Was 'Exegesis notes', rated off the document turned in at the
-- end of Day One. It is now rated off the exegesis a facilitator watches the team
-- actually do, because the notes may go unread and a question whose only evidence
-- is unread is a question that silently does not get answered.
('cc200000-0000-4000-8000-000000000004', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000003',
 'CC-EX1', 'Exegesis',
 'The exegesis this participant actually does on the passage, watched while their group works and corroborated by the notes turned in at the end of the day wherever a facilitator reads them. The eight areas of inquiry are the seven from section four of Frost, Mustin and Beal (2024) plus cultural and historical background as the eighth. Canonical evaluation line: "turn in exegesis notes... evaluated by the course facilitators on technical accuracy and coverage of topics." Joshua''s decision of 2026-08-18 widens that evidence rather than narrowing the question: the notes are one source and the group session is the other, and either can carry the rating on its own.',
 'Follow the exegesis this person actually does while their group works. Could you draft from what they worked out?',
 'Knowledge: exegesis is a core process in OBT, and the best practices for it, including holistic exegesis (Harmelink 2025) and the eight areas of inquiry. Attitude: highly regards exegesis as a core OBT process. Skill: can exegete an OBT passage and explain practices for facilitating the process. Evaluation: technical accuracy and coverage of the eight areas, judged on whether a drafting team could work from what this person produced and whether conclusions are traceable to a resource or an argument rather than asserted. Note for the router: from 2026-08-18 the evidence is primarily an observed group session and only secondarily the written notes, so a capture that describes what somebody said in their team is on-target rather than off it. Do NOT require an enumeration of the eight areas: an evaluator speaking aloud never supplies one, this rubric''s earlier descriptors did require it, and the result was that every high designation asserted coverage the evidence did not contain. Judge the reasoning that is described. Absence of the notes is not evidence of weakness.',
 '{"0":"Works only from what the passage plainly says. Reads past the places where it is hard rather than noticing them, so nothing they contribute would change how the team drafts.","1":"Notices where the passage is hard and can name the difficulty, but leaves it named. The team is no closer to knowing what to do about it than before they spoke.","2":"Resolves at least one real difficulty in the passage and can say what the resolution rests on, so the team can draft from it. This is the course''s bar.","3":"Anticipates what the drafting team will stumble over before they reach it, the ambiguous term or the implicit participant or the cultural gap, and brings a resource or an argument to it rather than an opinion."}'::jsonb,
 ARRAY[]::text[],
 ARRAY[
   'Follow one hard place in the passage: did this person notice it, and did the group leave it resolved or open?',
   'What do their conclusions rest on, a resource, an argument, or an assertion?',
   'Which of the eight areas of inquiry did their work actually reach, and which got skipped?',
   'If you read the notes tonight, do they say what you watched them work out?',
   'Would you be willing to draft from this tomorrow?'
 ]::text[]),

-- CC-EX2 ---------------------------------------------------------------------
-- New 2026-08-18, and it is the spot for how people are engaging. It closes the
-- half of tl-24's gap ledger item 3 that had no site anywhere in the week: the
-- canonical guide asks for evaluation of "how well they can conduct a holistic
-- exegesis conversation", and Exegete Passage 1 defers "the ability to communicate
-- exegesis findings in an oral fashion" to a later session that does not exist.
-- Both are observed here.
--
-- It deliberately borrows CC-IP1's rule about temperament, because the failure mode
-- of an engagement question is rating volume. Point 3 is written so a quiet
-- participant can reach it and a talkative one cannot reach it by talking.
('cc200000-0000-4000-8000-000000000010', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000003',
 'CC-EX2', 'Engagement in the exegesis',
 'How this participant engages the exegesis work in their group: whether they bring something to the passage unasked, put questions to the text, say a finding aloud in a form the rest of the group can use, and let the group''s work change what they thought. This is the skill the canonical guide has been asking to evaluate since April 2025, "a step needs to be built in that allows for evaluation of how well they can conduct a holistic exegesis conversation", together with the oral-communication half that Exegete Passage 1 defers to a session the week does not hold. Rate engagement with the work, not volume of speech: a quiet participant who moves the group''s reading forward stands above a talkative one who does not.',
 'Watch how this person engages the exegesis rather than how much they talk. Did the group''s reading of the passage move because they were in it?',
 'Knowledge: exegesis is a core process in OBT, and the best practices for facilitating it, including holistic exegesis (Harmelink 2025). Attitude: highly regards exegesis as a core OBT process and treats a colleague''s question about the text as worth following. Skill: can conduct a holistic exegesis conversation and communicate exegetical findings orally, in a form a team can act on. Evaluation: how the participant engages the group''s exegesis work, judged on what they bring unprompted, whether their contributions answer what somebody else raised, whether a finding can be said aloud usefully rather than only written down, and whether they revise their own reading when the text pushes back. Note for the router: this is a question about an observed conversation, so the evidence is what the participant did in their team and never a document. Rate conduct in the work, not temperament, exactly as CC-IP1 does: silence is not a low score and confidence is not a high one, and a capture describing a quiet participant whose question reframed the group belongs at the top of the scale rather than the middle. This question is new on 2026-08-18 and has no captures behind it, so do not expect corroborating history.',
 '{"0":"Present but not in the work. Waits to be handed conclusions, or works alone beside the group rather than with it.","1":"Engages when engaged. Answers what is put to them and does the part they are given, but brings nothing to the passage that nobody asked them for.","2":"Brings something to the passage unprompted and says it in a form the rest of the group can use, and listens closely enough that their next contribution answers what somebody else raised. This is the course''s bar.","3":"Conducts the conversation rather than contributing to it: asks the question the group needed, draws in the person who has not spoken, and says out loud when a hard verse has been settled too quickly. Changes their own reading when the text pushes back, and says that is what happened."}'::jsonb,
 ARRAY[]::text[],
 ARRAY[
   'Did they bring anything to the passage that nobody asked them for?',
   'Does their next contribution answer what somebody else raised, or restart their own point?',
   'When the group settled a hard verse quickly, did anybody say so, and was it them?',
   'Can they say a finding aloud in a form the group can use, without reading it off the page?',
   'Did their own reading change during the session, and did they say why?'
 ]::text[]),

-- CC-IN1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000005', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000003',
 'CC-IN1', 'Internalization',
 'Internalizes an exegeted passage using the 4Es and the SENSES activities, to the point of telling it without the text while holding the structure, the participants and the flow of events. Canonical evaluation line: "facilitators observe and evaluate how well participants are able to internalize the passage, using the criteria taught in the previous session."',
 'Watch them work the passage rather than recite it. Are they using the 4Es and SENSES deliberately, or reading until it sticks?',
 'Knowledge: internalization is a core OBT process; the cognitive-linguistics framework for multimodal meaning-making, Katie Hogerhide Frost''s 4Es framework, and the SENSES acronym for organizing activities within an internalization session. Attitude: highly regards internalization as a core OBT process. Skill: can internalize an OBT passage and facilitate that process for a team. Evaluation: how well they internalize the passage using the criteria taught in the previous session, judged on whether they can tell it without the text while holding structure, participants and flow, and whether activity choice is deliberate rather than habitual.',
 '{"0":"Internalizes by repetition alone, or never reaches a point where they can tell the passage without the text. Treats internalization as memorizing words.","1":"Uses one or two of the taught activities, usually the ones they already preferred, and can tell the passage with prompting. Structure survives; detail, emotion and participant tracking drop out.","2":"Works the passage through several SENSES modes and can tell it without the text, holding the structure, the participants and the flow of events. Where something was lost, they can say what and go back for it. This is a team member ready to draft.","3":"Chooses activities for what this particular passage needs rather than working through the list, and can say why. Tells the passage in a way that already carries emotion and emphasis, and can explain to somebody else what they did to get there."}'::jsonb,
 ARRAY[]::text[],
 ARRAY[
   'Which SENSES activities do they use, and did they choose them for this passage or work through the list?',
   'Can they tell the passage without the text, holding the participants and the flow of events?',
   'When something is lost, can they say what and go back for it?',
   'Is internalization being treated as memorizing words?'
 ]::text[]),

-- CC-DR1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000006', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000003',
 'CC-DR1', 'Oral drafting',
 'Gets from an internalized passage to a recordable one, using the phrase or sentence draft as a working record and a whole-part-whole sequence of performances to produce a natural, faithful whole. Canonical evaluation line: "facilitators observe participants as they draft the passage they have internalized."',
 'Watch how they get from an internalized passage to a recordable one. Are they building a whole and refining it, or assembling fragments?',
 'Knowledge: drafting is a core OBT process; the sentence-draft file, and how to work from a phrase draft to a polished whole through a whole-part-whole sequence of iterative performances with the best parts stitched together; the pros and cons of the phrase-draft approach, including that it will not work as well for some oral peoples. Attitude: highly regards drafting as a core OBT process. Skill: can draft an OBT passage orally and teach mother-tongue translators best practices for drafting. Evaluation: whether a performance of the whole is produced and revised against, whether the result is natural and follows the exegeted meaning, and whether the participant can articulate the trade-off where naturalness and faithfulness pull apart.',
 '{"0":"Drafts phrase by phrase from the source wording. The result is a sequence of renderings rather than a telling, and naturalness is not attempted.","1":"Produces a phrase draft and reads it back, but the whole-part-whole sequence is not visible. There is no performance of the whole, so awkward joins and lost connectives survive into the recording.","2":"Uses the phrase draft as a working record, then performs the whole passage and revises against that performance. The result is natural, follows the exegeted meaning, and holds together as a telling. Can say why one wording was chosen over another.","3":"Iterates deliberately, keeping the best of each performance, and can articulate the trade-off being made where naturalness and faithfulness pull apart. Recognizes when the phrase-draft approach is fighting the passage and adapts. Could lead a team through this."}'::jsonb,
 ARRAY[]::text[],
 ARRAY[
   'Is there a performance of the whole passage, or only a sequence of phrase renderings?',
   'Do they revise against their own performance, keeping the best of each pass?',
   'Can they say why one wording was chosen over another?',
   'Do they notice when the phrase-draft approach is fighting this passage?'
 ]::text[]),

-- CC-CT1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000007', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000002',
 'CC-CT1', 'Community testing questions',
 'Five to ten community testing questions and a testing plan, turned in as a written document. The guide''s oral distinctive is that "the audience is also asked about the emotion and the performance, since performance is part of an oral translation in a way it never is in a written translation", so a set that ignores this is a written-translation test applied to an oral product. Canonical evaluation line: "The questions and testing plan are turned in as a written document so that they can be evaluated."',
 'Read the questions and the plan as the person who has to run the session. Would these get real information from a community member who has just listened?',
 'Knowledge: community checking is a core OBT process and the first quality check external to the team itself; the difference between written and oral community testing is chiefly that the audience is also asked about emotion and performance. Attitude: values the community check as an important point of data for the consultant. Skill: can produce five to ten testing questions and a general plan for the testing procedures. Evaluation: whether the questions probe comprehension and at least one probes emotion or performance, whether the plan names who is asked, how the passage will be played and how responses are recorded, and whether somebody other than the author could run it.',
 '{"0":"Fewer than five questions, or questions answerable yes or no, or questions that tell the listener the answer. No plan for who is asked or how.","1":"Five to ten questions, mostly probing comprehension, plus a plan naming a time and a place. Nothing asks about emotion or performance.","2":"Questions probe comprehension and at least one probes emotion or performance. The plan names who will be asked, how the passage will be played, and how responses will be recorded. Somebody other than the author could run it.","3":"Questions are ordered so early ones do not contaminate later ones, and the plan anticipates what will go wrong: who might defer to the translator, which questions to drop if time runs short, how to tell a polite answer from a real one. Treats the community as a data source to protect rather than an audience to please."}'::jsonb,
 ARRAY['Program design and engagement','Consulting skills','Translation principles','Translation practice','Guiding translation teams']::text[],
 ARRAY[
   'Are there five to ten questions, and are any answerable yes or no, or leading?',
   'Does at least one question ask about emotion or performance?',
   'Does the plan name who will be asked, how the passage will be played, and how responses are recorded?',
   'Could somebody other than the author run this session?'
 ]::text[]),

-- CC-IP1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000008', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000004',
 'CC-IP1', 'Conduct under critique',
 'How the participant conducts themselves during the workshop, evidenced in the moments when their own work is critiqued and when they critique someone else''s. Canonical evaluation line: "How the participants conduct themselves during the workshop." This is about conduct, not temperament: a quiet person is not a 1 and a confident one is not a 3. The vault copies of the guide extend this to explaining godly interactions in an MTT training; that wording is not canonical and has no site now that the MTT session is not happening.',
 'When this person''s work was critiqued, and when they critiqued someone else''s, what did they actually do?',
 'Knowledge: godly interpersonal interactions among the team and between the team and the community are the foundation of the OBT process. Attitude: treasures godly humility and a spirit of unity in team interactions, and strives to maintain a heart of service. Skill: can facilitate the steps in an OBT workflow in a godly manner. Evaluation: conduct during the workshop, evidenced at peer review, at revision, and at the consultant check. Rate conduct, not temperament: silence is not a low score and confidence is not a high one. Look for whether critique is engaged on the merits, whether review notes point at a specific place in the recording in terms the other team can act on, and whether the translation is separated from the translator when the feedback is hard.',
 '{"0":"Responds to critique by defending the draft rather than examining it, or withdraws from the work. When reviewing others, offers nothing usable, or corrects in a way the other person cannot act on.","1":"Accepts critique without argument but does not engage it. Changes are made because they were asked for rather than because they were understood. When reviewing, gives general approval or general criticism without pointing at anything specific.","2":"Engages critique on the merits: asks what the reviewer heard, then either changes the draft or explains why the current rendering is right. When reviewing, points at a specific place in the recording and says what they heard there, in terms the other team can act on. Shares work and time without being asked.","3":"Makes it easier for others to do their work. Draws out a quieter team member''s view, invites critique on the part they are least sure of, and separates the translation from the translator when the feedback is hard. When they disagree with the consultant, they do it in a way that keeps the conversation open."}'::jsonb,
 ARRAY['Interpersonal skills','Multicultural environment','Adult Education']::text[],
 ARRAY[
   'When their draft was critiqued, did they examine it or defend it?',
   'When reviewing someone else, did they point at a specific place and say what they heard there?',
   'Do they make it easier for others to do their work, including quieter team members?',
   'When they disagree with the consultant, does the conversation stay open?'
 ]::text[]),

-- CC-TR1 ---------------------------------------------------------------------
('cc200000-0000-4000-8000-000000000009', '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b', 'cc100000-0000-4000-8000-000000000005',
 'CC-TR1', 'APM usage',
 'Whether the participant''s work in Audio Project Manager is findable and reviewable by somebody else: audio files placed correctly and comments left in the right places. Canonical evaluation line: "whether files (especially audio files) are placed correctly and whether comments are left in the right places", with the stated target of "at least a CBC competency score of 2 on the relevant APM-related competency."',
 'Open their project in APM. Could a peer reviewer work in it without asking them questions?',
 'Knowledge: the names of the technologies designed to facilitate OBT workflows and exegesis, and how to use Audio Project Manager to facilitate an OBT project. Attitude: values the current OBT translation technology and exegetical resources while acknowledging their limitations. Skill: can use APM to complete an oral Bible translation process, and can access FIA''s and the Spoken English Bible''s exegetical resources. Evaluation: how well APM is used across the week, with particular attention to whether audio files are placed correctly and whether comments are left in the right places. The stated bar is a CBC competency score of at least 2 on the relevant APM-related competency, which is what point 2 describes. This is about whether the work is findable and reviewable by somebody else, not about speed.',
 '{"0":"Files are missing, filed under the wrong passage or the wrong project, or recorded outside APM and never brought in. Another team member could not find their work.","1":"Recordings exist in the right project but are placed inconsistently, and comments are left in the wrong place or as a single general note. Somebody else could find the work only with the author''s help.","2":"Audio files are in the right place for the right passage, comments are attached to the point they refer to, and a peer reviewer can open the project and work without asking questions. This is the CBC 2 the course targets.","3":"Uses the tool as a record the team will rely on later: consistent naming, comments still legible next week, a workflow another person could pick up mid-stream. Can help a peer fix their setup."}'::jsonb,
 ARRAY['Technology for consulting','Translation resources']::text[],
 ARRAY[
   'Are audio files in the right place for the right passage?',
   'Are comments attached to the point they refer to, or left as one general note?',
   'Could a peer reviewer open the project and work without asking questions?',
   'Would the naming and the comments still be legible next week?'
 ]::text[])

on conflict (id) do update set
  goal_id = excluded.goal_id, code = excluded.code, short_label = excluded.short_label,
  description = excluded.description, evaluator_facing_prompt = excluded.evaluator_facing_prompt,
  ai_facing_rubric = excluded.ai_facing_rubric, evidence_levels = excluded.evidence_levels,
  cbc_subpoint_refs = excluded.cbc_subpoint_refs, guiding_questions = excluded.guiding_questions;

-- 6. Eighteen activities on five dated days. The guide labels its days Monday
-- through Friday; the course runs Tuesday through Saturday because it was moved to
-- honour Indonesian Independence Day on 17 August, so those labels are ordinals
-- rather than weekdays. Day One is Tuesday 18 August.
--
-- The eighteenth, added 2026-08-18, is the Day Five process discussion. It is not
-- one of the Passage 2 reps and the guide's "Evaluation: Light" marking does not
-- cover it: it exists specifically to be the capture point for CC-WF1 and CC-WF2,
-- whose board exercise the Day One orality lesson turned out not to contain.
--
-- Joshua placed it, later the same day, first on Day Five at 90 minutes, with the
-- rest of the day given to a second round of translation and then Celebration. So
-- it takes sort_order 14 and the three Passage 2 sessions each shift up one. That
-- ordering matters beyond tidiness: it is the difference between rating the whole
-- process before the group re-runs it and rating it after, and only the first
-- makes the discussion a capture point rather than a debrief of a fresh rep.
--
-- It is not a new session. The canonical guide's Schedule Overview already reads
-- "8:30-9:00—Devotion: Josh: Guided Reflection 9:00-10:30—Reflection conversation"
-- for Day Five: ninety minutes, first thing, exactly where Joshua put it. tl-24
-- entered seventeen activities and this was not among them, because the guide
-- gives it a slot in the schedule table and no lesson plan of its own, and this
-- file was built by walking the lesson plans. So the eighteenth activity restores
-- a session the schedule always had rather than inventing one.
--
-- Times come from that same Schedule Overview, added 2026-08-18. They are WITA
-- (UTC+8, no DST), and they were previously null on the reasoning that the guide
-- did not carry them, which was wrong: it carries them on page 4, and only the
-- lesson plans omit them.
--
-- Two honest gaps in the times:
--   * Day Four's consultant check is two blocks in the guide, 11:00-13:00 and
--     14:30-16:00, and it is one activity row here. It is stored as 11:00-16:00,
--     spanning the lunch between them, because `suggestActivity` treats a running
--     activity as the one you are there for, and an evaluator opening the app at
--     15:00 on Friday is there for the consultant check.
--   * Day Five after the snack is "REST OF DAY" in the guide, with no boundaries
--     between Passage 2 Exegesis, Internalization, Draft and Record, and
--     Celebration. Those four keep null times rather than invented ones.
-- Devotionals are deliberately off the calendar — nothing in the guide evaluates
-- them, and five question-less cards every morning is attention taken from
-- watching a participant.
insert into activity (id, workshop_id, title, day, start_time, end_time, sort_order, genre_group) values
  ('cc300000-0000-4000-8000-000000000001','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Welcome and Overview','2026-08-18','2026-08-18 08:30+08','2026-08-18 09:15+08',1,'Opening'),
  ('cc300000-0000-4000-8000-000000000002','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Orality and OBT','2026-08-18','2026-08-18 09:45+08','2026-08-18 11:00+08',2,'Teaching & discussion'),
  ('cc300000-0000-4000-8000-000000000003','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Exegesis for Oral Bible Translation','2026-08-18','2026-08-18 11:30+08','2026-08-18 13:00+08',3,'Teaching'),
  ('cc300000-0000-4000-8000-000000000004','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Exegete Passage 1','2026-08-18','2026-08-18 14:30+08','2026-08-18 16:00+08',4,'Practice'),
  ('cc300000-0000-4000-8000-000000000005','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Internalization for OBT','2026-08-19','2026-08-19 09:00+08','2026-08-19 10:30+08',5,'Teaching'),
  ('cc300000-0000-4000-8000-000000000006','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Internalize Passage 1','2026-08-19','2026-08-19 11:00+08','2026-08-19 13:00+08',6,'Practice'),
  ('cc300000-0000-4000-8000-000000000007','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','APM + Audacity Training','2026-08-19','2026-08-19 14:30+08','2026-08-19 16:00+08',7,'Training'),
  ('cc300000-0000-4000-8000-000000000008','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Drafting in OBT','2026-08-20','2026-08-20 09:00+08','2026-08-20 09:45+08',8,'Teaching & practice'),
  ('cc300000-0000-4000-8000-000000000009','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Recording Passage 1 in Audio Project Manager','2026-08-20','2026-08-20 09:45+08','2026-08-20 11:00+08',9,'Practice'),
  ('cc300000-0000-4000-8000-000000000010','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Peer Review Passage 1 in Audio Project Manager','2026-08-20','2026-08-20 11:30+08','2026-08-20 13:00+08',10,'Checking'),
  ('cc300000-0000-4000-8000-000000000011','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Revise Passage 1','2026-08-20','2026-08-20 14:30+08','2026-08-20 16:00+08',11,'Practice'),
  ('cc300000-0000-4000-8000-000000000012','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Making Community Testing Questions for OBT','2026-08-21','2026-08-21 09:00+08','2026-08-21 10:30+08',12,'Teaching & practice'),
  ('cc300000-0000-4000-8000-000000000013','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Consultant Check and Second Revision of Passage 1','2026-08-21','2026-08-21 11:00+08','2026-08-21 16:00+08',13,'Checking'),
  ('cc300000-0000-4000-8000-000000000018','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','The OBT Process: Steps, Skills, and Relationships','2026-08-22','2026-08-22 09:00+08','2026-08-22 10:30+08',14,'Discussion'),
  ('cc300000-0000-4000-8000-000000000014','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Passage 2 Exegesis','2026-08-22',null,null,15,'Practice (light evaluation)'),
  ('cc300000-0000-4000-8000-000000000015','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Passage 2 Internalization','2026-08-22',null,null,16,'Practice (light evaluation)'),
  ('cc300000-0000-4000-8000-000000000016','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Passage 2 Draft and Record','2026-08-22',null,null,17,'Practice (light evaluation)'),
  ('cc300000-0000-4000-8000-000000000017','74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b','Celebration','2026-08-22',null,null,18,'Closing')
on conflict (id) do update set
  title = excluded.title, day = excluded.day, start_time = excluded.start_time,
  end_time = excluded.end_time, sort_order = excluded.sort_order, genre_group = excluded.genre_group;

-- 7. Wiring, with a per-event `prompt_override` wherever the guide's evaluation
-- line is session-specific. Three activities carry no question and each is
-- deliberate: Exegesis for OBT (teaching; CC-EX1 is collected next session),
-- Internalization for OBT (teaching), and Celebration have no evaluation line in
-- the guide at all. Welcome and Overview was a fourth until 2026-08-18, when
-- CC-WF1 and CC-WF2 moved onto it.
--
-- CC-TR1 is at three sessions, not four: Joshua dropped it at Passage 2 Draft and
-- Record on 2026-08-07, since Day Five is light and four capture points for one
-- cumulative question is more than an evaluator wants to fill.
-- Every override below is written to stand ALONE as the whole question, cue first
-- and the caveat folded in after it. That is not a style preference. `prompt_override`
-- REPLACES `evaluator_facing_prompt` at the one resolution site
-- (`resolveForActivity`, src/lib/goals.ts:181) rather than annotating it, so an
-- override written as a footnote puts a caveat on the capture card where the
-- question should be and silently deletes the question. The first draft of this
-- file made exactly that mistake at five sessions; reading Day One back through
-- the app's own resolver is what caught it.
-- The 2026-08-18 revision removes two rows: CC-WF1 and CC-WF2 no longer sit on the
-- orality session. A DELETE is the only way to unwire, since the insert below is an
-- upsert and would otherwise leave the stale pair in place on a re-run. It is
-- scoped to two literal Crash Course ids, so it cannot reach Psalms, and it is a
-- no-op the second time.
delete from activity_ksa
 where activity_id = 'cc300000-0000-4000-8000-000000000002'
   and ksa_id in ('cc200000-0000-4000-8000-000000000002',
                  'cc200000-0000-4000-8000-000000000003');

insert into activity_ksa (activity_id, ksa_id, sort_order, prompt_override, guiding_questions_override) values
  -- Day One. Welcome and Overview carries CC-WF1 and CC-WF2 as a provisional read
  -- only: Joshua presents this session rather than building the process with the
  -- group, so both overrides say out loud that leaving it unrated is the right
  -- answer when nobody said enough to judge. Rating a participant on a session
  -- they sat and listened through is the defect this revision exists to fix, and
  -- it would simply move here if the prompts did not say so.
  ('cc300000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002',0,
   'A first impression of who already knows the shape of an OBT project and who is hearing it for the first time. This session is mostly presented rather than discussed, so you may have nothing to go on: leave it unrated unless something they said gives you grounds. The Day Five process discussion is where this question gets settled.',null),
  ('cc300000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000003',1,
   'The same first impression, for roles rather than steps: as the week is laid out, does this person ask who does what, or only what gets done? Mostly presented, so rate only if you have grounds, and leave it unrated otherwise. The Day Five process discussion is the real capture point.',null),
  ('cc300000-0000-4000-8000-000000000002','cc200000-0000-4000-8000-000000000001',0,
   'How does this person talk about orality once the discussion gets specific, and what do they say has to change about a translation when the audience listens rather than reads? The devotion enactment that opens the session is not rated, so start at the debrief. The clearest evidence comes late, where the group works out why recording a written translation does not make it oral and what an oral product would need instead.',null),
  -- Revised 2026-08-18. The old override read "The notes turned in by the end of
  -- the evening are the evidence here, not what you watched in the room", which is
  -- the exact instruction Joshua reversed: the notes may not get read, and the
  -- room is where the exegesis happens. Both exegesis questions now sit on this
  -- session, CC-EX1 for the work and CC-EX2 for how they engage it.
  ('cc300000-0000-4000-8000-000000000004','cc200000-0000-4000-8000-000000000004',0,
   'Sit with a team and follow the exegesis they actually do. Could you draft from what this person worked out? What you watch in the room is the evidence; the notes turned in tonight confirm or correct it if you read them, and this question still stands on the session if nobody does.',null),
  ('cc300000-0000-4000-8000-000000000004','cc200000-0000-4000-8000-000000000010',1,
   'This is the capture point for engagement. Watch how this person engages the exegesis rather than how much they talk: did the group''s reading of the passage move because they were in it? Rate the work, not the volume, and remember that a quiet participant whose one question reframed the passage belongs high on this scale.',null),
  -- Day Two
  ('cc300000-0000-4000-8000-000000000006','cc200000-0000-4000-8000-000000000005',0,null,null),
  ('cc300000-0000-4000-8000-000000000007','cc200000-0000-4000-8000-000000000009',0,
   'First look at APM, during the walkthrough: is this person set up, in the right project and following along, or quietly stuck? Rate what you can see of how they place and name things, not their speed.',null),
  -- Day Three
  ('cc300000-0000-4000-8000-000000000008','cc200000-0000-4000-8000-000000000006',0,
   'Watch how they get from an internalized passage to a recordable one in the drafting that immediately follows this teaching, which is the evidence the guide names. Are they building a whole and refining it, or assembling fragments?',null),
  ('cc300000-0000-4000-8000-000000000009','cc200000-0000-4000-8000-000000000009',0,
   'Open their project in APM: where did the file land, and how is it named? This session''s own evaluation in the guide is only a completion check, so rate APM usage here on placement and naming rather than on whether a recording exists.',null),
  ('cc300000-0000-4000-8000-000000000010','cc200000-0000-4000-8000-000000000008',0,
   'Peer review is the first place conduct is visible under pressure, and in both directions: how did they take a note, and how did they give one?',null),
  ('cc300000-0000-4000-8000-000000000010','cc200000-0000-4000-8000-000000000009',1,
   'Open their project in APM: are comments attached to the point they refer to, in terms the other team can act on? Could a peer reviewer work in here without asking them questions?',null),
  ('cc300000-0000-4000-8000-000000000011','cc200000-0000-4000-8000-000000000008',0,
   'Revising after peer feedback: did they engage the note on the merits, or make the change because it was asked for?',null),
  ('cc300000-0000-4000-8000-000000000011','cc200000-0000-4000-8000-000000000006',1,
   'Revision exercises drafting again. Did they edit in a phrase or two and re-memorize, so the community will hear something close to the intended final version, or patch the recording and move on?',null),
  -- Day Four
  ('cc300000-0000-4000-8000-000000000012','cc200000-0000-4000-8000-000000000007',0,null,null),
  ('cc300000-0000-4000-8000-000000000013','cc200000-0000-4000-8000-000000000008',0,
   'Receiving consultant-level feedback and then revising is the evidence: what did this person do when the consultant''s note was hard to hear? The guide gives this session no evaluation line of its own; the question is attached on the strength of the KSA table''s Interpersonal row.',null),
  -- Day Five, which the guide marks "Evaluation: Light. The goal is reps, not measurement, though facilitators continue to observe."
  ('cc300000-0000-4000-8000-000000000014','cc200000-0000-4000-8000-000000000004',0,
   'Follow their exegesis of Passage 2 as a light second look. Day Five is reps rather than measurement, so rate only if this round genuinely changes your first read of their exegesis.',null),
  ('cc300000-0000-4000-8000-000000000014','cc200000-0000-4000-8000-000000000010',1,
   'A light second look at engagement, now that they have done this once before. Rate only if this round genuinely changes your first read of how they engage the work.',null),
  ('cc300000-0000-4000-8000-000000000015','cc200000-0000-4000-8000-000000000005',0,
   'Watch them internalize Passage 2 as a light second look. Day Five is reps rather than measurement, so rate only if this round genuinely changes your first read of their internalization.',null),
  ('cc300000-0000-4000-8000-000000000016','cc200000-0000-4000-8000-000000000006',0,
   'Watch them draft and record Passage 2 as a light second look. Day Five is reps rather than measurement, so rate only if this round genuinely changes your first read of their drafting.',null),
  -- The Day Five process discussion, which is NOT light: it is the capture point
  -- for the two workflow questions, and the only session all week that puts the
  -- whole process and its roles in front of the group at once.
  ('cc300000-0000-4000-8000-000000000018','cc200000-0000-4000-8000-000000000002',0,
   'This is the capture point for the steps. After four days of working the process, what can this person name unprompted, and what do they say is lost when a step is skipped? Rate here rather than at Welcome and Overview, where they had little chance to speak.',null),
  ('cc300000-0000-4000-8000-000000000018','cc200000-0000-4000-8000-000000000003',1,
   'This is the capture point for roles and relationships. At each step, who has to be involved, and what relationship does the step fail without? Draw on what you have watched them do all week, not only on what they say in this discussion.',null)
on conflict (activity_id, ksa_id) do update set
  sort_order = excluded.sort_order, prompt_override = excluded.prompt_override,
  guiding_questions_override = excluded.guiding_questions_override;

commit;

-- Acceptance, counted rather than asserted. The Psalms row is the invariant. It
-- read 22 participants, 17 activities, 7 goals, 7 questions when this file was
-- written and reads 24 / 18 / 8 / 10 as of 2026-08-18: Psalms grew through later
-- specs, which is drift in the comment rather than damage from this file. What
-- makes the invariant hold is structural, not the numbers — every statement here
-- names Crash Course ids, so none of them can reach Psalms at all.
--
-- After the second 2026-08-18 revision the Crash Course reads: 18 of this file's
-- activities dated in range plus tl-30's undated 'Instructor feedback', 5 goals,
-- this file's 10 questions plus tl-30's 3 instructor questions, 24 wiring rows,
-- 52 non-empty descriptors (this file's 40 plus tl-30's 12, since the query counts
-- the workshop and not the file), 0 questions missing a point, 0 placeholder hits, 0
-- unwired questions, 0 null AI rubrics, and exactly three activities without a
-- question: Exegesis for OBT, Internalization for OBT, Celebration. Day Five now
-- holds five activities.
--
-- The two exegesis sessions each carry two questions after this revision, which is
-- the one count worth reading directly rather than inferring from the total, so it
-- is asserted below as `exegesis_sessions`.
--
-- `activities_per_day` coalesces the day. tl-30 added an undated activity after
-- this file was written, and `json_object_agg` rejects a null key, so the original
-- expression aborted the whole acceptance query with a 22004 once that row
-- existed. The transaction above had already committed, which made the failure
-- look worse than it was, but a check that cannot run is not a check.
select json_build_object(
  'crash_course', (select json_build_object(
      'name', w.name, 'start', w.start_date, 'end', w.end_date,
      'location', w.location, 'languages', w.languages, 'goal_label', w.goal_label,
      'goals', (select count(*) from goal where workshop_id = w.id),
      'questions', (select count(*) from ksa where workshop_id = w.id),
      'activities', (select count(*) from activity where workshop_id = w.id),
      'activities_dated_in_range', (select count(*) from activity
         where workshop_id = w.id and day between '2026-08-18' and '2026-08-22'),
      'activities_per_day', (select json_object_agg(day, n) from
         (select coalesce(day::text, 'undated') as day, count(*) as n
            from activity where workshop_id = w.id group by 1) d),
      'scale_points_described', (select count(*) from scale_point
         where workshop_id = w.id and description is not null and btrim(description) <> ''),
      'descriptors_non_empty', (select count(*) from ksa k, jsonb_each_text(k.evidence_levels) e
         where k.workshop_id = w.id and btrim(e.value) <> ''),
      'questions_missing_a_point', (select count(*) from ksa k where k.workshop_id = w.id and (
         k.evidence_levels is null
         or (select count(*) from jsonb_each_text(k.evidence_levels) e
             where e.key in ('0','1','2','3') and btrim(e.value) <> '') <> 4)),
      'placeholder_hits', (select count(*) from ksa k, jsonb_each_text(k.evidence_levels) e
         where k.workshop_id = w.id and (
           e.value ~* '\y(placeholder|TBD|to be decided)\y'
           or e.value ~* '^(cannot yet|partially|adequately|excellently)\.?$')),
      'questions_unwired', (select count(*) from ksa k where k.workshop_id = w.id
         and not exists (select 1 from activity_ksa ak where ak.ksa_id = k.id)),
      'activities_without_a_question', (select json_agg(a.title order by a.sort_order) from activity a
         where a.workshop_id = w.id
           and not exists (select 1 from activity_ksa ak where ak.activity_id = a.id)),
      'wiring_rows', (select count(*) from activity_ksa ak
         join activity a on a.id = ak.activity_id where a.workshop_id = w.id),
      -- Added by the second 2026-08-18 revision. Both sessions where a team does
      -- exegesis must carry BOTH exegesis questions, and a total row count cannot
      -- say that: 24 is also what one session with four questions would print.
      'exegesis_sessions', (select json_object_agg(a.title, (
           select json_agg(k.code order by ak.sort_order) from activity_ksa ak
             join ksa k on k.id = ak.ksa_id where ak.activity_id = a.id))
         from activity a where a.workshop_id = w.id
           and a.id in ('cc300000-0000-4000-8000-000000000004',
                        'cc300000-0000-4000-8000-000000000014')),
      'questions_with_null_ai_rubric', (select count(*) from ksa
         where workshop_id = w.id and ai_facing_rubric is null)
    ) from workshop w where w.id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
  'psalms_invariant', (select json_build_object(
      'name', w.name, 'start', w.start_date, 'end', w.end_date,
      'participants', (select count(*) from participant where workshop_id = w.id),
      'activities', (select count(*) from activity where workshop_id = w.id),
      'goals', (select count(*) from goal where workshop_id = w.id),
      'questions', (select count(*) from ksa where workshop_id = w.id)
    ) from workshop w where w.id = '11111111-1111-1111-1111-111111111111')
) as acceptance;
