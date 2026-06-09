// Tiny builders for test fixtures. Keep the required-field noise out of the tests.
import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict } from '../src/lib/types'

let n = 0
const uid = (p: string) => `${p}-${++n}`

export function obs(partial: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: partial.id ?? uid('obs'),
    capture_client_id: partial.capture_client_id ?? 'cap-1',
    participant_id: 'participant_id' in partial ? (partial.participant_id ?? null) : 'p-1',
    participant_name: partial.participant_name ?? 'CIT One',
    ksa_code: partial.ksa_code ?? 'GENRE',
    text: partial.text ?? 'did a thing',
    source_excerpt: partial.source_excerpt ?? 'quote',
    evidence_designation: partial.evidence_designation ?? 2,
    sentiment_flag: partial.sentiment_flag ?? 'neutral',
    confidence: partial.confidence ?? 'high',
    needs_review: partial.needs_review ?? false,
    origin: partial.origin ?? 'individual',
    imported_at: partial.imported_at ?? 'test',
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
    description: partial.description ?? '',
    evaluator_facing_prompt: partial.evaluator_facing_prompt ?? 'prompt?',
    ai_facing_rubric: partial.ai_facing_rubric ?? 'rubric',
    evidence_levels: partial.evidence_levels ?? { '0': 'a', '1': 'b', '2': 'c', '3': 'd' },
    cbc_subpoint_refs: partial.cbc_subpoint_refs ?? ['Sub A'],
  }
}

export function participant(partial: Partial<Participant> = {}): Participant {
  return {
    id: partial.id ?? 'p-1',
    workshop_id: partial.workshop_id ?? 'w-1',
    name: partial.name ?? 'CIT One',
    registered_email: partial.registered_email ?? null,
    team_id: partial.team_id ?? 't-1',
    preferred_language: partial.preferred_language ?? 'English',
  }
}

export function team(partial: Partial<Team> = {}): Team {
  return { id: partial.id ?? 't-1', workshop_id: partial.workshop_id ?? 'w-1', name: partial.name ?? 'Team A' }
}
