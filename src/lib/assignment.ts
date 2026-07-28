// Who owes what: the assignment rules, as pure functions over plain data.
//
// No React, no Dexie, no clock, no randomness. Auto-assignment in particular has
// to be DETERMINISTIC: running it twice on unchanged data must propose exactly
// the same thing, or an administrator cannot tell "the button did nothing"
// (correct, everyone is covered) from "the button did something different this
// time" (alarming, and impossible to review).

import type { AssignmentKind, ReportAssignment, WorkshopSettings } from './types'

export interface EvaluatorRef {
  /** Lowercased. The join key for everything evaluator-shaped in this app. */
  email: string
  name: string
}

export interface ParticipantRef {
  id: string
  name: string
}

/**
 * How many participants each evaluator should carry when nobody has set a
 * number, expressed as the even split of the total work.
 *
 * Total work is `participants × required`, not `participants`: with a threshold
 * of two, twenty-six people is fifty-two assignments to hand out, and a "quota"
 * that ignored that would be half the real load and would stop auto-assignment
 * before anyone was covered twice.
 *
 * Null when there is nobody to divide among, which the UI reads as "no quota"
 * rather than as zero.
 */
export function fairShare(
  participantCount: number,
  evaluatorCount: number,
  required: number,
): number | null {
  if (evaluatorCount <= 0) return null
  return Math.ceil((participantCount * Math.max(1, required)) / evaluatorCount)
}

/**
 * This evaluator's ceiling: their personal override, else the workshop default,
 * else the fair share.
 *
 * Joshua's ask was that "some evaluators may be fine with reviewing more than
 * others", so the override is checked first and is the only value a human typed
 * in about this specific person.
 */
export function quotaFor(
  email: string,
  kind: AssignmentKind,
  settings: WorkshopSettings,
  fallback: number | null,
): number | null {
  const key = email.trim().toLowerCase()
  const overrides =
    kind === 'review' ? settings.reviewQuotaOverrides : settings.observationQuotaOverrides
  const explicit = overrides[key]
  if (typeof explicit === 'number') return explicit
  const workshopDefault =
    kind === 'review' ? settings.reviewQuotaDefault : settings.observationQuotaDefault
  return workshopDefault ?? fallback
}

export type Coverage = 'unassigned' | 'under' | 'met' | 'over'

/**
 * How well covered a participant is.
 *
 * `unassigned` is split out from `under` because they need different actions:
 * nobody has been given this person at all, versus somebody has and they still
 * need a second pair of eyes. Both render in the attention colour.
 */
export function coverageOf(assigneeCount: number, required: number): Coverage {
  if (assigneeCount === 0) return 'unassigned'
  if (assigneeCount < required) return 'under'
  if (assigneeCount > required) return 'over'
  return 'met'
}

/** Assignments of one kind, indexed participant → the emails assigned to them. */
export function assigneesByParticipant(
  assignments: ReportAssignment[],
  kind: AssignmentKind,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of assignments) {
    if (a.kind !== kind) continue
    const list = out.get(a.participant_id) ?? []
    list.push(a.evaluator_email)
    out.set(a.participant_id, list)
  }
  for (const list of out.values()) list.sort()
  return out
}

/** Assignments of one kind, counted per evaluator. */
export function loadByEvaluator(
  assignments: ReportAssignment[],
  kind: AssignmentKind,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of assignments) {
    if (a.kind !== kind) continue
    out.set(a.evaluator_email, (out.get(a.evaluator_email) ?? 0) + 1)
  }
  return out
}

export interface AssignmentProposal {
  participant_id: string
  participant_name: string
  evaluator_email: string
  /** Observations this evaluator already logged on this participant. The reason. */
  observedCount: number
}

export interface AutoAssignInput {
  participants: ParticipantRef[]
  evaluators: EvaluatorRef[]
  /** evaluator email → participant id → how many observations they logged. */
  affinity: Map<string, Map<string, number>>
  /** Every existing assignment, of every kind. Filtered internally. */
  existing: ReportAssignment[]
  kind: AssignmentKind
  required: number
  /** Ceiling per evaluator; null means uncapped. */
  quotaOf: (email: string) => number | null
}

/**
 * Propose the assignments that would bring every participant up to `required`
 * assignees.
 *
 * A PROPOSAL, deliberately. It returns rows and writes nothing, so the caller
 * can show an administrator exactly what is about to happen before it does. An
 * auto-assigner that silently rewrote the rota would be the single most annoying
 * thing in this app.
 *
 * It is also purely ADDITIVE: an existing assignment is never proposed for
 * removal, however it got there. Somebody manually gave Viji that participant
 * for a reason this function cannot see.
 *
 * The ranking is Joshua's rule, "evaluators automatically receive people based
 * on who they evaluated the most", with two tie-breaks that exist to keep the
 * result stable: current load ascending, then email. Without them, two evaluators
 * with equal history would swap places between runs.
 *
 * When quotas make full coverage impossible it stops rather than overfilling
 * somebody. The participants left short show up under-assigned on the board,
 * which is the honest outcome: the workshop is short of reviewers and the
 * administrator needs to know, not have it hidden by quietly ignoring the limit
 * they set.
 */
export function autoAssign(input: AutoAssignInput): AssignmentProposal[] {
  const { participants, evaluators, affinity, existing, kind, required, quotaOf } = input

  const assignees = new Map<string, Set<string>>()
  for (const [pid, emails] of assigneesByParticipant(existing, kind)) {
    assignees.set(pid, new Set(emails))
  }
  const load = loadByEvaluator(existing, kind)
  const quota = new Map(evaluators.map((e) => [e.email, quotaOf(e.email)]))

  const observed = (email: string, pid: string) => affinity.get(email)?.get(pid) ?? 0
  const hasRoom = (email: string) => {
    const cap = quota.get(email)
    return cap === null || cap === undefined || (load.get(email) ?? 0) < cap
  }

  // Neediest first, so scarce capacity goes to the people with nobody rather
  // than to topping someone up from one assignee to two.
  const queue = [...participants].sort((a, b) => {
    const ca = assignees.get(a.id)?.size ?? 0
    const cb = assignees.get(b.id)?.size ?? 0
    return ca - cb || a.name.localeCompare(b.name)
  })

  const proposals: AssignmentProposal[] = []
  for (const p of queue) {
    const have = assignees.get(p.id) ?? new Set<string>()
    assignees.set(p.id, have)

    while (have.size < required) {
      const candidates = evaluators.filter((e) => !have.has(e.email) && hasRoom(e.email))
      if (candidates.length === 0) break

      candidates.sort((a, b) => {
        const oa = observed(a.email, p.id)
        const ob = observed(b.email, p.id)
        if (oa !== ob) return ob - oa
        const la = load.get(a.email) ?? 0
        const lb = load.get(b.email) ?? 0
        if (la !== lb) return la - lb
        return a.email.localeCompare(b.email)
      })

      const pick = candidates[0]
      have.add(pick.email)
      load.set(pick.email, (load.get(pick.email) ?? 0) + 1)
      proposals.push({
        participant_id: p.id,
        participant_name: p.name,
        evaluator_email: pick.email,
        observedCount: observed(pick.email, p.id),
      })
    }
  }

  return proposals
}

export interface BoardCard {
  participant_id: string
  participant_name: string
  /** Every email assigned to this participant for this kind, not just this column's. */
  assignees: string[]
  coverage: Coverage
  /**
   * Review boards only: verdicts this column's evaluator has cast on this
   * participant's observations, out of how many there are. Undefined on the
   * observation board, where the equivalent measure is capture coverage and is
   * already shown on the capture screen.
   */
  progress?: { done: number; total: number }
}

export interface BoardColumn {
  /** Null on the leading column, which holds participants nobody has yet. */
  evaluator: EvaluatorRef | null
  cards: BoardCard[]
  quota: number | null
  load: number
  /** True when this evaluator is carrying at or beyond their ceiling. */
  atCapacity: boolean
  /**
   * This column's email holds assignments but is not in the workshop directory.
   *
   * Expected, not exceptional. An assignment names an email rather than an
   * account precisely so a rota can be planned before the cohort signs up, and
   * somebody can also be removed from the workshop or re-roled to `participant`
   * after they were assigned. Such a column must still be RENDERED: the whole
   * point of the board is that nobody carrying work is invisible.
   */
  offRoster: boolean
}

export interface BoardInput {
  participants: ParticipantRef[]
  evaluators: EvaluatorRef[]
  assignments: ReportAssignment[]
  kind: AssignmentKind
  required: number
  quotaOf: (email: string) => number | null
  /** participant id → the ids of their observations. Review boards only. */
  observationsByParticipant?: Map<string, string[]>
  /** evaluator email → the observation ids they have already ruled on. */
  verdictsByEvaluator?: Map<string, Set<string>>
}

/**
 * The kanban: one column per evaluator, preceded by the unassigned pile.
 *
 * A participant with two assignees appears as a card in both their columns, and
 * both cards carry the SAME coverage value, because coverage is a fact about the
 * participant rather than about the column they are being read in. Recomputing
 * it per column is the obvious mistake and it would show a person as
 * under-assigned in one place and covered in another.
 *
 * ## Columns come from the UNION, and that is load-bearing
 *
 * Not from `evaluators` alone. An assignment names an email, not an account, so
 * it can name somebody who has not signed up yet (the migration advertises
 * exactly this: plan the rota before the cohort arrives), or somebody since
 * removed from the workshop or re-roled to `participant`.
 *
 * Deriving columns only from the directory used to make those participants
 * vanish: they were not in the unassigned pile, which takes only people with
 * ZERO assignees, and they had no column to sit in. A participant with one
 * off-roster assignee out of a required two therefore rendered nowhere and was
 * missing from `underCovered()`, so the board reported "everybody has enough
 * assignees" over a cohort that did not. That is the precise opposite of what
 * this page is for.
 */
export function buildBoard(input: BoardInput): BoardColumn[] {
  const {
    participants,
    evaluators,
    assignments,
    kind,
    required,
    quotaOf,
    observationsByParticipant,
    verdictsByEvaluator,
  } = input

  const byParticipant = assigneesByParticipant(assignments, kind)
  const load = loadByEvaluator(assignments, kind)
  const participantById = new Map(participants.map((p) => [p.id, p]))

  const card = (pid: string, forEvaluator: string | null): BoardCard | null => {
    const p = participantById.get(pid)
    // An assignment whose participant is gone from the roster: dropped rather
    // than rendered as a nameless card. The row itself is cascade-deleted in
    // Postgres, so this only shows up between a delete and the next pull.
    if (!p) return null
    const assignees = byParticipant.get(pid) ?? []
    const base: BoardCard = {
      participant_id: pid,
      participant_name: p.name,
      assignees,
      coverage: coverageOf(assignees.length, required),
    }
    if (kind === 'review' && forEvaluator && observationsByParticipant && verdictsByEvaluator) {
      const obs = observationsByParticipant.get(pid) ?? []
      const ruled = verdictsByEvaluator.get(forEvaluator) ?? new Set<string>()
      base.progress = { done: obs.filter((id) => ruled.has(id)).length, total: obs.length }
    }
    return base
  }

  const unassigned = participants
    .filter((p) => (byParticipant.get(p.id)?.length ?? 0) === 0)
    .map((p) => card(p.id, null))
    .filter((c): c is BoardCard => c !== null)

  const columns: BoardColumn[] = [
    {
      evaluator: null,
      cards: unassigned,
      quota: null,
      load: unassigned.length,
      atCapacity: false,
      offRoster: false,
    },
  ]

  const inDirectory = new Set(evaluators.map((e) => e.email))
  const offRoster = [...new Set(assignments.filter((a) => a.kind === kind).map((a) => a.evaluator_email))]
    .filter((email) => !inDirectory.has(email))
    // Named by their email, which is all that is known about them. Sorted in
    // after the directory so the people actually in the workshop come first.
    .sort()
    .map((email) => ({ ref: { email, name: email }, off: true }))

  const ordered = [
    ...[...evaluators].sort((a, b) => a.name.localeCompare(b.name)).map((ref) => ({ ref, off: false })),
    ...offRoster,
  ]

  for (const { ref, off } of ordered) {
    const mine = assignments
      .filter((a) => a.kind === kind && a.evaluator_email === ref.email)
      .map((a) => card(a.participant_id, ref.email))
      .filter((c): c is BoardCard => c !== null)
      .sort((a, b) => a.participant_name.localeCompare(b.participant_name))
    // An off-roster column has no quota: there is no directory entry to hang an
    // override on, and capping somebody the workshop does not know about would
    // be a limit nobody set.
    const cap = off ? null : quotaOf(ref.email)
    const n = load.get(ref.email) ?? 0
    columns.push({
      evaluator: ref,
      cards: mine,
      quota: cap,
      load: n,
      atCapacity: cap !== null && n >= cap,
      offRoster: off,
    })
  }

  return columns
}

/** Participants short of the requirement. The number the board leads with. */
export function underCovered(columns: BoardColumn[]): number {
  const seen = new Map<string, Coverage>()
  for (const col of columns) {
    for (const c of col.cards) seen.set(c.participant_id, c.coverage)
  }
  return [...seen.values()].filter((c) => c === 'unassigned' || c === 'under').length
}
