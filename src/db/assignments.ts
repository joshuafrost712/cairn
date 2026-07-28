import { db, assignmentPk } from './local'
import { enqueueReferenceWrite, pushReferenceOutbox } from './referenceWrite'
import type { AssignmentKind, AssignmentSource, ReportAssignment } from '../lib/types'
import type { AssignmentProposal } from '../lib/assignment'

/**
 * The assignment store: Dexie now, backend when it can be reached.
 *
 * Same offline-first shape as db/admin.ts and db/settings.ts, and it queues onto
 * the SAME reference outbox rather than growing a third push path. There should
 * be one place in this app that knows how to retry a write and how to tell a
 * refusal apart from a dropped connection, and that place is
 * db/referenceWrite.ts.
 *
 * The pure rules (who to assign, how full a column is, what counts as
 * under-covered) live in src/lib/assignment.ts. This module only moves rows.
 */

/** The Postgres row, without the Dexie-only `pk`. Sending it would 400. */
function payloadOf(a: ReportAssignment) {
  return {
    workshop_id: a.workshop_id,
    participant_id: a.participant_id,
    evaluator_email: a.evaluator_email,
    kind: a.kind,
    source: a.source,
    added_by: a.added_by,
    added_at: a.added_at,
  }
}

function row(
  workshopId: string,
  participantId: string,
  evaluatorEmail: string,
  kind: AssignmentKind,
  source: AssignmentSource,
  addedBy: string | null,
): ReportAssignment {
  const email = evaluatorEmail.trim().toLowerCase()
  return {
    pk: assignmentPk(workshopId, participantId, email, kind),
    workshop_id: workshopId,
    participant_id: participantId,
    evaluator_email: email,
    kind,
    source,
    added_by: addedBy,
    added_at: new Date().toISOString(),
  }
}

/** Everything assigned in one workshop, both kinds. */
export async function assignmentsFor(workshopId: string | null): Promise<ReportAssignment[]> {
  if (!workshopId) return []
  return db.assignments.where('workshop_id').equals(workshopId).toArray()
}

/** Give one participant to one evaluator. Idempotent: the key is deterministic. */
export async function assign(
  workshopId: string,
  participantId: string,
  evaluatorEmail: string,
  kind: AssignmentKind,
  opts: { source?: AssignmentSource; addedBy?: string | null } = {},
): Promise<void> {
  const a = row(
    workshopId,
    participantId,
    evaluatorEmail,
    kind,
    opts.source ?? 'manual',
    opts.addedBy ?? null,
  )
  await db.assignments.put(a)
  await enqueueReferenceWrite({
    id: `report_assignment:${a.pk}`,
    table: 'report_assignment',
    op: 'upsert',
    rowKey: a.pk,
    payload: payloadOf(a),
  })
  void pushReferenceOutbox()
}

/** Take one participant off one evaluator. */
export async function unassign(
  workshopId: string,
  participantId: string,
  evaluatorEmail: string,
  kind: AssignmentKind,
): Promise<void> {
  const pk = assignmentPk(workshopId, participantId, evaluatorEmail, kind)
  await db.assignments.delete(pk)
  await enqueueReferenceWrite({
    id: `report_assignment:${pk}`,
    table: 'report_assignment',
    op: 'delete',
    rowKey: pk,
    payload: null,
  })
  void pushReferenceOutbox()
}

/**
 * Move a participant from one evaluator to another.
 *
 * Add before remove. If the process dies between the two writes, the state left
 * behind is "two people have it", which the board shows as over-covered and a
 * human can fix in one click. Remove-then-add would leave "nobody has it", which
 * looks identical to a participant who was never assigned and so goes unnoticed.
 */
export async function transfer(
  workshopId: string,
  participantId: string,
  fromEmail: string,
  toEmail: string,
  kind: AssignmentKind,
  addedBy: string | null,
): Promise<void> {
  if (fromEmail.trim().toLowerCase() === toEmail.trim().toLowerCase()) return
  await assign(workshopId, participantId, toEmail, kind, { source: 'transfer', addedBy })
  await unassign(workshopId, participantId, fromEmail, kind)
}

/** Write an accepted auto-assignment proposal. Nothing else in the app writes 'auto'. */
export async function applyProposals(
  workshopId: string,
  proposals: AssignmentProposal[],
  kind: AssignmentKind,
  addedBy: string | null,
): Promise<number> {
  for (const p of proposals) {
    await assign(workshopId, p.participant_id, p.evaluator_email, kind, {
      source: 'auto',
      addedBy,
    })
  }
  return proposals.length
}

interface RemoteAssignmentRow {
  workshop_id: string
  participant_id: string
  evaluator_email: string
  kind: string
  source?: string | null
  added_by?: string | null
  added_at?: string | null
}

const isKind = (k: string): k is AssignmentKind => k === 'review' || k === 'observation'
const isSource = (s: string): s is AssignmentSource =>
  s === 'auto' || s === 'manual' || s === 'transfer'

/**
 * Replace the cached assignments with what the backend returned.
 *
 * `inScope` is the set of workshops the pull was authorized to see, and pruning
 * keys off it rather than off the ids present in `rows`. See the same argument
 * on `cacheSettingRows`: without it, deleting the last assignment in a workshop
 * elsewhere leaves this device showing it forever, because zero rows back would
 * mean zero rows pruned.
 */
export async function cacheAssignmentRows(
  rows: RemoteAssignmentRow[],
  inScope?: Iterable<string>,
): Promise<void> {
  const typed: ReportAssignment[] = []
  for (const r of rows) {
    if (!isKind(r.kind)) continue
    const email = r.evaluator_email.trim().toLowerCase()
    typed.push({
      pk: assignmentPk(r.workshop_id, r.participant_id, email, r.kind),
      workshop_id: r.workshop_id,
      participant_id: r.participant_id,
      evaluator_email: email,
      kind: r.kind,
      source: r.source && isSource(r.source) ? r.source : 'manual',
      added_by: r.added_by ?? null,
      added_at: r.added_at ?? null,
    })
  }

  const touched = new Set([...(inScope ?? []), ...rows.map((r) => r.workshop_id)])
  await db.transaction('rw', db.assignments, async () => {
    for (const workshopId of touched) {
      const stale = await db.assignments.where('workshop_id').equals(workshopId).toArray()
      const keep = new Set(typed.filter((t) => t.workshop_id === workshopId).map((t) => t.pk))
      await db.assignments.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
    }
    await db.assignments.bulkPut(typed)
  })
}
