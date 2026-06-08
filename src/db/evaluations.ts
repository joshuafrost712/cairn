import { db } from './local'
import { pushOutbox } from './sync'
import { RULESET_VERSION } from '../lib/ruleset'
import type { EvaluationRecord, ParticipantScopeEntry } from '../lib/types'

// Stable client id without depending on crypto.randomUUID availability quirks.
function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
}

interface DraftInput {
  evaluatorEmail: string | null
  workshopId: string | null
  activityId: string | null
}

/** Create a fresh local draft. Persisted immediately; status 'local'. */
export async function createDraft(input: DraftInput): Promise<EvaluationRecord> {
  const now = new Date().toISOString()
  const record: EvaluationRecord = {
    client_id: newClientId(),
    evaluator_email: input.evaluatorEmail,
    activity_id: input.activityId,
    workshop_id: input.workshopId,
    source_language: 'English',
    answers: {},
    source_text: '',
    participant_scope: [],
    attestation: false,
    ruleset_version: null,
    edit_history: [],
    created_at: now,
    updated_at: now,
    sync_status: 'local',
  }
  await db.evaluations.put(record)
  return record
}

/**
 * Persist the per-question answers immediately (offline-safe). Called on every
 * keystroke/blur during capture. When `recordEdit` is set (post-submit editing),
 * the prior answers are snapshotted to edit_history first, supporting undo.
 */
export async function saveAnswers(
  clientId: string,
  answers: Record<string, string>,
  opts: { recordEdit?: boolean; participant_scope?: ParticipantScopeEntry[]; source_language?: string } = {},
): Promise<void> {
  const existing = await db.evaluations.get(clientId)
  if (!existing) return
  const edit_history = [...existing.edit_history]
  if (opts.recordEdit) {
    edit_history.push({ at: new Date().toISOString(), prevAnswers: existing.answers })
  }
  await db.evaluations.update(clientId, {
    answers,
    edit_history,
    ...(opts.participant_scope ? { participant_scope: opts.participant_scope } : {}),
    ...(opts.source_language ? { source_language: opts.source_language } : {}),
    updated_at: new Date().toISOString(),
    // a synced row that gets edited rejoins the outbox
    sync_status: existing.sync_status === 'synced' ? 'queued' : existing.sync_status,
  })
  if (existing.sync_status === 'synced') void pushOutbox()
}

/** Undo the most recent recorded edit, restoring the prior answers. Returns them. */
export async function undoLastEdit(clientId: string): Promise<Record<string, string> | null> {
  const existing = await db.evaluations.get(clientId)
  if (!existing || existing.edit_history.length === 0) return null
  const history = [...existing.edit_history]
  const last = history.pop()!
  await db.evaluations.update(clientId, {
    answers: last.prevAnswers,
    edit_history: history,
    updated_at: new Date().toISOString(),
    sync_status: existing.sync_status === 'synced' ? 'queued' : existing.sync_status,
  })
  void pushOutbox()
  return last.prevAnswers
}

/** Attest + submit: store composed source_text, ruleset version, queue for sync. */
export async function submitEvaluation(
  clientId: string,
  patch: {
    answers: Record<string, string>
    source_text: string
    participant_scope: ParticipantScopeEntry[]
    source_language: string
  },
): Promise<void> {
  await db.evaluations.update(clientId, {
    ...patch,
    attestation: true,
    ruleset_version: RULESET_VERSION,
    sync_status: 'queued',
    updated_at: new Date().toISOString(),
  })
  void pushOutbox()
}

export function getEvaluation(clientId: string) {
  return db.evaluations.get(clientId)
}
