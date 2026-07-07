// Demo scenario: seeds a coherent, navigable journey for Amos Khokhar that trips
// every intervention path in one click. Re-runnable: all ids are prefixed `demo::`
// so the cleanup pass at the start can wipe and re-seed cleanly.
//
// Paths exercised:
//  1. Confirmed 0/3 (EXEG, activity 1): two confirms → mentoring conversation
//     auto-created by reconcileMentoringConversations, then advanced to completed.
//  2. Complementing 3/3s (GENRE, activity 2): two facilitators both give 3/3,
//     both confirmed → shows as strong consensus on the day-report.
//  3. Conflicting evaluations (CLAT, activity 2): fac-A gives 1/3 at T+0,
//     fac-B gives 3/3 at T+5h → conflict=true (span ≥ 2), time-gap note fires.
//     Both observations confirmed, so they count and land in the Discrepancy Inbox.
//  4. Late blowout (CHECK, activity 3): a later activity, low designation 0,
//     confirmed → shows up in the day-report as a serious lapse.

import { db } from '../db/local'
import { primeFromSeed } from '../db/reference'
import { reconcileMentoringConversations, completeConversation } from '../db/mentoring'
import { getRequiredConfirmations } from '../reports/verification'
import type { EvaluationRecord, ObservationRecord, VerificationVerdict } from '../lib/types'

// ---------------------------------------------------------------------------
// Demo identifiers
// ---------------------------------------------------------------------------

const DEMO_PREFIX = 'demo::'

// Amos Khokhar's id from seed.ts
const AMOS_ID = '33333333-0000-0000-0000-000000000003'
const AMOS_NAME = 'Amos Khokhar'

// Workshop id from seed.ts
const WORKSHOP_ID = '11111111-1111-1111-1111-111111111111'

// Activity ids from seed.ts (sort_order 1, 2, 3)
const ACT_1 = '44444444-0000-0000-0000-000000000001' // Genre Repertoire Mapping, day 1
const ACT_2 = '44444444-0000-0000-0000-000000000002' // Psalm 1 Scripture Goals, day 2
const ACT_3 = '44444444-0000-0000-0000-000000000003' // Internalization & Crafting, day 3

// KSA codes from seed.ts
const KSA_EXEG = 'EXEG'  // Psalms Exegesis (the 0/3 growth area)
const KSA_GENRE = 'GENRE' // Genre mapping (the complementing 3/3 path)
const KSA_CLAT = 'CLAT'  // CLAT facilitation (the conflict path)
const KSA_CHECK = 'CHECK' // Checking (the late blowout)

// Demo evaluator pool
const FAC_A = 'demo-facilitator-a@throughline.demo'
const FAC_B = 'demo-facilitator-b@throughline.demo'
const FAC_C = 'demo-facilitator-c@throughline.demo'
const FAC_D = 'demo-facilitator-d@throughline.demo'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoAt(base: string, offsetHours = 0): string {
  const d = new Date(base)
  d.setTime(d.getTime() + offsetHours * 60 * 60 * 1000)
  return d.toISOString()
}

// Day 1 base timestamp: 14:00 Bali time (UTC+8) = 06:00 UTC
const DAY1_BASE = '2026-08-24T06:00:00.000Z'
const DAY2_BASE = '2026-08-25T06:00:00.000Z'
const DAY3_BASE = '2026-08-26T06:00:00.000Z'

function makeEval(
  id: string,
  evaluatorEmail: string,
  activityId: string,
  createdAt: string,
  sourceText: string,
): EvaluationRecord {
  return {
    client_id: id,
    evaluator_email: evaluatorEmail,
    activity_id: activityId,
    workshop_id: WORKSHOP_ID,
    source_language: 'English',
    answers: {},
    source_text: sourceText,
    participant_scope: [{ participant_id: AMOS_ID, name: AMOS_NAME }],
    focus_participant_id: AMOS_ID,
    attestation: true,
    ruleset_version: null,
    edit_history: [],
    created_at: createdAt,
    updated_at: createdAt,
    sync_status: 'local',
  }
}

function makeObs(
  id: string,
  captureClientId: string,
  ksaCode: string,
  designation: 0 | 1 | 2 | 3,
  text: string,
  sourceExcerpt: string,
  sentiment: 'strong' | 'weak' | 'neutral',
  evaluatorEmail: string,
  importedAt: string,
): ObservationRecord {
  return {
    id,
    capture_client_id: captureClientId,
    participant_id: AMOS_ID,
    participant_name: AMOS_NAME,
    ksa_code: ksaCode,
    text,
    source_excerpt: sourceExcerpt,
    evidence_designation: designation,
    sentiment_flag: sentiment,
    confidence: 'high',
    needs_review: false,
    origin: 'individual',
    imported_at: importedAt,
    evaluator_email: evaluatorEmail,
  }
}

function makeVerdict(
  observationId: string,
  evaluatorEmail: string,
  captureClientId: string,
  at: string,
): VerificationVerdict {
  return {
    id: `${observationId}::${evaluatorEmail}`,
    observation_id: observationId,
    capture_client_id: captureClientId,
    evaluator_email: evaluatorEmail,
    decision: 'confirm',
    at,
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function loadDemoScenario(): Promise<{
  evaluations: number
  observations: number
  verdicts: number
  conversations: number
}> {
  // 1. Ensure reference data exists
  const participantCount = await db.participants.count()
  if (participantCount === 0) {
    await primeFromSeed()
  }

  // 2. Idempotent cleanup: delete all demo:: rows
  await db.transaction(
    'rw',
    [db.evaluations, db.observations, db.verifications, db.mentoringConversations],
    async () => {
      // Evaluations: client_id is the primary key
      const evalIds = await db.evaluations
        .filter((r) => r.client_id.startsWith(DEMO_PREFIX))
        .primaryKeys()
      await db.evaluations.bulkDelete(evalIds as string[])

      // Observations: id is the primary key
      const obsIds = await db.observations
        .filter((r) => r.id.startsWith(DEMO_PREFIX))
        .primaryKeys()
      await db.observations.bulkDelete(obsIds as string[])

      // Verifications: id is `${obs_id}::${email}`; observation_id starts with demo::
      const verdictIds = await db.verifications
        .filter((r) => r.observation_id.startsWith(DEMO_PREFIX))
        .primaryKeys()
      await db.verifications.bulkDelete(verdictIds as string[])

      // Mentoring: trigger_observation_id starts with demo::, and the mc:: id too
      const convIds = await db.mentoringConversations
        .filter(
          (r) =>
            (r.trigger_observation_id !== null && r.trigger_observation_id.startsWith(DEMO_PREFIX)) ||
            r.id.startsWith(`mc::${DEMO_PREFIX}`),
        )
        .primaryKeys()
      await db.mentoringConversations.bulkDelete(convIds as string[])
    },
  )

  // ---------------------------------------------------------------------------
  // 3. Build rows
  // ---------------------------------------------------------------------------

  const required = getRequiredConfirmations() // default 2

  const evaluations: EvaluationRecord[] = []
  const observations: ObservationRecord[] = []
  const verdicts: VerificationVerdict[] = []

  // ── Path 1: Confirmed 0/3 on EXEG (activity 1, day 1) ────────────────────
  // Two evaluators each produce a capture that observes Amos with EXEG = 0.
  // Two confirmers sign off → vstatus = 'verified', effective_designation = 0.
  // reconcileMentoringConversations() will auto-create mc::demo::obs-exeg-a.

  const evalExegA = `${DEMO_PREFIX}eval-exeg-a`
  const evalExegB = `${DEMO_PREFIX}eval-exeg-b`
  const obsExegA = `${DEMO_PREFIX}obs-exeg-a`
  const obsExegB = `${DEMO_PREFIX}obs-exeg-b`

  evaluations.push(
    makeEval(
      evalExegA,
      FAC_A,
      ACT_1,
      isoAt(DAY1_BASE, 0),
      'Amos arrived prepared with a Scripture-as-Resources printout but could not recall ' +
        'the genre structure of Psalm 1 without prompting. He did not lead any portion of the ' +
        'internalization block and needed significant scaffolding to articulate even the psalm\'s opening movement.',
    ),
    makeEval(
      evalExegB,
      FAC_B,
      ACT_1,
      isoAt(DAY1_BASE, 1),
      'Watched Amos in the small-group internalization segment. He was passive, reading directly ' +
        'from the text rather than demonstrating any internalized recall. When asked about the ' +
        'Selah pauses he could not connect them to the emotional arc. Exegesis absent.',
    ),
  )

  observations.push(
    makeObs(
      obsExegA,
      evalExegA,
      KSA_EXEG,
      0,
      'Amos could not recall the structure of Psalm 1 without reading directly from the text, ' +
        'and did not lead any internalization activity. Exegesis and internalization are not yet functional.',
      'He did not lead any portion of the internalization block and needed significant scaffolding ' +
        'to articulate even the psalm\'s opening movement.',
      'weak',
      FAC_A,
      isoAt(DAY1_BASE, 0.5),
    ),
    makeObs(
      obsExegB,
      evalExegB,
      KSA_EXEG,
      0,
      'Passive in the internalization segment: reading from the text rather than recalling. ' +
        'Could not connect the Selah pauses to the psalm\'s emotional arc. No evidence of prior exegetical work.',
      'When asked about the Selah pauses he could not connect them to the emotional arc. Exegesis absent.',
      'weak',
      FAC_B,
      isoAt(DAY1_BASE, 1.5),
    ),
  )

  // Confirmed 0/3: need `required` confirm verdicts per observation from DISTINCT emails.
  // obsExegA: confirmed by FAC_C and FAC_D (both distinct from FAC_A who owns the obs)
  // obsExegB: confirmed by FAC_A and FAC_C (both distinct from FAC_B who owns the obs)
  // This satisfies the "distinct evaluator emails" and "required" constraints.
  const confirmerSetsExeg: [string, string[]][] = [
    [obsExegA, [FAC_C, FAC_D].slice(0, required)],
    [obsExegB, [FAC_A, FAC_C].slice(0, required)],
  ]
  // If required > 2, pad with FAC_D for obsExegB
  if (required > 2) {
    confirmerSetsExeg[1][1].push(FAC_D)
  }

  for (const [obsId, confirmers] of confirmerSetsExeg) {
    const captureId = observations.find((o) => o.id === obsId)!.capture_client_id
    for (const confirmer of confirmers.slice(0, required)) {
      verdicts.push(makeVerdict(obsId, confirmer, captureId, isoAt(DAY1_BASE, 2)))
    }
  }

  // ── Path 2: Complementing 3/3s on GENRE (activity 2, day 2) ───────────────
  // Two evaluators independently observe Amos nailing genre mapping → both 3/3.
  // Both observations confirmed → representative = 3, no conflict.

  const evalGenreA = `${DEMO_PREFIX}eval-genre-a`
  const evalGenreB = `${DEMO_PREFIX}eval-genre-b`
  const obsGenreA = `${DEMO_PREFIX}obs-genre-a`
  const obsGenreB = `${DEMO_PREFIX}obs-genre-b`

  evaluations.push(
    makeEval(
      evalGenreA,
      FAC_A,
      ACT_2,
      isoAt(DAY2_BASE, 0),
      'Amos led the genre-mapping session with confidence. His open-ended questions drew out ' +
        'four distinct local genres from the MTTs, and he documented their functions and formal features ' +
        'clearly. His argument for the functional match to Psalm 1 was well-reasoned and the MTTs agreed.',
    ),
    makeEval(
      evalGenreB,
      FAC_B,
      ACT_2,
      isoAt(DAY2_BASE, 0.5),
      'Observed Amos in the matching discussion. He named function before form for each candidate genre, ' +
        'asked probing follow-up questions, and produced a concise written match rationale on the whiteboard. ' +
        'The team felt ownership of the choice. Exemplary facilitation.',
    ),
  )

  observations.push(
    makeObs(
      obsGenreA,
      evalGenreA,
      KSA_GENRE,
      3,
      'Led genre-mapping fluently: drew out four local genres, documented features, and argued convincingly ' +
        'for a functional match. The MTTs were active contributors throughout.',
      'His argument for the functional match to Psalm 1 was well-reasoned and the MTTs agreed.',
      'strong',
      FAC_A,
      isoAt(DAY2_BASE, 0.5),
    ),
    makeObs(
      obsGenreB,
      evalGenreB,
      KSA_GENRE,
      3,
      'Named function before form for each candidate genre; produced a concise written match rationale. ' +
        'Exemplary facilitation: the team felt ownership of the genre choice.',
      'He named function before form for each candidate genre, asked probing follow-up questions, and ' +
        'produced a concise written match rationale on the whiteboard.',
      'strong',
      FAC_B,
      isoAt(DAY2_BASE, 1),
    ),
  )

  // Confirmed 3/3: FAC_C and FAC_D confirm each observation
  const confirmerSetsGenre: [string, string[]][] = [
    [obsGenreA, [FAC_C, FAC_D].slice(0, required)],
    [obsGenreB, [FAC_C, FAC_D].slice(0, required)],
  ]

  for (const [obsId, confirmers] of confirmerSetsGenre) {
    const captureId = observations.find((o) => o.id === obsId)!.capture_client_id
    for (const confirmer of confirmers.slice(0, required)) {
      verdicts.push(makeVerdict(obsId, confirmer, captureId, isoAt(DAY2_BASE, 2)))
    }
  }

  // ── Path 3: Conflicting evaluations on CLAT (activity 2, day 2) ──────────
  // FAC_A captures at T+0 → sees Amos struggle → CLAT = 1
  // FAC_C captures at T+5h → sees a strong late session → CLAT = 3
  // Span = 5h ≥ 4h threshold → time-gap note fires.
  // Both confirmed → conflict = true (3 - 1 = 2 ≥ 2).

  const evalClatA = `${DEMO_PREFIX}eval-clat-a`
  const evalClatC = `${DEMO_PREFIX}eval-clat-c`
  const obsClatA = `${DEMO_PREFIX}obs-clat-a`
  const obsClatC = `${DEMO_PREFIX}obs-clat-c`

  const clatTimeA = isoAt(DAY2_BASE, 0)   // 14:00 Bali = 06:00 UTC
  const clatTimeC = isoAt(DAY2_BASE, 5)   // 19:00 Bali = 11:00 UTC (5h later)

  evaluations.push(
    makeEval(
      evalClatA,
      FAC_A,
      ACT_2,
      clatTimeA,
      'Amos tried to lead the CLAT Step 1 conversation but got lost between Step 2 and 3. ' +
        'He needed the facilitator guide in hand to continue. The draft he produced with the MTTs ' +
        'was faithful to the source but lost the meter of the local genre. Partial engagement.',
    ),
    makeEval(
      evalClatC,
      FAC_C,
      ACT_2,
      clatTimeC,
      'Came in for the afternoon follow-up session and found Amos leading the full CLAT flow ' +
        'independently — he had clearly prepared in the break. The MTTs were engaged and the revised draft ' +
        'was both faithful and genre-fitting. He articulated the reasoning behind two key rendering choices ' +
        'without prompting.',
    ),
  )

  observations.push(
    makeObs(
      obsClatA,
      evalClatA,
      KSA_CLAT,
      1,
      'Needed the facilitator guide to progress past Step 2; draft was faithful but lost genre ' +
        'characteristics. Leads parts with support, not yet independently.',
      'He needed the facilitator guide in hand to continue. The draft he produced … was faithful to ' +
        'the source but lost the meter of the local genre.',
      'weak',
      FAC_A,
      isoAt(DAY2_BASE, 0.5),
    ),
    makeObs(
      obsClatC,
      evalClatC,
      KSA_CLAT,
      3,
      'Led the full CLAT flow independently in the afternoon, producing a draft that was both faithful ' +
        'and genre-fitting. Articulated rendering reasoning without prompting.',
      'He had clearly prepared in the break. The revised draft was both faithful and genre-fitting. ' +
        'He articulated the reasoning behind two key rendering choices without prompting.',
      'strong',
      FAC_C,
      isoAt(DAY2_BASE, 5.5),
    ),
  )

  // Confirmed: each observation gets `required` confirms from DISTINCT evaluators.
  // obsClatA (owned by FAC_A) → confirmed by FAC_B, FAC_D
  // obsClatC (owned by FAC_C) → confirmed by FAC_A, FAC_B
  const confirmerSetsClat: [string, string[]][] = [
    [obsClatA, [FAC_B, FAC_D].slice(0, required)],
    [obsClatC, [FAC_A, FAC_B].slice(0, required)],
  ]

  for (const [obsId, confirmers] of confirmerSetsClat) {
    const captureId = observations.find((o) => o.id === obsId)!.capture_client_id
    for (const confirmer of confirmers.slice(0, required)) {
      verdicts.push(makeVerdict(obsId, confirmer, captureId, isoAt(DAY2_BASE, 6)))
    }
  }

  // ── Path 4: Late blowout on CHECK (activity 3, day 3) ────────────────────
  // After two strong days, FAC_D observes Amos completely unprepared for the
  // checking session — no consulting questions, unable to lead. CHECK = 0.
  // Confirmed → shows as a growth-area / serious lapse on the day-report.

  const evalCheckD = `${DEMO_PREFIX}eval-check-d`
  const obsCheckD = `${DEMO_PREFIX}obs-check-d`

  evaluations.push(
    makeEval(
      evalCheckD,
      FAC_D,
      ACT_3,
      isoAt(DAY3_BASE, 0),
      'Amos came to the checking practicum without any prepared consulting questions or a session plan. ' +
        'When asked to open the community check he deferred to another CIT and stood back for the entire ' +
        'session. A sharp contrast to his strong genre work the day before. No evidence of checking competency.',
    ),
  )

  observations.push(
    makeObs(
      obsCheckD,
      evalCheckD,
      KSA_CHECK,
      0,
      'Arrived without consulting questions or a session plan. Deferred all facilitation to another CIT. ' +
        'No usable checking evidence observed — a serious lapse after a strong previous day.',
      'When asked to open the community check he deferred to another CIT and stood back for the entire session.',
      'weak',
      FAC_D,
      isoAt(DAY3_BASE, 0.5),
    ),
  )

  // Confirmed: required confirms from evaluators distinct from FAC_D
  const confirmerSetsCheck = [FAC_A, FAC_B].slice(0, required)
  for (const confirmer of confirmerSetsCheck) {
    verdicts.push(makeVerdict(obsCheckD, confirmer, evalCheckD, isoAt(DAY3_BASE, 2)))
  }

  // ---------------------------------------------------------------------------
  // 4. Write to Dexie
  // ---------------------------------------------------------------------------

  await db.transaction(
    'rw',
    [db.evaluations, db.observations, db.verifications],
    async () => {
      await db.evaluations.bulkAdd(evaluations)
      await db.observations.bulkAdd(observations)
      await db.verifications.bulkAdd(verdicts)
    },
  )

  // ---------------------------------------------------------------------------
  // 5. Reconcile mentoring (auto-creates mc::demo::obs-exeg-a and mc::demo::obs-check-d)
  // ---------------------------------------------------------------------------

  await reconcileMentoringConversations()

  // ---------------------------------------------------------------------------
  // 6. Advance the 0/3 EXEG mentoring conversation to completed
  // ---------------------------------------------------------------------------

  const exegConvId = `mc::${obsExegA}`
  await completeConversation(exegConvId, {
    summary:
      'Mentor sat down with Amos for 40 minutes the morning after day 1. They worked through ' +
      'Psalm 1 together using the Four Es framework: Amos read the psalm aloud twice, then recalled it ' +
      'from memory with prompting, then identified the two-ways contrast structuring the whole poem. ' +
      'They agreed he would do a written structural outline of Psalms 1 and 13 before the next practicum ' +
      'and come with consulting questions for the genre-mapping session. Mentor emphasized that internalization ' +
      'unlocks everything else in the CLAT flow and that this was a correctable gap, not a character issue.',
    participant_response:
      'Amos received the feedback openly and without defensiveness. He acknowledged he had relied on ' +
      'his prior Psalms knowledge rather than engaging the specific internalization frameworks. He produced ' +
      'the structural outline that evening and showed it to the mentor before breakfast. His subsequent ' +
      'performance in the genre-mapping session the next day (GENRE 3/3 from two evaluators) is consistent ' +
      'with a genuine course-correction.',
    recorded_by: FAC_A,
  })

  // ---------------------------------------------------------------------------
  // 7. Count and return
  // ---------------------------------------------------------------------------

  const convCount = await db.mentoringConversations
    .filter((r) => r.id.startsWith(`mc::${DEMO_PREFIX}`))
    .count()

  return {
    evaluations: evaluations.length,
    observations: observations.length,
    verdicts: verdicts.length,
    conversations: convCount,
  }
}
