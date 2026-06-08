// Shared entity types. Mirror the Postgres schema (supabase/migrations/0001_foundation_schema.sql).

// The six KSA areas of the Psalms Workshop (OBT CDT Workshop 3, Bali 2026).
export const KSA_AREAS = [
  'The CLAT Process and Translation of Aesthetic Language',
  'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms',
  'Genre Theory, Discovery, and Matching',
  'Psalms Exegesis and Internalization',
  'Checking Artistic Translations',
  'Advocacy and Community Integration',
] as const

export type KsaArea = (typeof KSA_AREAS)[number]

export interface Workshop {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
  location: string | null
  languages: string[]
}

export interface Team {
  id: string
  workshop_id: string
  name: string
}

export interface Participant {
  id: string
  workshop_id: string
  name: string
  registered_email: string | null
  team_id: string | null
  preferred_language: string | null
}

export interface Activity {
  id: string
  workshop_id: string
  title: string
  day: string | null
  start_time: string | null
  end_time: string | null
  sort_order: number
  genre_group: string | null
}

/** evidence_levels: what observed evidence merits each 0-3 designation. */
export type EvidenceLevels = Partial<Record<'0' | '1' | '2' | '3', string>>

export interface Ksa {
  id: string
  code: string
  area: string
  description: string
  evaluator_facing_prompt: string
  ai_facing_rubric: string | null
  evidence_levels: EvidenceLevels | null
  cbc_subpoint_refs: string[]
}

export interface ActivityKsa {
  activity_id: string
  ksa_id: string
  sort_order: number
}

export interface AppUser {
  id: string
  name: string
  email: string
  role: 'evaluator' | 'consultant' | 'admin'
}

/** A name/id the evaluator was watching during a capture. */
export interface ParticipantScopeEntry {
  participant_id?: string
  name: string
}

export interface EditHistoryEntry {
  at: string // ISO timestamp
  prevAnswers: Record<string, string>
}

export type SyncStatus = 'local' | 'queued' | 'synced' | 'error'

/**
 * The raw capture an evaluator produces. Stored locally first (Dexie), then synced
 * to Postgres. `client_id` is the stable identity across the offline -> online boundary.
 */
export interface EvaluationRecord {
  client_id: string
  server_id?: string // assigned by Postgres on first successful sync
  evaluator_email: string | null
  evaluator_id?: string | null
  activity_id: string | null
  workshop_id: string | null
  source_language: string
  /** per-question capture, keyed by ksa_id -> text */
  answers: Record<string, string>
  /** readable free-form composed from answers; what the (deferred) AI routing reads */
  source_text: string
  participant_scope: ParticipantScopeEntry[]
  attestation: boolean
  ruleset_version: string | null
  edit_history: EditHistoryEntry[]
  created_at: string
  updated_at: string
  sync_status: SyncStatus
  sync_error?: string | null
}
