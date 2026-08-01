// Tiny builders for test fixtures. Keep the required-field noise out of the tests.
import type {
  Activity,
  EvaluationRecord,
  Ksa,
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
    // Defaults to null, which is what an observation imported before tl-04 holds
    // and therefore the state tl-05's derivation has to cope with. Tests that
    // care about the workshop pass one.
    workshop_id: 'workshop_id' in partial ? (partial.workshop_id ?? null) : null,
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

export function ksa(code: string, partial: Partial<Ksa> = {}): Ksa {
  return {
    id: partial.id ?? uid('ksa'),
    code,
    area: partial.area ?? `${code} area`,
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
    workshop_id: partial.workshop_id ?? 'w-1',
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
