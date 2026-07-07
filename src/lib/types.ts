// Shared entity types. Mirror the Postgres schema (supabase/migrations/20260608000100_foundation_schema.sql).

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
  /** Short scannable heading for the capture card (e.g. "CLAT facilitation & drafting"). */
  short_label: string
  description: string
  /** Reframed as a neutral observation cue ("How did they…?"), not a yes/no verdict. */
  evaluator_facing_prompt: string
  ai_facing_rubric: string | null
  evidence_levels: EvidenceLevels | null
  cbc_subpoint_refs: string[]
  /** Concrete "look/listen for" prompts shown under the question during capture. */
  guiding_questions?: string[]
}

/** An evaluator's optional quick 0-3 read on a KSA, keyed by ksa_id. */
export type QuickRatings = Record<string, 0 | 1 | 2 | 3>

export interface ActivityKsa {
  activity_id: string
  ksa_id: string
  sort_order: number
}

export interface AppUser {
  id: string
  name: string
  email: string
  role: 'evaluator' | 'consultant' | 'chief_evaluator' | 'admin' | 'participant'
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
  /**
   * Optional per-KSA quick read the evaluator can tap during capture. A prior the
   * AI routing reads, not a final score; the multi-evaluator gate still rules.
   * Keyed by ksa_id; absent entries mean "no read".
   */
  quick_ratings?: QuickRatings
  /**
   * When focus mode is on during capture, the single CIT the evaluator chose to
   * watch. Null/absent = multi-person capture (the default).
   */
  focus_participant_id?: string | null
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

export type MentoringStatus = 'needed' | 'scheduled' | 'completed' | 'dismissed'

/**
 * A mentoring conversation triggered by a confirmed low observation
 * (effective_designation 0 or 1 on a verified/adjusted observation). When a
 * participant scores a confirmed low on a KSA, the mentor holds a short
 * follow-up the next day; how the participant responds to correction is itself
 * evaluation data. One record per triggering observation; idempotent on
 * re-derive because the id is derived from the observation id.
 */
export interface MentoringConversation {
  /** deterministic: `mc::${trigger_observation_id}` so re-derivation never duplicates */
  id: string
  participant_id: string
  participant_name: string
  workshop_id: string | null
  trigger_observation_id: string | null
  trigger_ksa_code: string | null
  trigger_designation: number | null // 0 or 1
  trigger_activity_id: string | null
  status: MentoringStatus
  scheduled_for: string | null // ISO date
  summary: string | null // "we talked about X, Y, Z"
  participant_response: string | null // how they handled it
  recorded_by: string | null // evaluator email
  created_at: string
  updated_at: string
  sync_status: SyncStatus // reuse existing type
  sync_error?: string | null
}

/**
 * A record that the chief evaluator has acknowledged and reconciled a discrepancy.
 * Keyed by a deterministic id: `disc::${participant_id}::${ksa_code}`.
 * Sync is local-only for now; add a sync_status field and Supabase upsert if remote
 * reconciliation records become needed.
 */
export interface DiscrepancyResolution {
  /** deterministic: `disc::${participant_id}::${ksa_code}` */
  id: string
  resolved_by: string // evaluator email
  note: string | null
  at: string // ISO timestamp
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
