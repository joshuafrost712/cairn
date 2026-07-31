/**
 * The setup change-impact classifier (tl-07).
 *
 * Pure. No IO, no Dexie, no React. Given a described change, the workshop's state,
 * and the real counts gathered for that change, it returns a severity and the
 * consequences to state before the save commits.
 *
 * Why it is a module rather than prose in each form: Joshua asked for "a warning
 * about the implications of the TYPE of change made", which means the warning has
 * to know the difference between renaming an event and deleting a question forty
 * observations depend on. Per-form prose cannot know that, and per-form prose is
 * also how a new section ships with no warning at all.
 *
 * THE RULE A FUTURE EDITOR WILL VIOLATE: a field that saves on blur may only host
 * changes this module classifies `safe`. A save-on-blur field cannot show a
 * confirmation dialog without becoming maddening, so anything that can classify
 * higher must move to an explicit Save button with useSetupSave() in front of it.
 * When you add a field to an entity below, classify it here first; the test
 * `every field of every entity is classified` will fail until you do.
 *
 * Two design decisions worth keeping:
 *
 *  1. **Counts are the whole value.** "Deleting this question will orphan 23
 *     observations across 6 participants" is a decision an admin can make; "this
 *     may affect existing data" is not. So a severity that claims existing work is
 *     affected must be JUSTIFIED by a non-zero count, and drops a tier when the
 *     count is zero. That is what stops the layer from crying wolf.
 *  2. **Consequences are ids, not sentences.** The classifier returns a chrome
 *     node id plus its tokens, and the dialog resolves them through content/chrome.json.
 *     Copy stays editable in one file (per the Web App Build Protocol) and the
 *     tests assert on ids and numbers rather than on wording, so rephrasing a
 *     warning does not break a test.
 */

/** How much a save costs, from nothing to unrecoverable. */
export type SetupSeverity = 'safe' | 'affects_future' | 'invalidates_evidence' | 'destructive'

/** Ascending severity. Index into this is the comparison. */
export const SEVERITY_RANK: SetupSeverity[] = [
  'safe',
  'affects_future',
  'invalidates_evidence',
  'destructive',
]

const rank = (s: SetupSeverity) => SEVERITY_RANK.indexOf(s)
const lower = (a: SetupSeverity, b: SetupSeverity): SetupSeverity => (rank(a) <= rank(b) ? a : b)

/**
 * Where the workshop is in its life, which is what decides whether a change can
 * cost anything at all.
 *
 * Derived from submitted evaluations rather than from dates alone: a workshop
 * where nobody has captured anything is still safely editable whatever the
 * calendar says, and a workshop whose end date passed still holds evidence people
 * are reading.
 */
export type WorkshopState = 'draft' | 'in_progress' | 'closed'

export type SetupEntity =
  | 'workshop'
  | 'event'
  | 'question'
  | 'wiring'
  | 'participant'
  | 'team'
  | 'threshold'
  | 'scale'
  /**
   * A workshop setting that changes only what happens next: the review and
   * observation quotas, which decide who is asked to carry whom from here on.
   * Assignments already made stand and no recorded designation moves, so by the
   * definition of the tiers this is `safe`.
   *
   * A setting that CAN invalidate recorded work gets its own entity rather than
   * hiding in here — `threshold` is the example, because moving the verification
   * bar re-decides whether evidence already gathered counts.
   */
  | 'setting'

export type SetupOperation = 'create' | 'update' | 'delete'

/** One field's before and after. `before` is absent on create. */
export interface SetupFieldChange {
  field: string
  before?: unknown
  after?: unknown
}

/**
 * Every number a consequence may quote, gathered from the store by setup/counts.ts
 * for this specific change. All optional; an absent count reads as zero, which is
 * what makes a caller that has not gathered a number fall to a LOWER severity
 * rather than a louder one it cannot substantiate.
 */
export interface ImpactCounts {
  /** Observations attached to the target (a question's code, an event, a participant). */
  observations?: number
  /** Distinct participants those observations belong to. */
  participants?: number
  /** Evaluator captures that touch the target. */
  captures?: number
  /** Verdicts cast on those observations — evaluator work, not just model output. */
  verdicts?: number
  /** Participant reports whose rollup changes. */
  reports?: number
  /** Observations carrying a designation, i.e. scored against the current descriptors. */
  scored?: number
  /** Events this question is wired to. */
  wiredEvents?: number
  /** Participants who would be unassigned by a team delete. */
  teamMembers?: number
  /** Observations that cross the verified line when a threshold moves. */
  crossing?: number
  /** Authored events under a workshop being deleted. */
  events?: number
  /** Authored questions under a workshop being deleted. */
  questions?: number
}

export interface SetupChange {
  entity: SetupEntity
  operation: SetupOperation
  /** The row's id, or null for a change that is not row-shaped (a setting). */
  entityId: string | null
  /** What the admin will recognize: "Q3 — CLAT facilitation", "Day 2 drafting". */
  label: string
  /** Field-level detail for an update. Ignored for create and delete. */
  fields?: SetupFieldChange[]
  counts?: ImpactCounts
}

/** A sentence to show, as a chrome node id plus the numbers to fill into it. */
export interface Consequence {
  id: string
  tokens?: Record<string, string | number>
}

export interface SetupImpact {
  severity: SetupSeverity
  /** Chrome id for the one-line summary of what kind of act this is. */
  headlineId: string
  /** What it actually does, each line built from a real count. */
  consequences: Consequence[]
  /** The admin must type the entity's name before the commit button enables. */
  requiresTypedName: boolean
  /** Nothing needs saying: the save may commit without a dialog. */
  silent: boolean
}

const n = (counts: ImpactCounts | undefined, key: keyof ImpactCounts): number =>
  Math.max(0, Math.trunc(counts?.[key] ?? 0))

/**
 * How a question's fields relate to evidence already recorded.
 *
 *  safe     — presentation or authoring aids nobody scored against
 *  future   — what evaluators are asked, from now on
 *  evidence — what a recorded designation MEANS
 *  identity — the value observations are joined on
 *
 * An unclassified field defaults to `future` rather than `safe`, because a silent
 * under-warning is the failure that matters here. The completeness test below
 * makes the omission fail loudly instead of relying on that default.
 */
const QUESTION_FIELD_CLASS: Record<string, 'safe' | 'future' | 'evidence' | 'identity'> = {
  short_label: 'safe',
  area: 'safe',
  cbc_subpoint_refs: 'safe',
  ai_facing_rubric: 'safe',
  guiding_questions: 'safe',
  id: 'safe',
  evaluator_facing_prompt: 'future',
  description: 'future',
  evidence_levels: 'evidence',
  code: 'identity',
}

/** Every field of a question, so a new one cannot be added without a class. */
export const CLASSIFIED_QUESTION_FIELDS = Object.keys(QUESTION_FIELD_CLASS)

/**
 * An event's fields are all schedule and presentation: none of them is a value an
 * observation was scored against, so editing any of them leaves recorded evidence
 * meaning exactly what it meant. Deleting the event is the change that costs.
 */
const EVENT_SAFE_FIELDS = [
  'id',
  'title',
  'day',
  'start_time',
  'end_time',
  'sort_order',
  'genre_group',
  'workshop_id',
]

/**
 * Participant fields that carry no consequence for recorded evidence.
 *
 * `team_id` is in here, which is worth defending: moving somebody between teams
 * changes how the team breakdowns READ, but no observation moves and no designation
 * changes meaning. It is also the roster's most-used control, and a dialog on every
 * team change is how a warning layer becomes something people click through without
 * reading. Renaming is safe for the same reason it always was — everything
 * downstream keys on the participant id, not the name.
 */
const PARTICIPANT_SAFE_FIELDS = [
  'id',
  'name',
  'registered_email',
  'preferred_language',
  'sex',
  'organization',
  'years_of_service',
  'workshop_id',
  'team_id',
]

/** Workshop meta that changes nothing already recorded. */
const WORKSHOP_SAFE_FIELDS = ['id', 'name', 'location', 'languages']

const changed = (change: SetupChange): SetupFieldChange[] =>
  (change.fields ?? []).filter((f) => !sameValue(f.before, f.after))

/** Shallow-plus-JSON equality, so an unchanged jsonb field is not reported as an edit. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Which fields of `after` differ from `before`, as SetupFieldChange[].
 *
 * Exported because every caller needs the same diff and a hand-rolled one per form
 * is how a field quietly stops being classified.
 */
export function diffFields<T extends object>(before: T, after: T): SetupFieldChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: SetupFieldChange[] = []
  for (const field of keys) {
    const b = (before as Record<string, unknown>)[field]
    const a = (after as Record<string, unknown>)[field]
    if (!sameValue(b, a)) out.push({ field, before: b, after: a })
  }
  return out
}

const HEADLINE: Record<SetupSeverity, string> = {
  safe: 'setup.impact.headline.safe',
  affects_future: 'setup.impact.headline.affects-future',
  invalidates_evidence: 'setup.impact.headline.invalidates-evidence',
  destructive: 'setup.impact.headline.destructive',
}

interface Verdict {
  severity: SetupSeverity
  consequences: Consequence[]
}

/**
 * Classify one setup change.
 *
 * The order of operations matters and is the specification: decide the severity
 * from the change itself, drop it a tier where the count that would justify it is
 * zero, then apply the workshop's state. State comes last because it is the
 * blanket rule ("nothing is recorded, so nothing can be harmed"), and a blanket
 * rule applied first would hide the per-field reasoning underneath it.
 */
export function classifySetupChange(change: SetupChange, state: WorkshopState): SetupImpact {
  const verdict = classify(change)
  const severity = applyState(verdict.severity, change, state)
  const consequences = [...verdict.consequences]

  // Two state-dependent lines, added rather than substituted: an admin editing a
  // closed workshop is changing a record people have already read, and that fact
  // belongs in the dialog even though it changes no count.
  if (state === 'closed' && severity !== 'safe') {
    consequences.push({ id: 'setup.impact.state.closed' })
  }
  if (state === 'draft' && severity !== 'safe') {
    consequences.push({ id: 'setup.impact.state.draft' })
  }

  return {
    severity,
    headlineId: HEADLINE[severity],
    consequences: severity === 'safe' ? [] : consequences,
    requiresTypedName: severity === 'destructive',
    silent: severity === 'safe',
  }
}

function applyState(
  severity: SetupSeverity,
  change: SetupChange,
  state: WorkshopState,
): SetupSeverity {
  if (state !== 'draft') return severity
  // Nothing has been captured, so by the definition of the tiers nothing already
  // recorded can be affected: editing a draft workshop is free, and a warning
  // layer that fires anyway is one admins learn to click through.
  //
  // Deletes are the exception, and not because of evidence: deleting an event or a
  // question destroys AUTHORING, which is somebody's afternoon even when no
  // evaluator has seen it yet. They keep a light confirmation.
  return change.operation === 'delete' ? lower(severity, 'affects_future') : 'safe'
}

function classify(change: SetupChange): Verdict {
  switch (change.entity) {
    case 'question':
      return classifyQuestion(change)
    case 'event':
      return classifyEvent(change)
    case 'wiring':
      return classifyWiring(change)
    case 'participant':
      return classifyParticipant(change)
    case 'team':
      return classifyTeam(change)
    case 'workshop':
      return classifyWorkshop(change)
    case 'threshold':
      return classifyThreshold(change)
    case 'scale':
      return classifyScale(change)
    case 'setting':
      return { severity: 'safe', consequences: [] }
  }
}

// ---------------------------------------------------------------------------
// Questions (KSAs)
// ---------------------------------------------------------------------------

function classifyQuestion(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'create') {
    // Not wired to any event yet, so no evaluator is asked it and no report reads
    // it. This is the spec's canonical `safe` case.
    return { severity: 'safe', consequences: [] }
  }

  if (change.operation === 'delete') {
    const observations = n(c, 'observations')
    if (observations === 0) {
      return {
        severity: 'affects_future',
        consequences: [
          {
            id: 'setup.impact.question.delete-clean',
            tokens: { label: change.label, events: n(c, 'wiredEvents') },
          },
        ],
      }
    }
    return {
      severity: 'destructive',
      consequences: [
        {
          id: 'setup.impact.question.delete',
          tokens: {
            label: change.label,
            observations,
            participants: n(c, 'participants'),
            reports: n(c, 'reports'),
          },
        },
        ...(n(c, 'verdicts') > 0
          ? [{ id: 'setup.impact.question.delete-verdicts', tokens: { verdicts: n(c, 'verdicts') } }]
          : []),
      ],
    }
  }

  const fields = changed(change)
  if (fields.length === 0) return { severity: 'safe', consequences: [] }

  let severity: SetupSeverity = 'safe'
  const consequences: Consequence[] = []

  for (const f of fields) {
    const klass = QUESTION_FIELD_CLASS[f.field] ?? 'future'
    if (klass === 'safe') continue

    if (klass === 'future') {
      severity = raise(severity, 'affects_future')
      consequences.push({
        id: 'setup.impact.question.prompt',
        tokens: { label: change.label, captures: n(c, 'captures') },
      })
      continue
    }

    if (klass === 'evidence') {
      // The descriptors are what a designation MEANS. Editing them after
      // observations were scored leaves every one of those scores in place while
      // changing the sentence it was measured against.
      const scored = n(c, 'scored')
      if (scored === 0) {
        severity = raise(severity, 'affects_future')
        consequences.push({
          id: 'setup.impact.question.levels-clean',
          tokens: { label: change.label },
        })
      } else {
        severity = raise(severity, 'invalidates_evidence')
        consequences.push({
          id: 'setup.impact.question.levels',
          tokens: { label: change.label, scored, participants: n(c, 'participants') },
        })
      }
      continue
    }

    // identity: observations record a question by its CODE, not by its id. Renaming
    // the code detaches every observation already recorded under the old one — the
    // heatmap and the report rollups both stop finding them.
    const observations = n(c, 'observations')
    if (observations === 0) {
      severity = raise(severity, 'affects_future')
      consequences.push({
        id: 'setup.impact.question.code-clean',
        tokens: { before: String(f.before ?? ''), after: String(f.after ?? '') },
      })
    } else {
      severity = raise(severity, 'invalidates_evidence')
      consequences.push({
        id: 'setup.impact.question.code',
        tokens: {
          before: String(f.before ?? ''),
          after: String(f.after ?? ''),
          observations,
          participants: n(c, 'participants'),
        },
      })
    }
  }

  return { severity, consequences }
}

const raise = (current: SetupSeverity, candidate: SetupSeverity): SetupSeverity =>
  rank(candidate) > rank(current) ? candidate : current

// ---------------------------------------------------------------------------
// Events (activities)
// ---------------------------------------------------------------------------

function classifyEvent(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'create') {
    return {
      severity: 'affects_future',
      consequences: [{ id: 'setup.impact.event.create', tokens: { label: change.label } }],
    }
  }
  if (change.operation === 'delete') {
    const captures = n(c, 'captures')
    const observations = n(c, 'observations')
    if (captures === 0 && observations === 0) {
      return {
        severity: 'affects_future',
        consequences: [{ id: 'setup.impact.event.delete-clean', tokens: { label: change.label } }],
      }
    }
    return {
      severity: 'destructive',
      consequences: [
        {
          id: 'setup.impact.event.delete',
          tokens: {
            label: change.label,
            captures,
            observations,
            participants: n(c, 'participants'),
          },
        },
      ],
    }
  }

  // Every editable field on an event is schedule or presentation. An unrecognized
  // one is treated as affecting what evaluators are asked, so a field added later
  // over-warns rather than passing silently.
  const unknown = changed(change).filter((f) => !EVENT_SAFE_FIELDS.includes(f.field))
  if (unknown.length === 0) return { severity: 'safe', consequences: [] }
  return {
    severity: 'affects_future',
    consequences: [
      {
        id: 'setup.impact.event.update-unknown',
        tokens: { label: change.label, fields: unknown.map((f) => f.field).join(', ') },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Wiring (which questions appear on which event)
// ---------------------------------------------------------------------------

function classifyWiring(change: SetupChange): Verdict {
  const c = change.counts
  const captures = n(c, 'captures')
  if (captures === 0) {
    return {
      severity: 'affects_future',
      consequences: [{ id: 'setup.impact.wiring.future', tokens: { label: change.label } }],
    }
  }
  return {
    severity: 'invalidates_evidence',
    consequences: [
      {
        id: 'setup.impact.wiring.evidence',
        tokens: {
          label: change.label,
          captures,
          observations: n(c, 'observations'),
          participants: n(c, 'participants'),
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Participants and teams
// ---------------------------------------------------------------------------

function classifyParticipant(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'create') {
    return {
      severity: 'affects_future',
      consequences: [{ id: 'setup.impact.participant.create', tokens: { label: change.label } }],
    }
  }
  if (change.operation === 'delete') {
    const observations = n(c, 'observations')
    if (observations === 0) {
      return {
        severity: 'affects_future',
        consequences: [
          { id: 'setup.impact.participant.delete-clean', tokens: { label: change.label } },
        ],
      }
    }
    return {
      severity: 'destructive',
      consequences: [
        {
          id: 'setup.impact.participant.delete',
          tokens: { label: change.label, observations, verdicts: n(c, 'verdicts') },
        },
      ],
    }
  }

  const unknown = changed(change).filter((f) => !PARTICIPANT_SAFE_FIELDS.includes(f.field))
  if (unknown.length === 0) return { severity: 'safe', consequences: [] }
  return {
    severity: 'affects_future',
    consequences: [
      {
        id: 'setup.impact.participant.update-unknown',
        tokens: { label: change.label, fields: unknown.map((f) => f.field).join(', ') },
      },
    ],
  }
}

function classifyTeam(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'delete') {
    const members = n(c, 'teamMembers')
    return {
      severity: 'affects_future',
      consequences: [
        {
          id: members > 0 ? 'setup.impact.team.delete' : 'setup.impact.team.delete-empty',
          tokens: { label: change.label, members },
        },
      ],
    }
  }
  // Creating or renaming a team changes how the roster is grouped and nothing else.
  return { severity: 'safe', consequences: [] }
}

// ---------------------------------------------------------------------------
// The workshop itself
// ---------------------------------------------------------------------------

function classifyWorkshop(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'delete') {
    const observations = n(c, 'observations')
    const captures = n(c, 'captures')
    if (observations === 0 && captures === 0) {
      return {
        severity: 'affects_future',
        consequences: [
          {
            id: 'setup.impact.workshop.delete-clean',
            tokens: {
              label: change.label,
              events: n(c, 'events'),
              questions: n(c, 'questions'),
              participants: n(c, 'participants'),
            },
          },
        ],
      }
    }
    return {
      severity: 'destructive',
      consequences: [
        {
          id: 'setup.impact.workshop.delete',
          tokens: {
            label: change.label,
            captures,
            observations,
            participants: n(c, 'participants'),
            verdicts: n(c, 'verdicts'),
          },
        },
      ],
    }
  }
  if (change.operation === 'create') return { severity: 'safe', consequences: [] }

  const fields = changed(change)
  const dates = fields.filter((f) => f.field === 'start_date' || f.field === 'end_date')
  const unknown = fields.filter(
    (f) => !WORKSHOP_SAFE_FIELDS.includes(f.field) && f.field !== 'start_date' && f.field !== 'end_date',
  )
  if (dates.length === 0 && unknown.length === 0) return { severity: 'safe', consequences: [] }

  const consequences: Consequence[] = []
  if (dates.length > 0) {
    // The end date is what decides `closed`, so moving it moves whether every
    // future save gets the closed-workshop warning. Worth saying out loud.
    consequences.push({
      id: 'setup.impact.workshop.dates',
      tokens: { label: change.label, fields: dates.map((f) => f.field).join(', ') },
    })
  }
  if (unknown.length > 0) {
    consequences.push({
      id: 'setup.impact.workshop.update-unknown',
      tokens: { label: change.label, fields: unknown.map((f) => f.field).join(', ') },
    })
  }
  return { severity: 'affects_future', consequences }
}

// ---------------------------------------------------------------------------
// The verification threshold, and (tl-09) the grading scale
// ---------------------------------------------------------------------------

/**
 * How many observations move across the verified line when the threshold moves.
 *
 * Pure and separate because it is the number the dialog quotes, and quoting a
 * number means being able to test how it was reached. An observation with exactly
 * `before` confirmations is verified today; with `after` it is not (or the reverse
 * on a lowering), and the ones in between are the whole cost of the change.
 */
export function observationsCrossingThreshold(
  confirmCounts: number[],
  before: number,
  after: number,
): number {
  const lo = Math.min(before, after)
  const hi = Math.max(before, after)
  if (lo === hi) return 0
  return confirmCounts.filter((count) => count >= lo && count < hi).length
}

function classifyThreshold(change: SetupChange): Verdict {
  const c = change.counts
  const field = changed(change).find((f) => f.field === 'required_confirmations')
  if (!field) return { severity: 'safe', consequences: [] }
  const before = Number(field.before ?? 0)
  const after = Number(field.after ?? 0)
  const crossing = n(c, 'crossing')
  const raising = after > before

  if (crossing === 0) {
    return {
      severity: 'affects_future',
      consequences: [
        { id: 'setup.impact.threshold.no-effect', tokens: { before, after } },
      ],
    }
  }
  return {
    severity: 'invalidates_evidence',
    consequences: [
      {
        id: raising ? 'setup.impact.threshold.raise' : 'setup.impact.threshold.lower',
        tokens: { before, after, crossing, participants: n(c, 'participants') },
      },
    ],
  }
}

/**
 * The grading scale (tl-09 owns the editor; this is the rule it plugs into).
 *
 * A designation is a number whose meaning comes entirely from the scale it was
 * recorded on, so changing the scale under recorded evidence is the sharpest case
 * in the whole layer: nothing is deleted and nothing looks wrong, while every
 * stored number now means something else.
 */
function classifyScale(change: SetupChange): Verdict {
  const c = change.counts
  const scored = n(c, 'scored')
  if (scored === 0) {
    return {
      severity: 'affects_future',
      consequences: [{ id: 'setup.impact.scale.clean' }],
    }
  }
  return {
    severity: 'invalidates_evidence',
    consequences: [
      {
        id: 'setup.impact.scale.rescore',
        tokens: { scored, participants: n(c, 'participants'), reports: n(c, 'reports') },
      },
    ],
  }
}
