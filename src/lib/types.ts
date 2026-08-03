// Shared entity types. Mirror the Postgres schema (supabase/migrations/20260608000100_foundation_schema.sql).

// Type-only, so this stays a leaf module at runtime: the severity and state unions
// are DEFINED by the classifier (src/setup/impact.ts), and re-declaring them here
// would let the log's idea of a severity drift from the dialog's.
import type { SetupEntity, SetupOperation, SetupSeverity, WorkshopState } from '../setup/impact'

// The technical KSA areas of the Psalms Workshop (OBT CDT Workshop 3, Bali 2026).
//
// SEED DATA ONLY (tl-08). This was the de-facto vocabulary for the level above a
// question, offered as a datalist suggestion against a free-text `ksa.area`
// string. It is no longer a source of truth for anything: that level is now the
// `goal` table, per workshop, populated with whatever the organization running
// the workshop is actually training toward. These six strings survive because
// they are what the Psalms workshop's goals are seeded and demo'd with — a
// starting point somebody edits, not a constraint.
//
// Do not read this to group, sort, validate, or label anything. Ask the goal.
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
  /**
   * What THIS workshop calls the level above a question: "KSA area" for the OBT
   * track, "Competency" or "Outcome" for somebody else. Null means the app
   * default (see GOAL_LABEL_DEFAULT in lib/goals.ts).
   *
   * A label rather than a rename, because the entity is the same everywhere and
   * only the word differs. Optional on the type so the ~45 seed literals and
   * every test factory did not have to grow a field none of them care about.
   */
  goal_label?: string | null
}

/**
 * The level above a question: what the workshop is evaluating FOR (tl-08).
 *
 * Joshua's feedback asked for "the highest-level KSAs (or whatever other goals
 * they have)", and the parenthesis is why this is a table rather than a rename.
 * Before tl-08 this level was a free-text string on each question, checked
 * against a hardcoded list of the six Psalms competency areas — load-bearing for
 * every report grouping while being unvalidated in storage.
 *
 * A goal groups questions for display and for the report headings. It carries no
 * score of its own: inventing an aggregate designation for a goal is a research
 * question about how competencies compose, not a setup feature.
 */
export interface Goal {
  id: string
  workshop_id: string
  /** Short handle, unique inside the workshop (G1, ORAL, …). Not globally unique. */
  code: string
  /** What the reports print as the group heading. */
  title: string
  description: string | null
  sort_order: number
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

/**
 * What observed evidence merits each point of the workshop's scale, keyed by the
 * point's VALUE as a string ("0", "1", … or "1" … "5" on a 1-5 scale).
 *
 * Widened from `Partial<Record<'0'|'1'|'2'|'3', string>>` by tl-09. Structurally
 * it was always this: a jsonb object with numeric-string keys. What is gone is
 * the compile-time promise that a key is one of four, and what replaces it is
 * `scaleValues()` — every editor and renderer iterates the workshop's scale
 * rather than a literal list, so a descriptor for a point the scale no longer has
 * is retained in storage and simply not shown. That retention is deliberate:
 * shortening a scale and lengthening it again must not destroy authored text.
 */
export type EvidenceLevels = Record<string, string>

export interface Ksa {
  id: string
  /**
   * The workshop this question belongs to (tl-08). Before then `ksa` was a global
   * library: two workshops in one deployment shared one question pool, so a code
   * collision between organizations was a data corruption rather than a warning.
   */
  workshop_id: string
  /** Unique within the workshop, not across the deployment. Two workshops may both hold a Q1. */
  code: string
  /** The goal this question sits under. Null means ungrouped, which is legal and visible. */
  goal_id: string | null
  /**
   * @deprecated LEGACY (tl-08). The free-text group string that `goal_id`
   * replaced. Retained on the type only because the Postgres column is retained
   * for one release cycle so a pre-tl-08 client keeps working. App code must
   * neither read nor write it: the group label comes from the goal, through
   * `withGoalTitles()` in lib/goals.ts. Two writable copies of one fact is how
   * they come to disagree.
   */
  area?: string | null
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

/**
 * An evaluator's optional quick read on a KSA, keyed by ksa_id.
 *
 * The value is a point on the workshop's scale (tl-09), not an index into it, and
 * not a literal union any more. Validate with `isValidDesignation` before storing
 * one that came from outside this device.
 */
export type QuickRatings = Record<string, number>

export interface ActivityKsa {
  activity_id: string
  ksa_id: string
  sort_order: number
  /**
   * Per-event wording for this question (tl-08). Null means "use the question's
   * own value", which is the case for almost every row and is why these are
   * nullable rather than copies.
   *
   * The requirement is Joshua's "the KSA prompts for each event": the same
   * competency is looked for differently during a lecture than during a practice
   * session. Resolution happens in exactly ONE place, `ksasForActivity()`, so the
   * capture screen, the Setup preview and the routing capture file cannot show an
   * evaluator three different questions.
   *
   * There is deliberately no override for `ai_facing_rubric`. One question means
   * one thing to the router; per-event wording is about how a human is prompted
   * to look, not about what the evidence is.
   */
  prompt_override?: string | null
  /** Null = use the question's own. An EMPTY array means "show none on this event". */
  guiding_questions_override?: string[] | null
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

/**
 * Another person in a workshop you belong to: their membership joined to their
 * name and email.
 *
 * Distinct from `WorkshopMember`, which is deliberately only ever the CALLER's
 * own rows (see db/membership.ts). Assignment needs the opposite question, "who
 * else is here", and needs it to include evaluators who have not captured
 * anything yet, so it cannot be derived from observations.
 *
 * Readable without new policy work: `workshop_member_select` already permits the
 * roster of a workshop you belong to, and `app_user_select` permits people you
 * share a workshop with. Like every other client cache here it decides what to
 * render and never what is allowed.
 */
export interface WorkshopPerson {
  /** `${workshop_id}::${app_user_id}` — the composite key flattened for Dexie. */
  pk: string
  workshop_id: string
  app_user_id: string
  /** Lowercased. The key every evaluator-facing record in this app joins on. */
  email: string
  name: string
  role: WorkshopRole
}

/**
 * One membership change, as recorded by the tl-02 RPCs.
 *
 * Append-only in Postgres (`membership_change_log` has no update or delete
 * policy) and never written from a browser. The email columns are denormalized
 * because both id columns are `on delete set null`: the account-deletion case the
 * recovery path exists for would otherwise erase the row that explains it.
 */
export interface MembershipChangeLog {
  id: string
  workshop_id: string
  actor_app_user_id: string | null
  actor_email: string | null
  target_app_user_id: string | null
  target_email: string | null
  /** Null when the person held no membership before the change. */
  from_role: WorkshopRole | null
  /** Null when the change was a removal. */
  to_role: WorkshopRole | null
  operation: 'grant' | 'revoke' | 'transfer' | 'recover'
  at: string
}

/**
 * The settings that belong to a workshop rather than to a device.
 *
 * `required_confirmations` lived in localStorage until Wave 2, which made an
 * administrator's threshold change invisible to every phone but their own. A
 * quota an admin sets on somebody else's behalf has the same problem and worse
 * consequences, so both live here now.
 */
export const SETTING_KEYS = [
  'required_confirmations',
  'review_quota_default',
  'review_quota_overrides',
  'observation_quota_default',
  'observation_quota_overrides',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

/** One `workshop_setting` row, cached locally so settings survive going offline. */
export interface WorkshopSettingRow {
  /** `${workshop_id}::${key}` — the composite key flattened for Dexie. */
  pk: string
  workshop_id: string
  key: SettingKey
  /** jsonb in Postgres: a number for the scalars, an email → n map for the overrides. */
  value: unknown
  updated_by?: string | null
  updated_at?: string | null
}

/** The resolved settings for one workshop, with every default already applied. */
export interface WorkshopSettings {
  /** Evaluators who must confirm an observation before it counts. */
  requiredConfirmations: number
  /** How many participants an evaluator is expected to carry, per kind. */
  reviewQuotaDefault: number | null
  observationQuotaDefault: number | null
  /** Per-evaluator overrides, keyed by lowercased email. */
  reviewQuotaOverrides: Record<string, number>
  observationQuotaOverrides: Record<string, number>
}

/**
 * What an assignment obliges someone to do.
 *
 * `review` is ownership of clearing a participant's report through the
 * verification gate: casting confirm/adjust/reject verdicts on their
 * observations. `observation` is ownership of watching them and capturing.
 * They are different jobs held by overlapping people, which is why one kind
 * column beats two tables.
 */
export type AssignmentKind = 'review' | 'observation'

/** How an assignment came to exist. Kept so auto-assign can be audited. */
export type AssignmentSource = 'auto' | 'manual' | 'transfer'

/**
 * One evaluator's responsibility for one participant.
 *
 * Keyed on `evaluator_email` rather than `app_user.id` because every other
 * evaluator-keyed record in this app already is (`observation.evaluator_email`,
 * `VerificationVerdict.evaluator_email`, `CoverageRow.evaluator_email`), and
 * because local-only mode has no `app_user` row to point at. `WorkshopPerson`
 * supplies the display name.
 */
export interface ReportAssignment {
  /** `${workshop_id}::${participant_id}::${evaluator_email}::${kind}`. */
  pk: string
  workshop_id: string
  participant_id: string
  /** Lowercased. */
  evaluator_email: string
  kind: AssignmentKind
  source: AssignmentSource
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
  /**
   * Which workshop's record this observation belongs to. Resolved at ingest from
   * the originating evaluation, falling back to the participant, then to the
   * active workshop (tl-04). Required by the backend, whose read policy is
   * "member of this observation's workshop"; null only for rows imported before
   * tl-04 whose capture is no longer on this device, which cannot be pushed and
   * say so through `sync_error`.
   */
  workshop_id: string | null
  participant_id: string | null
  participant_name: string
  ksa_code: string
  text: string
  source_excerpt: string
  /**
   * A point on the workshop's scale (tl-09), no longer a `0 | 1 | 2 | 3` union.
   * Its MEANING lives in `scale_point`, so nothing may decide whether this number
   * is good or bad by comparing it to a literal — ask `isLowTrigger`.
   */
  evidence_designation: number
  /**
   * What this observation was ORIGINALLY scored at, when a scale change removed
   * that point and an administrator mapped it onto a surviving one (tl-09).
   *
   * Null for everything ever recorded on a point that still exists. When it is
   * set, every surface printing the score must print the mark with it: a remapped
   * number is an administrator's translation, not an evaluator's judgement, and a
   * report that hides the difference is claiming somebody said something they did
   * not. Set only once, so a value moved twice still records where it started.
   */
  remapped_from?: number | null
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
  /** Backend sync state, same contract as EvaluationRecord's (tl-04). */
  sync_status?: SyncStatus
  sync_error?: string | null
}

export type MentoringStatus = 'needed' | 'scheduled' | 'completed' | 'dismissed'

/**
 * A mentoring conversation triggered by a confirmed low observation: one whose
 * effective designation sits on a point the workshop marked `is_low_trigger`
 * (tl-09; it was the literal 0-or-1 until then, in the client AND in a check
 * constraint on this table). When a participant scores a confirmed low on a KSA,
 * the mentor holds a short
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
  /** The low-trigger point it fired on. Whatever the workshop's scale calls low. */
  trigger_designation: number | null
  trigger_activity_id: string | null
  status: MentoringStatus
  scheduled_for: string | null // ISO date
  summary: string | null // "we talked about X, Y, Z"
  participant_response: string | null // how they handled it
  recorded_by: string | null // evaluator email
  /**
   * tl-05. Who owns this conversation, lowercased; null while it is still in the
   * pool. Deliberately NOT a `status` value: the lifecycle says what has happened
   * with the participant, and this says who is doing it, so a conversation can be
   * assigned and scheduled at once.
   */
  assigned_to: string | null
  assigned_by: string | null
  assigned_at: string | null
  /**
   * How the admin wants this conversation opened. Admin-written and frozen to
   * everybody else by a database trigger, because an assignee editing the
   * guidance they were given is the one edit that would look like agreement.
   * Survives reassignment: the guidance is about the conversation, not the person.
   */
  admin_guidance: string | null
  admin_guidance_updated_at: string | null
  /**
   * tl-06. The assignee's answer to "is this finished?", raised when it is not.
   *
   * Owned by the evaluator, not the admin: dismissal is deliberately not an
   * evaluator's power (an assigned conversation is dropped by the person who
   * assigned it), so this flag and the note beside it are how an evaluator says
   * a conversation needs more — including that it should be dropped.
   *
   * Optional on the type only because rows written before this spec have no such
   * property in IndexedDB. Read it as `=== true`; the backend column is
   * `not null default false`.
   */
  follow_up_needed?: boolean
  follow_up_note?: string | null
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
  | 'goal'
  | 'ksa'
  | 'activity_ksa'
  | 'workshop_setting'
  | 'report_assignment'
  | 'scale_point'

export interface ReferenceOutboxEntry {
  /** `${table}:${rowKey}` — repeated edits to the same row collapse to one entry. */
  id: string
  table: ReferenceTable
  /**
   * `replace` is tl-09's, and it is the third op because a scale is one thing
   * rather than six rows. Its invariant ("two to six points, at least one of them
   * not a trigger") is a property of the SET, and this queue pushes one row per
   * HTTP request, i.e. one row per transaction — so a per-row upsert can only
   * ever check the invariant against a state that is not the final one. A
   * `replace` entry carries the whole scale and is applied by one RPC in one
   * transaction, which keeps the write offline-first AND atomic.
   */
  op: 'upsert' | 'delete' | 'replace'
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
  /**
   * How many times the backend has answered this entry with an error. Only
   * incremented when a request actually reached the server and came back
   * failing, never while offline.
   *
   * Exists because "authorization refusal" is not the only permanent error. A
   * `23503` foreign-key violation is correctly classified as retryable (the
   * parent may still be ahead of it in the queue) and yet can be permanently
   * unsatisfiable: assign a reviewer to a participant while offline, have
   * somebody else delete that participant, and the upsert can never succeed.
   *
   * That mattered little when only the Scenario Builder used this queue. Wave 2
   * routes every assignment click and every settings change through it, and one
   * stuck entry makes `pendingCount() > 0` forever, which makes
   * `loadReferenceData()` skip its pull forever: no workshops, roster,
   * activities, settings or assignments ever refresh on that device again, with
   * nothing but a console warning to say so. Giving up after
   * `MAX_PUSH_ATTEMPTS` trades one lost local edit for a device that keeps
   * working, and the entry is kept so the edit is still recoverable.
   */
  attempts?: number
}

/** One evaluator's verdict on one observation (the multi-evaluator gate). */
export type VerificationDecision = 'confirm' | 'adjust' | 'reject'

export interface VerificationVerdict {
  id: string // `${observation_id}::${evaluator_email}` — one current verdict per evaluator per observation
  observation_id: string
  capture_client_id: string // for grouping + future sync
  /**
   * Copied from the observation at record time (tl-04). Denormalized on purpose:
   * the pull is "every verdict in this workshop", and a policy that resolved the
   * workshop through the observation would hide a whole evaluator's verdicts for
   * as long as their observations were mid-push.
   */
  workshop_id: string | null
  evaluator_email: string
  decision: VerificationDecision
  /**
   * The designation this evaluator believes is correct, when decision === 'adjust'.
   * A point on the workshop's scale (tl-09); check with `isValidDesignation`
   * before recording one, because the type no longer does it for you.
   */
  adjusted_designation?: number | null
  note?: string | null
  at: string
  /** Backend sync state, same contract as EvaluationRecord's (tl-04). */
  sync_status?: SyncStatus
  sync_error?: string | null
}

/**
 * A verdict this device withdrew, kept until the withdrawal reaches the backend.
 *
 * Without it, un-verifying while offline is silently undone: the local row is
 * gone, the server's copy is not, and the next pull brings it back looking like a
 * verdict the evaluator never withdrew. A tombstone is small because a withdrawal
 * carries no payload — the id and who owns it are the whole fact.
 */
export interface VerdictTombstone {
  id: string
  workshop_id: string | null
  evaluator_email: string
  at: string
  sync_status: SyncStatus
  sync_error?: string | null
}

/**
 * One committed setup change (tl-07). Mirrors `setup_change_log`.
 *
 * Written AFTER the change it describes has committed, and best-effort: a logging
 * failure never rolls back an edit the administrator already confirmed. So a row
 * here is evidence a change happened, and its absence is not evidence that one
 * did not — which is why the log carries the severity and the counts the dialog
 * quoted rather than pretending to be a replayable transaction record.
 *
 * `actor_email` is what this device believes; the server overwrites it with the
 * caller's own address inside log_setup_change(). The two can only differ if a
 * client tried to attribute an edit to somebody else, and the server's copy wins.
 */
export interface SetupChangeLogEntry {
  id: string
  workshop_id: string
  actor_email: string | null
  entity: SetupEntity
  entity_id: string | null
  entity_label: string
  operation: SetupOperation
  severity: SetupSeverity
  workshop_state: WorkshopState
  /** Compact before/after, keyed by field. Empty for create and delete. */
  diff: Record<string, { before?: unknown; after?: unknown }>
  /** The numbers the dialog quoted, kept so the record shows what was decided on. */
  counts: Record<string, number>
  at: string
  sync_status: SyncStatus
  sync_error?: string | null
}
