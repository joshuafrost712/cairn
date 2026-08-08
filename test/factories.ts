// Tiny builders for test fixtures. Keep the required-field noise out of the tests.
import type { ResolvedKsa } from '../src/lib/goals'
import type {
  Activity,
  EvaluationRecord,
  ObservationRecord,
  Participant,
  Team,
  VerificationVerdict,
} from '../src/lib/types'

let n = 0
const uid = (p: string) => `${p}-${++n}`

export function obs(partial: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: partial.id ?? uid('obs'),
    capture_client_id: partial.capture_client_id ?? 'cap-1',
    // Required on ObservationRecord since tl-04 and missing here until tl-17.
    // Same blind spot as `short_label` below: test/ is outside tsconfig.app's
    // include, so a fixture can omit a required field and nothing complains
    // until something actually reads it. `in` rather than `??` so an explicit
    // null exercises the pre-tl-04 fallback path.
    //
    // The merge kept tl-17's 'w-1' over tl-05's null. tl-05 wanted the default to
    // be the pre-tl-04 state its derivation has to cope with, but every one of its
    // tests that cares passes `workshop_id` explicitly — including the null cases —
    // so the fallback path stays covered while the default matches what the type
    // has actually required since tl-04. A default of null would instead let a new
    // fixture omit a required field and read as the fallback case by accident.
    workshop_id: 'workshop_id' in partial ? (partial.workshop_id ?? null) : 'w-1',
    participant_id: 'participant_id' in partial ? (partial.participant_id ?? null) : 'p-1',
    participant_name: partial.participant_name ?? 'CIT One',
    ksa_code: partial.ksa_code ?? 'GENRE',
    text: partial.text ?? 'did a thing',
    // `?? ` would swallow an explicit null, and a fixture that asks for an
    // observation with no excerpt is asking to exercise the no-excerpt branch.
    source_excerpt: 'source_excerpt' in partial ? (partial.source_excerpt ?? null) : 'quote',
    evidence_designation: partial.evidence_designation ?? 2,
    sentiment_flag: partial.sentiment_flag ?? 'neutral',
    confidence: partial.confidence ?? 'high',
    needs_review: partial.needs_review ?? false,
    origin: partial.origin ?? 'individual',
    imported_at: partial.imported_at ?? 'test',
    evaluator_email: partial.evaluator_email ?? null,
  }
}

export function verdict(partial: Partial<VerificationVerdict> & { observation_id: string; evaluator_email: string }): VerificationVerdict {
  return {
    id: `${partial.observation_id}::${partial.evaluator_email}`,
    observation_id: partial.observation_id,
    capture_client_id: partial.capture_client_id ?? 'cap-1',
    evaluator_email: partial.evaluator_email,
    decision: partial.decision ?? 'confirm',
    adjusted_designation: partial.adjusted_designation ?? null,
    note: partial.note ?? null,
    at: partial.at ?? '2026-06-09T00:00:00.000Z',
  }
}

/**
 * A question in its RESOLVED shape (tl-08).
 *
 * `ResolvedKsa` rather than `Ksa` because that is what the reports and AI layers
 * take now: the group heading comes from the question's goal, not from a free-text
 * field on the question itself. `goal_title` is what the old `area` argument meant
 * all along — the heading a report prints — so the frozen-output snapshots below
 * stayed frozen through the change, which is exactly what they are for.
 */
export function ksa(code: string, partial: Partial<ResolvedKsa> = {}): ResolvedKsa {
  return {
    id: partial.id ?? uid('ksa'),
    workshop_id: partial.workshop_id ?? 'w-1',
    code,
    goal_id: partial.goal_id ?? `goal-${code}`,
    goal_title: partial.goal_title ?? `${code} area`,
    goal_sort: partial.goal_sort ?? 0,
    // Required on Ksa and previously missing here. test/ is outside tsconfig.app's
    // include, so tsc never caught it; the dashboard reads it for column headers.
    short_label: partial.short_label ?? code,
    description: partial.description ?? '',
    evaluator_facing_prompt: partial.evaluator_facing_prompt ?? 'prompt?',
    ai_facing_rubric: partial.ai_facing_rubric ?? 'rubric',
    evidence_levels: partial.evidence_levels ?? { '0': 'a', '1': 'b', '2': 'c', '3': 'd' },
    cbc_subpoint_refs: partial.cbc_subpoint_refs ?? ['Sub A'],
  }
}

export function activity(partial: Partial<Activity> = {}): Activity {
  return {
    id: partial.id ?? uid('act'),
    workshop_id: partial.workshop_id ?? 'w-1',
    title: partial.title ?? 'An activity',
    day: 'day' in partial ? (partial.day ?? null) : '2026-08-26',
    start_time: partial.start_time ?? null,
    end_time: partial.end_time ?? null,
    sort_order: partial.sort_order ?? 0,
    genre_group: partial.genre_group ?? null,
  }
}

export function evaluation(partial: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    client_id: partial.client_id ?? uid('cap'),
    evaluator_email: 'evaluator_email' in partial ? (partial.evaluator_email ?? null) : 'a@x.org',
    activity_id: 'activity_id' in partial ? (partial.activity_id ?? null) : 'act-1',
    // `in` rather than `??`, exactly as `obs()` above does and for the same reason
    // (tl-29): `EvaluationRecord.workshop_id` is nullable, that null is the pre-tl-04
    // capture the scoping rules have to cope with, and `?? 'w-1'` SWALLOWED an explicit
    // null so a test asking for a workshop-less capture silently got a workshop-1 one.
    // Two tl-29 scope tests passed for the wrong reason before this was fixed.
    workshop_id: 'workshop_id' in partial ? (partial.workshop_id ?? null) : 'w-1',
    source_language: partial.source_language ?? 'English',
    answers: partial.answers ?? {},
    source_text: partial.source_text ?? 'text',
    participant_scope: partial.participant_scope ?? [],
    attestation: partial.attestation ?? true,
    ruleset_version: partial.ruleset_version ?? '1',
    edit_history: partial.edit_history ?? [],
    created_at: partial.created_at ?? '2026-08-26T09:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-08-26T09:00:00.000Z',
    sync_status: partial.sync_status ?? 'synced',
    routing_status: partial.routing_status ?? 'routed',
  }
}

export function participant(partial: Partial<Participant> = {}): Participant {
  return {
    id: partial.id ?? 'p-1',
    workshop_id: partial.workshop_id ?? 'w-1',
    name: partial.name ?? 'CIT One',
    registered_email: partial.registered_email ?? null,
    team_id: 'team_id' in partial ? (partial.team_id ?? null) : 't-1',
    preferred_language: partial.preferred_language ?? 'English',
    // The profile fields default to ABSENT, not null, because that is the state
    // every row on a real roster starts in and the one the code has to handle.
    ...('sex' in partial ? { sex: partial.sex } : {}),
    ...('organization' in partial ? { organization: partial.organization } : {}),
    ...('years_of_service' in partial ? { years_of_service: partial.years_of_service } : {}),
  }
}

export function team(partial: Partial<Team> = {}): Team {
  return { id: partial.id ?? 't-1', workshop_id: partial.workshop_id ?? 'w-1', name: partial.name ?? 'Team A' }
}
