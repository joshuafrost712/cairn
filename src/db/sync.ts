import { db, getOutbox } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { EvaluationRecord, MentoringConversation } from '../lib/types'

/** Map a local record to the Postgres `evaluation` row shape. */
function toRow(e: EvaluationRecord) {
  return {
    client_id: e.client_id,
    evaluator_email: e.evaluator_email,
    activity_id: e.activity_id,
    workshop_id: e.workshop_id,
    source_language: e.source_language,
    answers: e.answers,
    quick_ratings: e.quick_ratings ?? {},
    focus_participant_id: e.focus_participant_id ?? null,
    source_text: e.source_text,
    participant_scope: e.participant_scope,
    attestation: e.attestation,
    ruleset_version: e.ruleset_version,
    edit_history: e.edit_history,
    created_at: e.created_at,
    updated_at: e.updated_at,
  }
}

let running = false

/**
 * Push every pending evaluation to the backend. Safe to call repeatedly; it
 * no-ops when offline, unconfigured, or already running. Upserts on client_id so
 * re-sending an already-synced row is harmless (idempotent).
 */
export async function pushOutbox(): Promise<{ pushed: number; failed: number }> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine || running) {
    return { pushed: 0, failed: 0 }
  }
  running = true
  let pushed = 0
  let failed = 0
  try {
    const pending = await getOutbox()
    for (const e of pending) {
      const { data, error } = await supabase
        .from('evaluation')
        .upsert(toRow(e), { onConflict: 'client_id' })
        .select('id')
        .single()
      if (error) {
        failed++
        await db.evaluations.update(e.client_id, {
          sync_status: 'error',
          sync_error: error.message,
        })
      } else {
        pushed++
        await db.evaluations.update(e.client_id, {
          sync_status: 'synced',
          server_id: data?.id,
          sync_error: null,
        })
      }
    }
  } finally {
    running = false
  }
  return { pushed, failed }
}

/** Map a local MentoringConversation to the Postgres `mentoring_conversation` row shape. */
function toMentoringRow(m: MentoringConversation) {
  return {
    id: m.id,
    participant_id: m.participant_id,
    participant_name: m.participant_name,
    workshop_id: m.workshop_id,
    trigger_observation_id: m.trigger_observation_id,
    trigger_ksa_code: m.trigger_ksa_code,
    trigger_designation: m.trigger_designation,
    trigger_activity_id: m.trigger_activity_id,
    status: m.status,
    scheduled_for: m.scheduled_for,
    summary: m.summary,
    participant_response: m.participant_response,
    recorded_by: m.recorded_by,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
}

let mentoringRunning = false

/**
 * Push all local mentoring_conversation rows (sync_status === 'local' or 'error')
 * to Supabase. Upserts on id so re-sending is harmless.
 */
export async function pushMentoringOutbox(): Promise<{ pushed: number; failed: number }> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine || mentoringRunning) {
    return { pushed: 0, failed: 0 }
  }
  mentoringRunning = true
  let pushed = 0
  let failed = 0
  try {
    const pending = await db.mentoringConversations
      .where('sync_status')
      .anyOf('local', 'queued', 'error')
      .toArray()
    for (const m of pending) {
      const { error } = await supabase
        .from('mentoring_conversation')
        .upsert(toMentoringRow(m), { onConflict: 'id' })
      if (error) {
        failed++
        await db.mentoringConversations.update(m.id, {
          sync_status: 'error',
          sync_error: error.message,
        })
      } else {
        pushed++
        await db.mentoringConversations.update(m.id, {
          sync_status: 'synced',
          sync_error: null,
        })
      }
    }
  } finally {
    mentoringRunning = false
  }
  return { pushed, failed }
}

/** Wire automatic sync: on reconnect and on a gentle interval. Returns a cleanup fn. */
export function startSyncLoop(): () => void {
  const onOnline = () => {
    void pushOutbox()
    void pushMentoringOutbox()
  }
  window.addEventListener('online', onOnline)
  const interval = window.setInterval(() => {
    void pushOutbox()
    void pushMentoringOutbox()
  }, 30_000)
  void pushOutbox()
  void pushMentoringOutbox()
  return () => {
    window.removeEventListener('online', onOnline)
    window.clearInterval(interval)
  }
}
