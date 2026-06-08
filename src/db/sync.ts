import { db, getOutbox } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { EvaluationRecord } from '../lib/types'

/** Map a local record to the Postgres `evaluation` row shape. */
function toRow(e: EvaluationRecord) {
  return {
    client_id: e.client_id,
    evaluator_email: e.evaluator_email,
    activity_id: e.activity_id,
    workshop_id: e.workshop_id,
    source_language: e.source_language,
    answers: e.answers,
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

/** Wire automatic sync: on reconnect and on a gentle interval. Returns a cleanup fn. */
export function startSyncLoop(): () => void {
  const onOnline = () => void pushOutbox()
  window.addEventListener('online', onOnline)
  const interval = window.setInterval(() => void pushOutbox(), 30_000)
  void pushOutbox()
  return () => {
    window.removeEventListener('online', onOnline)
    window.clearInterval(interval)
  }
}
