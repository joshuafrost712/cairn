// Shared entity types. Mirror the Postgres schema (supabase/migrations/20260608000100_foundation_schema.sql).

// The technical KSA areas of the Psalms Workshop (OBT CDT Workshop 3, Bali 2026).
// The interpersonal-interaction competency (INTERP, teaching sessions) is authored
// in the seed data alongside these; this list is not currently referenced elsewhere.
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
  /**
   * Optional profile fields, added after the roster already existed. OPTIONAL
   * rather than nullable-required on purpose: an absent property and an explicit
   * null mean the same thing to every reader here, and making them required would
   * force a value into ~45 seed literals and every test factory for no gain.
   *
   * None of them is a Dexie index, so they need no `.stores()` declaration and no
   * schema version. They reach Postgres for free: upsertParticipant() enqueues the
   * whole object and loadReferenceData() pulls `select('*')`.
   */
  /** Used for the per-team composition read on the roster. Blank is a real answer. */
  sex?: 'male' | 'female' | null
  /** The organization they serve with, free text (e.g. "SIL Indonesia"). */
  organization?: string | null
  /** Years in translation work. Context for reading a low designation, not a score. */
  years_of_service?: number | null
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

/**
 * The platform tier. Deliberately tiny, and not an evaluation role.
 *
 * `platform_owner` exists because membership cannot bootstrap itself: a fresh
 * deployment needs somebody able to create the first workshop before any
 * membership row exists. It grants exactly three powers (create a workshop,
 * manage the allowlist, recover a workshop whose chief admin is gone) and grants
 * nothing inside a workshop it holds no membership in.
 *
 * Everything an evaluator, consultant, or admin can do is a `WorkshopRole` held
 * through `WorkshopMember`.
 */
export type PlatformRole = 'platform_owner' | 'member'

/** A role held inside one workshop. Ordered most to least privileged. */
export const WORKSHOP_ROLES = [
  'chief_admin',
  'admin',
  'chief_evaluator',
  'consultant',
  'evaluator',
  'participant',
] as const

export type WorkshopRole = (typeof WORKSHOP_ROLES)[number]

export interface AppUser {
  id: string
  name: string
  email: string
  role: PlatformRole
}

/**
 * One person's role in one workshop. The authoritative copy lives in Postgres
 * (`workshop_member`) and is enforced by RLS; the client caches it in Dexie so
 * role resolution survives a cold offline start.
 *
 * The cache is a convenience for deciding what to render. It is NEVER an
 * authorization source: every read and write is re-checked server-side against
 * `auth.uid()`, so a tampered cache changes what the UI offers and nothing about
 * what the database returns.
 */
export interface WorkshopMember {
  /** `${workshop_id}::${app_user_id}` — the composite key flattened for Dexie. */
  pk: string
  workshop_id: string
  app_user_id: string
  role: WorkshopRole
  added_by?: string | null
  added_at?: string | null
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

/**
 * Denormalized "who has been evaluated for this activity" row. One per submitted
 * evaluation (keyed by the same client_id), fed from the local device's own
 * submissions and from other devices via Supabase Realtime. The participant
 * selector live-queries an aggregate of these to show coverage. See db/coverage.ts.
 */
export interface CoverageRow {
  client_id: string
  activity_id: string | null
  workshop_id: string | null
  evaluator_email: string | null
  /** union of participant_scope[].participant_id and focus_participant_id */
  participant_ids: string[]
  submitted_at: string
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

/**
 * Reference-authoring outbox (client-only; no Postgres twin). The Scenario Builder
 * writes workshops/activities/KSAs/wiring to the local cache immediately, then
 * queues the corresponding backend upsert/delete here. pushReferenceOutbox()
 * (src/db/referenceWrite.ts) replays these to Supabase; loadReferenceData() drains
 * the queue BEFORE its destructive pull so authored edits are never clobbered.
 */
export type ReferenceTable =
  | 'workshop'
  | 'team'
  | 'participant'
  | 'activity'
  | 'ksa'
  | 'activity_ksa'

export interface ReferenceOutboxEntry {
  /** `${table}:${rowKey}` — repeated edits to the same row collapse to one entry. */
  id: string
  table: ReferenceTable
  op: 'upsert' | 'delete'
  /** the row id, or `${activity_id}::${ksa_id}` for activity_ksa (its composite key). */
  rowKey: string
  /** the Postgres row to upsert; null for a delete. */
  payload: object | null
  at: string
  /**
   * Set when the backend REFUSED this write on authorization grounds rather than
   * failing transiently. Retrying cannot fix it: the caller does not hold the role
   * the policy requires.
   *
   * This distinction became load-bearing with tl-01. Before per-workshop RLS, every
   * failure here was a network problem, so "stay queued and retry" was always
   * right, and `loadReferenceData()` could safely refuse to refresh while anything
   * was pending. A permanently rejected entry under that rule would block reference
   * refresh on the device forever, silently — so rejected entries are excluded from
   * the pending count while being kept for inspection rather than discarded.
   */
  rejected?: boolean
  /** The backend's own message for a rejected entry. Kept verbatim, for diagnosis. */
  rejectedReason?: string | null
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
