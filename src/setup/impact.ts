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
  /**
   * A goal: the level above a question (tl-08). Grouping only, so creating or
   * renaming one changes how reports READ and nothing about what any observation
   * means. Deleting one is a reorganization rather than a destruction, because its
   * questions are set ungrouped rather than deleted — which is exactly the
   * distinction the dialog has to draw, since "delete goal" sounds like the worse
   * of the two.
   */
  | 'goal'
  | 'question'
  | 'wiring'
  | 'participant'
  | 'team'
  | 'threshold'
  | 'scale'
  /**
   * A whole roster import, or the undo of one (tl-10). One entity for many rows,
   * because the administrator is deciding about the FILE: twenty-eight separate
   * participant dialogs is not a warning layer, it is a reason to stop using the
   * importer. The counts carry the per-row detail the dialog quotes.
   */
  | 'roster_import'
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
  /**
   * Somebody's role in this workshop (tl-11). `update` re-ranks them, `delete`
   * removes them.
   *
   * The first entity here whose cost is not evidence-shaped. Every other entity is
   * classified by what a change does to recorded observations; a promotion touches
   * no observation and is still a change worth stopping to read, because it hands
   * somebody authority over everyone else's. See `applyState` for the consequence
   * that has for the draft-workshop discount.
   */
  | 'membership'
  /**
   * An invitation (tl-11): issuing one or withdrawing one. `safe` in both
   * directions and deliberately so — nobody has been granted anything until they
   * create an account, and a warning layer that fires on an act with no
   * consequence is how it loses the credibility it needs for the acts that have
   * one. It is still routed through the save hook, because silent means "no
   * dialog", not "no log".
   */
  | 'invitation'
  /**
   * Somebody's background card (tl-12): certifications, education, work areas,
   * trainings elsewhere.
   *
   * `safe` in both directions, and the reasoning is the one that decides every
   * tier here: a profile is BACKGROUND, and no observation, designation, report or
   * assignment reads it. Deleting one removes a card and leaves the person, their
   * participant rows and their evidence exactly as they were.
   *
   * That is also why a delete still routes through the hook. The severity is
   * `safe`, so no dialog fires from the classifier — but the section raises its own
   * confirm, because the thing an admin clicking Delete is most likely to be wrong
   * about is what it deletes, and "wrong about the scope" is not a severity the
   * tiers can express.
   */
  | 'profile'
  /**
   * Combining two person records into one (tl-12).
   *
   * The one entity in this spec that is `destructive`, and the only one whose
   * cost is not the evidence itself but the READING of it. A merge moves no
   * observation: participant rows are repointed, nothing is deleted. What it does
   * is join two evaluation histories into one person's track record, which is the
   * fact every future evaluator will read that person's performance against. Merge
   * two humans by mistake and every subsequent judgment about either is made
   * against a history that is partly somebody else's, with nothing on screen
   * looking wrong.
   *
   * `requiresTypedName` follows from `destructive` and is wanted here: unpicking a
   * merge is worse than never having made one, so it earns the same friction as
   * deleting a workshop.
   */
  | 'person_merge'
  /**
   * The workshop's AI provider mode and function toggles (tl-13).
   *
   * `affects_future` for everything except one case, and that case is the reason
   * this is its own entity rather than another `setting`. Turning observation
   * routing off does not touch a single stored row, and it stops captures becoming
   * observations — so evidence gathered from that moment on never becomes evidence
   * at all. Nothing on any screen looks wrong; evaluators go on capturing into a
   * pipeline whose far end is closed. That is `invalidates_evidence` in effect even
   * though its mechanism is the opposite of every other member of that tier, and
   * the dialog has to say so in the plainest words in this file.
   */
  | 'ai_config'

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
  /** Authored questions under a workshop being deleted, or under a goal (tl-08). */
  questions?: number
  /**
   * Report groupings that change when a question moves between goals, or a goal is
   * renamed (tl-08).
   *
   * Distinct from `reports`, which counts reports whose NUMBERS change. Nothing is
   * rescored by a regrouping; the same designations are printed under a different
   * heading, which is a smaller thing than an invalidation and a bigger thing than
   * nothing. Keeping them apart is what stops the dialog claiming a rename
   * invalidates evidence.
   */
  regrouped?: number
  /**
   * The four numbers that describe a scale edit (tl-09).
   *
   * A scale change cannot be classified from field names: adding a point,
   * renaming one and deleting one all appear as a change to the same thing, and
   * they are three different acts with three different costs. So the arithmetic
   * is done by `diffScales` in lib/scale.ts and arrives here as counts.
   */
  addedPoints?: number
  removedPoints?: number
  rewordedPoints?: number
  retriggeredPoints?: number
  /**
   * Observations sitting on a point that is about to be removed. The number that
   * separates `invalidates_evidence` from `destructive`, and the one the remap
   * step exists for.
   */
  strandedObservations?: number
  /** Follow-up conversations that would newly derive if the trigger set changes. */
  conversationsAppearing?: number
  /** Existing conversations whose trigger point would stop being a trigger. */
  conversationsStale?: number
  /**
   * Follow-up conversations currently assigned to the person being removed (tl-11,
   * over tl-05's assignments).
   *
   * Their own count rather than a fold into `captures`, because it is the one
   * consequence of a removal that leaves WORK UNDONE rather than work merely
   * re-attributed: an assigned conversation whose assignee is gone is a
   * participant nobody is following up.
   */
  assignedConversations?: number
  /**
   * Administrators who would still be able to run the workshop afterwards, not
   * counting its chief admin.
   *
   * Zero is the number worth a sentence of its own: the chief admin becomes the
   * only person who can change anything, which is recoverable but is not what an
   * admin removing a colleague usually intends.
   */
  remainingAdmins?: number
  /** Participants a roster import would add (tl-10). */
  created?: number
  /** Existing participants a roster import would change. */
  updated?: number
  /**
   * Of those, how many have an email or a team change.
   *
   * Kept apart from `updated` because they are the only updates that can be wrong
   * in a way anybody notices: a corrected spelling changes a label, while a changed
   * address changes where a report is sent and a changed team changes which
   * breakdown a person is counted in. An import that only fixes spellings should not
   * claim to invalidate anything.
   */
  contactChanges?: number
  /** People an undo could not remove because they have since been observed. */
  refused?: number
  /** Teams a roster import would bring into existence. */
  teams?: number
  /** Rows that matched somebody and would change nothing. The idempotence number. */
  unchanged?: number
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
const QUESTION_FIELD_CLASS: Record<
  string,
  'safe' | 'future' | 'evidence' | 'identity' | 'grouping'
> = {
  short_label: 'safe',
  cbc_subpoint_refs: 'safe',
  ai_facing_rubric: 'safe',
  guiding_questions: 'safe',
  id: 'safe',
  /**
   * LEGACY (tl-08). `goal_id` replaced it and app code no longer reads or writes
   * it, so a diff can only carry it when a pre-tl-08 row is round-tripped. Kept
   * classified rather than removed so that round trip stays silent instead of
   * falling to the unclassified `future` default and warning about a field nobody
   * touched.
   */
  area: 'safe',
  /**
   * Which workshop owns the question (tl-08). Not editable from any form: it is
   * set once at creation from the active workshop. Classified so the completeness
   * test passes and so a future "move question to another workshop" feature has to
   * come here and think about it — that WOULD be an identity change, because the
   * question's code is only unique within a workshop.
   */
  workshop_id: 'safe',
  evaluator_facing_prompt: 'future',
  description: 'future',
  evidence_levels: 'evidence',
  code: 'identity',
  goal_id: 'grouping',
}

/** Every field of a question, so a new one cannot be added without a class. */
export const CLASSIFIED_QUESTION_FIELDS = Object.keys(QUESTION_FIELD_CLASS)

/**
 * How a wiring row's fields relate to recorded evidence (tl-08).
 *
 *  membership — WHICH questions this event asks; changing it changes which answers
 *               the event's report rollup reads
 *  future     — the per-event WORDING; changes what evaluators are asked from here on
 *  safe       — identity and ordering
 *
 * The split exists because before tl-08 a wiring row held nothing but membership,
 * so classifying the whole row as one thing was accurate. Now the same Save can
 * carry either, and treating a reworded prompt as a rewire would report
 * `invalidates_evidence` for an edit that invalidates nothing.
 */
const WIRING_FIELD_CLASS: Record<string, 'safe' | 'future' | 'membership'> = {
  activity_id: 'safe',
  ksa_id: 'safe',
  sort_order: 'safe',
  questions: 'membership',
  prompt_override: 'future',
  guiding_questions_override: 'future',
}

/** Every field of a wiring row, so a new one cannot be added without a class. */
export const CLASSIFIED_WIRING_FIELDS = Object.keys(WIRING_FIELD_CLASS)

/**
 * A goal's fields. All grouping or presentation: a goal carries no score, so
 * nothing recorded can be scored against it and no designation can change meaning
 * when it changes.
 */
const GOAL_FIELD_CLASS: Record<string, 'safe' | 'grouping'> = {
  id: 'safe',
  workshop_id: 'safe',
  description: 'safe',
  sort_order: 'safe',
  // The heading the reports print. Renaming it reprints them.
  title: 'grouping',
  code: 'grouping',
}

/** Every field of a goal, so a new one cannot be added without a class. */
export const CLASSIFIED_GOAL_FIELDS = Object.keys(GOAL_FIELD_CLASS)

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
  // The draft discount is an argument about EVIDENCE: nothing has been captured,
  // so nothing already recorded can be harmed. Membership is the first entity that
  // argument does not reach. Making somebody an admin of a workshop that has not
  // started yet is exactly as consequential as making them one mid-workshop —
  // more so, since they will be an admin for the whole of it — and the cost is
  // authority rather than data. So these keep the severity they earned; the check
  // itself is below, folded together with tl-12's `person_merge`, which is exempt
  // on the same reasoning.
  /**
   * A ROSTER IMPORT IS EXEMPT FROM THE DRAFT BLANKET (tl-10), and the exemption is
   * argued rather than assumed, because this rule is tl-07's and worth respecting.
   *
   * The blanket exists for save-on-blur field edits: nothing is recorded, so
   * renaming an event costs nothing and a dialog would be noise. An import is not
   * that. It is a bulk write of twenty-eight rows from a file somebody was sent, it
   * can create people and teams in one act, and `safe` here would have a second
   * consequence beyond the missing dialog: setup/log.ts does not log `safe`
   * changes, so the record of WHICH FILE built the roster would not exist for
   * exactly the workshops that are built by importing one.
   */
  if (change.entity === 'roster_import') return lower(severity, 'affects_future')
  /**
   * THE AI CONFIGURATION IS EXEMPT TOO (tl-13), on the second half of the roster
   * import's argument rather than the first.
   *
   * A draft workshop has captured nothing, so switching a provider genuinely costs
   * no evidence, and if the dialog were the only consideration `safe` would be
   * right. The log is the other consideration: setup/log.ts does not record `safe`
   * changes, and "who pointed this workshop at which provider, and when" is
   * precisely the question an organization asks when it wants to know where its
   * evidence went. Most of that configuring happens before a workshop starts, which
   * is exactly the window the blanket would erase.
   */
  if (change.entity === 'ai_config') return lower(severity, 'affects_future')
  //
  // tl-12's `person_merge` is exempt for the same reason and it is the sharper
  // case: a merge is `update`, not `delete`, so without this line the discount
  // would not merely soften it, it would return `safe` and the dialog would not
  // appear at all. What a merge costs is not evidence — it is that two people's
  // track records become one person's, and a workshop having captured nothing yet
  // says nothing about whether the two humans are the same.
  if (
    change.entity === 'membership' ||
    change.entity === 'invitation' ||
    change.entity === 'person_merge'
  ) {
    return severity
  }
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
    case 'goal':
      return classifyGoal(change)
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
    case 'roster_import':
      return classifyRosterImport(change)
    case 'setting':
      return { severity: 'safe', consequences: [] }
    case 'membership':
      return classifyMembership(change)
    case 'invitation':
      return classifyInvitation()
    case 'profile':
      return classifyProfile()
    case 'person_merge':
      return classifyPersonMerge(change)
    case 'ai_config':
      return classifyAiConfig(change)
  }
}

// ---------------------------------------------------------------------------
// AI configuration (tl-13)
// ---------------------------------------------------------------------------

/**
 * A mode change or a function toggle.
 *
 * The interesting case is switching observation routing OFF, and it is worth
 * spelling out why it lands in a tier whose name reads backwards here. Every other
 * `invalidates_evidence` change alters what already-recorded evidence MEANS. This
 * one leaves all of it alone and closes the far end of the pipeline: evaluators keep
 * capturing, captures keep arriving, and none of them become observations, so none
 * of them reach a report. The cost is entirely in the future and it is total, which
 * is exactly the sort of thing a warning layer exists to say out loud.
 *
 * It drops to `affects_future` in a workshop with no captures, on the same
 * count-justifies-the-tier rule the rest of this module follows: with nothing in
 * flight there is nothing to strand.
 */
function classifyAiConfig(change: SetupChange): Verdict {
  const c = change.counts
  const fields = changed(change)
  if (fields.length === 0) return { severity: 'safe', consequences: [] }

  let severity: SetupSeverity = 'safe'
  const consequences: Consequence[] = []

  for (const f of fields) {
    if (f.field === 'mode') {
      severity = raise(severity, 'affects_future')
      consequences.push({
        id: 'setup.impact.ai.mode',
        tokens: { from: words(String(f.before ?? '')), to: words(String(f.after ?? '')) },
      })
      continue
    }

    const turningOff = f.after === false
    if (f.field === 'observation_routing' && turningOff) {
      const captures = n(c, 'captures')
      if (captures === 0) {
        severity = raise(severity, 'affects_future')
        consequences.push({ id: 'setup.impact.ai.routing-off-clean' })
      } else {
        severity = raise(severity, 'invalidates_evidence')
        consequences.push({ id: 'setup.impact.ai.routing-off', tokens: { captures } })
      }
      continue
    }

    severity = raise(severity, 'affects_future')
    consequences.push({
      id: turningOff ? 'setup.impact.ai.fn-off' : 'setup.impact.ai.fn-on',
      tokens: { fn: words(f.field) },
    })
  }

  return { severity, consequences }
}

// ---------------------------------------------------------------------------
// People (tl-11)
// ---------------------------------------------------------------------------

/**
 * The roles whose holders can change the workshop rather than only work in it.
 * Promoting somebody into this set is the change worth naming in its own sentence.
 */
const ADMINISTERING_ROLES = ['chief_admin', 'admin']

const words = (role: string | null): string => (role ?? '').replace(/_/g, ' ')

const roleOf = (change: SetupChange, key: 'before' | 'after'): string | null => {
  const field = (change.fields ?? []).find((f) => f.field === 'role')
  const value = field?.[key]
  return typeof value === 'string' ? value : null
}

/**
 * A role change or a removal.
 *
 * Two things this does NOT do, both deliberate:
 *
 *  1. It never returns `destructive`. `destructive` means work is unrecoverably
 *     lost, and removing somebody loses none: every evaluation and every verdict
 *     they recorded stays in the workshop, attributed to them by email exactly as
 *     before. Reaching for the loudest tier here would be the classifier lying in
 *     the direction it is least allowed to.
 *  2. It does not treat a demotion as cheaper than a promotion. Both change who
 *     can do what from now on, and the person losing an ability is at least as
 *     entitled to have somebody read a sentence about it first.
 */
function classifyMembership(change: SetupChange): Verdict {
  const c = change.counts
  const before = roleOf(change, 'before')
  const after = roleOf(change, 'after')

  if (change.operation === 'delete') {
    const captures = n(c, 'captures')
    const assigned = n(c, 'assignedConversations')
    const consequences: Consequence[] = []

    // The spec's tier, and the wording it demands. `invalidates_evidence` is the
    // level of ATTENTION this deserves, not a claim about the evidence: the
    // consequence line says in as many words that everything they recorded stands.
    // If that reads as a contradiction, it is one the tier names carry, not one the
    // dialog shows an administrator.
    consequences.push({
      id: captures > 0 ? 'setup.impact.membership.remove' : 'setup.impact.membership.remove-clean',
      tokens: { label: change.label, captures },
    })
    if (assigned > 0) {
      consequences.push({
        id: 'setup.impact.membership.remove-assigned',
        tokens: { label: change.label, conversations: assigned },
      })
    }
    if (before === 'admin' && n(c, 'remainingAdmins') === 0) {
      consequences.push({ id: 'setup.impact.membership.remove-last-admin' })
    }
    return {
      severity: captures > 0 ? 'invalidates_evidence' : 'affects_future',
      consequences,
    }
  }

  if (change.operation === 'create') {
    return {
      severity: 'affects_future',
      consequences: [
        { id: 'setup.impact.membership.create', tokens: { label: change.label, role: after ?? '' } },
      ],
    }
  }

  const consequences: Consequence[] = [
    {
      id: 'setup.impact.membership.role',
      // Humanized here rather than in the dialog, because a consequence is a
      // sentence and `chief_evaluator` is not a word. The CLASSIFICATION above
      // still reads the raw role; only the token that gets printed is softened.
      tokens: { label: change.label, from: words(before), to: words(after) },
    },
  ]
  if (after && ADMINISTERING_ROLES.includes(after)) {
    consequences.push({ id: 'setup.impact.membership.gains-admin', tokens: { label: change.label } })
  } else if (before && ADMINISTERING_ROLES.includes(before)) {
    consequences.push({ id: 'setup.impact.membership.loses-admin', tokens: { label: change.label } })
  }
  return { severity: 'affects_future', consequences }
}

/**
 * Issuing or withdrawing an invitation.
 *
 * `safe` both ways, which is the spec's call and the right one: until the person
 * creates an account they hold nothing, and a withdrawn invitation takes nothing
 * away from anybody who had it. The act is still logged.
 *
 * The one case worth knowing about: `invite_to_workshop` writes the membership
 * immediately when the address already has an account, so an invite can be a grant.
 * That is classified here rather than as a `membership` create, because the caller
 * cannot know which it will be until the server answers — and re-classifying after
 * the fact would mean showing a warning about a change that has already committed,
 * which is worse than not showing one. What makes it acceptable is that inviting is
 * additive: the matrix has already refused anything the actor could not grant, and
 * the log records it either way.
 */
function classifyInvitation(): Verdict {
  return { severity: 'safe', consequences: [] }
}

/**
 * A profile edit or deletion (tl-12). `safe`, in every direction, deliberately.
 *
 * No observation, designation, report, assignment or conversation reads a profile.
 * Deleting one removes a background card; the person, their participant rows and
 * every piece of evidence about them are untouched. Firing a dialog on an act with
 * no consequence is how the warning layer loses the credibility it needs for the
 * acts that have one, which is the argument tl-11 made for `invitation`.
 *
 * The delete still gets a confirm, raised by the section rather than by this
 * classifier. What that confirm exists to correct is a MISREADING — "Delete
 * profile" next to somebody's name looks like it deletes the person — and a
 * misreading is not a severity.
 */
function classifyProfile(): Verdict {
  return { severity: 'safe', consequences: [] }
}

/**
 * Combining two people (tl-12). The one destructive act in this spec.
 *
 * Note what the consequences do NOT say. They do not say evidence is deleted,
 * because none is: the RPC repoints participant rows and leaves every observation
 * where it was. They say the two histories become one person's, which is the true
 * and worse thing, and they quote the real counts so an administrator can see the
 * size of what they are joining.
 */
function classifyPersonMerge(change: SetupChange): Verdict {
  const c = change.counts
  const consequences: Consequence[] = [
    { id: 'setup.impact.merge.combines', tokens: { label: change.label } },
  ]
  const observations = n(c, 'observations')
  const participants = n(c, 'participants')
  if (participants > 0) {
    consequences.push({ id: 'setup.impact.merge.participants', tokens: { participants } })
  }
  if (observations > 0) {
    consequences.push({
      id: 'setup.impact.merge.evidence-stays',
      tokens: { observations, reports: n(c, 'reports') },
    })
  }
  consequences.push({ id: 'setup.impact.merge.irreversible' })
  return { severity: 'destructive', consequences }
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

    if (klass === 'grouping') {
      // Moving a question to another goal reprints it under a different heading in
      // every report that already exists. Nothing is rescored: the same
      // observations keep the same designations, and the KSA table and heatmap
      // group them somewhere else. That is a real cost on a workshop with recorded
      // evidence and no cost at all before, so the count decides.
      const observations = n(c, 'observations')
      if (observations === 0) {
        severity = raise(severity, 'affects_future')
        consequences.push({
          id: 'setup.impact.question.regroup-clean',
          tokens: { label: change.label },
        })
      } else {
        severity = raise(severity, 'invalidates_evidence')
        consequences.push({
          id: 'setup.impact.question.regroup',
          tokens: {
            label: change.label,
            observations,
            regrouped: n(c, 'regrouped') || n(c, 'participants'),
          },
        })
      }
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
// Goals (tl-08) — the level above a question
// ---------------------------------------------------------------------------

/**
 * A goal groups questions and holds no score, so nothing here can invalidate
 * evidence: the same observations keep the same designations under a different
 * heading.
 *
 * DELETING A GOAL IS NOT DESTRUCTIVE, and this is a deliberate departure from the
 * spec, which called it `destructive` with counts. It would be right if the delete
 * cascaded to the questions. It does not: `ksa.goal_id` is `on delete set null`
 * both in Postgres and in the local mirror, so the questions survive as ungrouped
 * and every observation under them is untouched. Reserving `destructive` — the tier
 * that makes an admin type the name back — for acts that actually destroy
 * something is what keeps the whole layer credible when it does fire.
 */
function classifyGoal(change: SetupChange): Verdict {
  const c = change.counts
  if (change.operation === 'create') {
    // A goal with no questions under it asks nothing of anybody. The spec's second
    // canonical `safe` case.
    return { severity: 'safe', consequences: [] }
  }

  if (change.operation === 'delete') {
    const questions = n(c, 'questions')
    if (questions === 0) {
      return {
        severity: 'affects_future',
        consequences: [{ id: 'setup.impact.goal.delete-empty', tokens: { label: change.label } }],
      }
    }
    return {
      severity: 'affects_future',
      consequences: [
        {
          id: 'setup.impact.goal.delete',
          tokens: { label: change.label, questions, regrouped: n(c, 'regrouped') },
        },
      ],
    }
  }

  const fields = changed(change).filter((f) => (GOAL_FIELD_CLASS[f.field] ?? 'grouping') !== 'safe')
  if (fields.length === 0) return { severity: 'safe', consequences: [] }

  const regrouped = n(c, 'regrouped')
  return {
    severity: 'affects_future',
    consequences: [
      {
        id: regrouped > 0 ? 'setup.impact.goal.rename' : 'setup.impact.goal.rename-clean',
        tokens: {
          label: change.label,
          questions: n(c, 'questions'),
          regrouped,
        },
      },
    ],
  }
}

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

  // tl-08: the same Save can now carry either of two different acts. Rewording one
  // event's prompt changes what evaluators are ASKED from here on and leaves every
  // recorded answer meaning exactly what it meant; rewiring changes WHICH answers
  // the event's rollup reads. Only the second can invalidate anything, so an
  // override-only change never reaches `invalidates_evidence` however many captures
  // the event has.
  // A caller that supplied `fields` has told us what changed, so an empty diff means
  // nothing did and the save is silent. A caller that supplied NONE has told us
  // nothing, so the captures-based rule below still applies — over-warning where we
  // cannot tell is the safe direction, and it is what every pre-tl-08 caller relied
  // on.
  const declared = change.fields != null
  const fields = changed(change)
  if (declared && fields.length === 0) return { severity: 'safe', consequences: [] }

  const classes = new Set(fields.map((f) => WIRING_FIELD_CLASS[f.field] ?? 'membership'))
  if (fields.length > 0 && !classes.has('membership')) {
    if (!classes.has('future')) return { severity: 'safe', consequences: [] }
    return {
      severity: 'affects_future',
      consequences: [
        {
          id: 'setup.impact.wiring.override',
          tokens: { label: change.label, captures },
        },
      ],
    }
  }

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

// ---------------------------------------------------------------------------
// Roster import (tl-10)
// ---------------------------------------------------------------------------

/**
 * An import, and the undo of one.
 *
 * The spec's rule, and the two places it is easy to get wrong.
 *
 * An import into a workshop in progress reaches `invalidates_evidence` only when it
 * changes an EMAIL OR A TEAM on somebody who already has recorded evidence. Both
 * halves are load-bearing. Without the field test, re-importing a corrected
 * spreadsheet to fix three misspellings would announce that it invalidates
 * evidence, which is false and is how a warning layer becomes wallpaper. Without
 * the evidence test, the same change in a workshop nobody has captured in yet would
 * claim a cost that does not exist.
 *
 * An UNDO never reaches that tier, and that is a property of undo rather than an
 * exemption: it refuses to delete anybody who has been observed (see
 * db/rosterImport.ts), so the destructive case it would be warning about cannot
 * happen. What it does do is remove people and put values back, so it stays at
 * `affects_future` and names the refusals.
 */
function classifyRosterImport(change: SetupChange): Verdict {
  const c = change.counts
  const created = n(c, 'created')
  const updated = n(c, 'updated')
  const teams = n(c, 'teams')

  if (change.operation === 'delete') {
    const consequences: Consequence[] = [
      {
        id: 'setup.impact.import.undo',
        tokens: { label: change.label, created, updated, teams },
      },
    ]
    if (n(c, 'refused') > 0) {
      consequences.push({
        id: 'setup.impact.import.undo-refused',
        tokens: { refused: n(c, 'refused') },
      })
    }
    return { severity: 'affects_future', consequences }
  }

  const consequences: Consequence[] = [
    {
      id: 'setup.impact.import.summary',
      tokens: { label: change.label, created, updated, unchanged: n(c, 'unchanged') },
    },
  ]
  if (teams > 0) {
    consequences.push({ id: 'setup.impact.import.new-teams', tokens: { teams } })
  }

  const contactChanges = n(c, 'contactChanges')
  const withEvidence = n(c, 'reports')
  if (contactChanges > 0 && withEvidence > 0) {
    consequences.push({
      id: 'setup.impact.import.contact',
      tokens: { contactChanges, reports: withEvidence, observations: n(c, 'observations') },
    })
    return { severity: 'invalidates_evidence', consequences }
  }
  if (contactChanges > 0) {
    consequences.push({ id: 'setup.impact.import.contact-clean', tokens: { contactChanges } })
  }
  return { severity: 'affects_future', consequences }
}

/**
 * The grading scale (tl-09).
 *
 * A designation is a number whose meaning comes entirely from the scale it was
 * recorded on, so changing the scale under recorded evidence is the sharpest case
 * in the whole layer: nothing is deleted and nothing looks wrong, while every
 * stored number now means something else.
 *
 * tl-07 left one coarse rule here — any edit with scored evidence behind it was
 * `invalidates_evidence`. That is too loud to be believed. Renaming a point is
 * not the same act as deleting one, and a layer that shouts equally at both
 * teaches an administrator to click through it, which is precisely how the
 * dangerous one gets through. The spec specifies four cases and this is them.
 *
 * The change carries a `scale.*` diff shape rather than field names, because
 * "which points were added, removed, reworded or re-triggered" is what decides
 * the severity, and no per-field classification can express it: a rename and a
 * removal both show up as a change to the same jsonb column.
 */
function classifyScale(change: SetupChange): Verdict {
  const c = change.counts
  const scored = n(c, 'scored')
  const removed = n(c, 'removedPoints')
  const added = n(c, 'addedPoints')
  const retriggered = n(c, 'retriggeredPoints')
  const stranded = n(c, 'strandedObservations')

  // 1. REMOVING a point. Destructive when observations sit on it, because their
  //    number is about to become a value the scale cannot label; the editor
  //    refuses the save without a mapping, and the dialog is where the admin is
  //    told what the mapping will do.
  if (removed > 0) {
    if (stranded > 0) {
      return {
        severity: 'destructive',
        consequences: [
          {
            id: 'setup.impact.scale.remove-strands',
            tokens: {
              removed,
              stranded,
              participants: n(c, 'participants'),
              reports: n(c, 'reports'),
            },
          },
          { id: 'setup.impact.scale.remap-marked', tokens: { stranded } },
        ],
      }
    }
    return {
      severity: 'invalidates_evidence',
      consequences: [{ id: 'setup.impact.scale.remove-clean', tokens: { removed, scored } }],
    }
  }

  // 2. Changing WHICH points warrant a conversation. Nothing is rescored and yet
  //    the follow-up queue is about to be a different list of people, which is a
  //    real cost on a workshop mid-flight and none at all before one starts.
  if (retriggered > 0) {
    if (scored === 0) {
      return {
        severity: 'affects_future',
        consequences: [{ id: 'setup.impact.scale.trigger-clean', tokens: { retriggered } }],
      }
    }
    return {
      severity: 'invalidates_evidence',
      consequences: [
        {
          id: 'setup.impact.scale.trigger',
          tokens: {
            retriggered,
            appearing: n(c, 'conversationsAppearing'),
            stale: n(c, 'conversationsStale'),
          },
        },
        { id: 'setup.impact.scale.trigger-not-dismissed' },
      ],
    }
  }

  // 3. ADDING a point. Existing evidence keeps its number and was scored against
  //    a narrower scale, which cannot be retrofitted and must not be pretended
  //    away.
  if (added > 0) {
    if (scored === 0) {
      return {
        severity: 'affects_future',
        consequences: [{ id: 'setup.impact.scale.add-clean', tokens: { added } }],
      }
    }
    return {
      severity: 'affects_future',
      consequences: [{ id: 'setup.impact.scale.add', tokens: { added, scored } }],
    }
  }

  // 4. Wording only. The numbers stand and gain new words, which is a change to
  //    what they MEAN and so is worth saying, with the count that makes it real.
  if (scored === 0) {
    return { severity: 'affects_future', consequences: [{ id: 'setup.impact.scale.clean' }] }
  }
  return {
    severity: 'affects_future',
    consequences: [
      {
        id: 'setup.impact.scale.reword',
        tokens: { reworded: n(c, 'rewordedPoints'), scored },
      },
    ],
  }
}
