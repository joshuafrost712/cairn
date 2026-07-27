import { db, newId } from './local'
import {
  deleteParticipantRow,
  deleteTeamRow,
  upsertParticipant,
  upsertTeam,
  upsertWorkshop,
} from './referenceWrite'
import type { Participant, Team, Workshop } from '../lib/types'

// Admin edits the workshop meta + roster (teams and participants). Writes go to the
// local Dexie cache immediately AND queue a backend upsert/delete via referenceWrite,
// so — unlike before — roster edits sync to Supabase and survive loadReferenceData()'s
// pull instead of being clobbered. Roster edits flow into captures immediately
// (captures embed the participant scope + ids from this cache).

export async function updateWorkshop(id: string, patch: Partial<Workshop>): Promise<void> {
  const current = await db.workshops.get(id)
  if (!current) return
  await upsertWorkshop({ ...current, ...patch })
}

export async function addTeam(workshopId: string, name: string): Promise<Team> {
  const t: Team = { id: newId(), workshop_id: workshopId, name }
  await upsertTeam(t)
  return t
}

export async function updateTeam(id: string, patch: Partial<Team>): Promise<void> {
  const current = await db.teams.get(id)
  if (!current) return
  await upsertTeam({ ...current, ...patch })
}

/** Delete a team; its members are unassigned (team_id -> null), not deleted. */
export async function deleteTeam(id: string): Promise<void> {
  const members = await db.participants.where('team_id').equals(id).toArray()
  // Reassign members first (queues participant upserts), then delete the team.
  for (const m of members) await upsertParticipant({ ...m, team_id: null })
  await deleteTeamRow(id)
}

export async function addParticipant(
  workshopId: string,
  fields: { name: string; registered_email?: string | null; team_id?: string | null },
): Promise<Participant> {
  const p: Participant = {
    id: newId(),
    workshop_id: workshopId,
    name: fields.name,
    registered_email: fields.registered_email ?? null,
    team_id: fields.team_id ?? null,
    preferred_language: 'English',
  }
  await upsertParticipant(p)
  return p
}

export async function updateParticipant(id: string, patch: Partial<Participant>): Promise<void> {
  const current = await db.participants.get(id)
  if (!current) return
  await upsertParticipant({ ...current, ...patch })
}

export async function deleteParticipant(id: string): Promise<void> {
  await deleteParticipantRow(id)
}
