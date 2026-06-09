import { db } from './local'
import type { Participant, Team, Workshop } from '../lib/types'

// Admin writes to the local reference cache (Dexie). In local-only mode these
// persist on the device. With Supabase configured, loadReferenceData() overwrites
// the cache from the backend on next load, so manage the roster in the backend
// there (or sync up — not built yet). Roster edits flow into captures immediately
// (captures embed the participant scope + ids from this cache).

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
}

export async function updateWorkshop(id: string, patch: Partial<Workshop>): Promise<void> {
  await db.workshops.update(id, patch)
}

export async function addTeam(workshopId: string, name: string): Promise<Team> {
  const t: Team = { id: newId(), workshop_id: workshopId, name }
  await db.teams.put(t)
  return t
}

export async function updateTeam(id: string, patch: Partial<Team>): Promise<void> {
  await db.teams.update(id, patch)
}

/** Delete a team; its members are unassigned (team_id -> null), not deleted. */
export async function deleteTeam(id: string): Promise<void> {
  await db.transaction('rw', [db.teams, db.participants], async () => {
    const members = await db.participants.where('team_id').equals(id).toArray()
    await Promise.all(members.map((m) => db.participants.update(m.id, { team_id: null })))
    await db.teams.delete(id)
  })
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
  await db.participants.put(p)
  return p
}

export async function updateParticipant(id: string, patch: Partial<Participant>): Promise<void> {
  await db.participants.update(id, patch)
}

export async function deleteParticipant(id: string): Promise<void> {
  await db.participants.delete(id)
}
