import { db, newId } from './local'
import {
  pushReferenceOutbox,
  queueParticipant,
  queueParticipantDelete,
  queueRosterImportBatch,
  queueTeam,
  queueTeamDelete,
} from './referenceWrite'
import { normalizeName, type ImportPlan, type PlannedRow } from '../roster/planImport'
import type { Participant, RosterImportBatch, RosterImportRevert, Team } from '../lib/types'

/**
 * Committing an import, and undoing one (tl-10).
 *
 * The commit executes the plan the administrator approved and nothing else: no
 * re-parsing, no re-matching, no second opinion. Two code paths that agree today is
 * how a preview stops describing the write it authorized.
 *
 * ONE TRANSACTION, so a failure halfway cannot leave a half-imported roster. That
 * is also why this module queues through referenceWrite's `queue*` functions and
 * pushes once at the end rather than calling the single-row writers: each of those
 * kicks the network drain, and `pushReferenceOutbox` awaits a fetch, which a Dexie
 * transaction zone cannot span.
 *
 * Teams before participants, because a participant references one.
 */

export interface CommitInput {
  workshopId: string
  plan: ImportPlan
  filename: string
  actorEmail: string | null
}

export interface CommitResult {
  batch: RosterImportBatch
  created: number
  updated: number
  unchanged: number
  teamsCreated: number
}

export async function commitImport(input: CommitInput): Promise<CommitResult> {
  const { workshopId, plan, filename, actorEmail } = input
  const rows = plan.rows.filter((r) => r.selected && (r.verdict === 'create' || r.verdict === 'update' || r.verdict === 'unchanged'))

  const existingTeams = await db.teams.where('workshop_id').equals(workshopId).toArray()
  const teamIdByName = new Map<string, string>(existingTeams.map((t) => [normalizeName(t.name), t.id]))

  // Ids are minted BEFORE the transaction, so the batch record and the writes name
  // the same rows even if the transaction is retried by Dexie.
  const newTeams: Team[] = []
  for (const name of plan.newTeams) {
    const key = normalizeName(name)
    if (teamIdByName.has(key)) continue
    const team: Team = { id: newId(), workshop_id: workshopId, name }
    newTeams.push(team)
    teamIdByName.set(key, team.id)
  }

  const participantsById = new Map<string, Participant>(
    (await db.participants.where('workshop_id').equals(workshopId).toArray()).map((p) => [p.id, p]),
  )

  const creates: Participant[] = []
  const updates: { row: Participant; revert: RosterImportRevert }[] = []

  for (const row of rows) {
    const teamId = resolveTeam(row, teamIdByName)
    if (row.verdict === 'create') {
      creates.push({
        id: newId(),
        workshop_id: workshopId,
        name: row.values.name?.trim() ?? row.label,
        registered_email: row.values.registered_email?.trim() || null,
        team_id: teamId,
        // Matches addParticipant's default, so a participant typed in and a
        // participant imported are the same shape.
        preferred_language: row.values.preferred_language?.trim() || 'English',
      })
      continue
    }
    if (row.verdict !== 'update' || !row.participantId) continue
    const current = participantsById.get(row.participantId)
    if (!current) continue

    const before: RosterImportRevert['before'] = {}
    const patch: Partial<Participant> = {}
    for (const change of row.changes) {
      // Written out per field rather than indexed, because the four differ in what
      // null means: a name cannot be null, an email and a team can, and a team's new
      // value comes from the resolved id rather than from the file's text.
      if (change.field === 'name') {
        before.name = current.name
        patch.name = change.after ?? current.name
      } else if (change.field === 'registered_email') {
        before.registered_email = current.registered_email ?? null
        patch.registered_email = change.after ?? null
      } else if (change.field === 'preferred_language') {
        before.preferred_language = current.preferred_language ?? null
        patch.preferred_language = change.after ?? null
      } else if (change.field === 'team_id') {
        before.team_id = current.team_id ?? null
        patch.team_id = teamId
      }
    }
    if (Object.keys(patch).length === 0) continue
    updates.push({ row: { ...current, ...patch }, revert: { id: current.id, before } })
  }

  const batch: RosterImportBatch = {
    id: `rosterimport_${newId()}`,
    workshop_id: workshopId,
    actor_email: actorEmail,
    filename,
    row_count: rows.length,
    created_participants: creates.map((p) => p.id),
    created_teams: newTeams.map((t) => t.id),
    updated_participants: updates.map((u) => u.revert),
    at: new Date().toISOString(),
    undone_at: null,
    undone_by: null,
  }

  await db.transaction(
    'rw',
    [db.teams, db.participants, db.referenceOutbox, db.rosterImportBatches],
    async () => {
      for (const team of newTeams) await queueTeam(team)
      for (const participant of creates) await queueParticipant(participant)
      for (const update of updates) await queueParticipant(update.row)
      await queueRosterImportBatch(batch)
    },
  )
  void pushReferenceOutbox()

  return {
    batch,
    created: creates.length,
    updated: updates.length,
    unchanged: rows.filter((r) => r.verdict === 'unchanged').length,
    teamsCreated: newTeams.length,
  }
}

function resolveTeam(row: PlannedRow, teamIdByName: Map<string, string>): string | null {
  const named = row.newTeamName ?? row.values.team
  if (!named || !named.trim()) {
    // No team column, or a blank cell. A blank never clears an existing team: the
    // planner does not emit a team_id change for it, so this only ever applies to a
    // creation, where null is right.
    return null
  }
  return teamIdByName.get(normalizeName(named)) ?? null
}

export interface UndoRefusal {
  id: string
  name: string
  observations: number
}

export interface UndoResult {
  deleted: number
  reverted: number
  teamsDeleted: number
  /** People this batch created who have since acquired evidence, named. */
  refused: UndoRefusal[]
  /** Set when the batch cannot be undone at all. */
  error?: 'already-undone' | 'not-found'
}

/**
 * Undo one import.
 *
 * THE REFUSAL IS THE INTERESTING PART. A participant this batch created who has
 * since been observed cannot be deleted by an undo button: deleting them would take
 * an evaluator's recorded work with them, and that is a destructive act belonging to
 * tl-07's dialog with its typed-name confirmation, not to a one-click reversal of a
 * file choice. So they are kept, NAMED, and the rest of the undo completes. A
 * partial undo that says exactly who it kept is more useful than an all-or-nothing
 * one that refuses because of a single person.
 *
 * Reverting an update is unconditional by contrast, because it restores a value
 * rather than removing a row: nothing recorded against that participant is touched
 * by their email going back to what it was.
 */
export async function undoImport(batchId: string, actorEmail: string | null): Promise<UndoResult> {
  const batch = await db.rosterImportBatches.get(batchId)
  if (!batch) return { deleted: 0, reverted: 0, teamsDeleted: 0, refused: [], error: 'not-found' }
  if (batch.undone_at) {
    return { deleted: 0, reverted: 0, teamsDeleted: 0, refused: [], error: 'already-undone' }
  }

  const created = await db.participants.bulkGet(batch.created_participants)
  const observations = await db.observations.toArray()
  const observedCounts = new Map<string, number>()
  for (const o of observations) {
    if (!o.participant_id) continue
    observedCounts.set(o.participant_id, (observedCounts.get(o.participant_id) ?? 0) + 1)
  }

  const refused: UndoRefusal[] = []
  const deletable: string[] = []
  for (const participant of created) {
    if (!participant) continue
    const count = observedCounts.get(participant.id) ?? 0
    if (count > 0) refused.push({ id: participant.id, name: participant.name, observations: count })
    else deletable.push(participant.id)
  }

  const reverts: Participant[] = []
  for (const revert of batch.updated_participants) {
    const current = await db.participants.get(revert.id)
    if (!current) continue
    reverts.push({ ...current, ...revert.before })
  }

  // A team this batch created is deleted only if nobody is on it AFTER the reversal
  // above, which is why the membership is computed from the post-undo state rather
  // than from the store as it stands.
  const afterTeamOf = new Map<string, string | null>()
  for (const p of await db.participants.where('workshop_id').equals(batch.workshop_id).toArray()) {
    afterTeamOf.set(p.id, p.team_id)
  }
  for (const p of reverts) afterTeamOf.set(p.id, p.team_id)
  for (const id of deletable) afterTeamOf.delete(id)
  const occupied = new Set([...afterTeamOf.values()].filter(Boolean) as string[])
  const teamsToDelete = batch.created_teams.filter((id) => !occupied.has(id))

  const undone: RosterImportBatch = {
    ...batch,
    undone_at: new Date().toISOString(),
    undone_by: actorEmail,
  }

  await db.transaction(
    'rw',
    [db.teams, db.participants, db.referenceOutbox, db.rosterImportBatches],
    async () => {
      for (const id of deletable) await queueParticipantDelete(id)
      for (const participant of reverts) await queueParticipant(participant)
      for (const id of teamsToDelete) await queueTeamDelete(id)
      await queueRosterImportBatch(undone)
    },
  )
  void pushReferenceOutbox()

  return {
    deleted: deletable.length,
    reverted: reverts.length,
    teamsDeleted: teamsToDelete.length,
    refused,
  }
}

/** This workshop's imports, newest first. */
export async function listImportBatches(workshopId: string): Promise<RosterImportBatch[]> {
  const rows = await db.rosterImportBatches.where('workshop_id').equals(workshopId).toArray()
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
}
