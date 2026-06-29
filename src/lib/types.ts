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
  /** Concrete "look/listen for" prompts shown under the question during capture. */
  guiding_questions?: string[]
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
  /**
   * GitHub routing state (no metered API — routing runs on a repo via Claude Max):
   * absent = not yet sent to the routing repo; 'sent' = capture pushed to inbox/;
   * 'routed' = observations imported back from outbox/.
   */
  routing_status?: 'sent' | 'routed'
}

/** An individual-level observation imported from routing/outbox/ (Claude-produced). */
export interface ObservationRecord {
  id: string // `${capture_client_id}::${index}`
  capture_client_id: string
  participant_id: string | null
  participant_name: string
  ksa_code: string
  text: string
  source_excerpt: string
  evidence_designation: 0 | 1 | 2 | 3
  sentiment_flag: 'strong' | 'weak' | 'neutral'
  confidence: 'low' | 'medium' | 'high'
  needs_review: boolean
  origin: 'individual' | 'group'
  imported_at: string
  /**
   * Email of the evaluator whose capture produced this observation, resolved at
   * ingest from the local evaluation or the routing inbox capture file. Lets the
   * end-of-day email attribute who said what when several evaluators score the
   * same participant. Best-effort: null when the originating capture can't be found.
   */
  evaluator_email?: string | null
}

/** One evaluator's verdict on one observation (the multi-evaluator gate). */
export type VerificationDecision = 'confirm' | 'adjust' | 'reject'

export interface VerificationVerdict {
  id: string // `${observation_id}::${evaluator_email}` — one current verdict per evaluator per observation
  observation_id: string
  capture_client_id: string // for grouping + future sync
  evaluator_email: string
  decision: VerificationDecision
  /** the designation this evaluator believes is correct, when decision === 'adjust' */
  adjusted_designation?: 0 | 1 | 2 | 3 | null
  note?: string | null
  at: string
}
