import { db, newId } from './local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { enqueueReferenceWrite, pushReferenceOutbox, upsertParticipant } from './referenceWrite'
import { normalizeEmail, personIdForEmail, trackHistory } from '../lib/people'
import type { MembershipResult } from './membership'
import type {
  Participant,
  Person,
  PersonCard,
  PersonProfile,
  TrackTraining,
  WorkshopRole,
} from '../lib/types'

/**
 * The person layer's write path and its Dexie reads (tl-12).
 *
 * Everything that DECIDES lives in `src/lib/people.ts` and is pure. This file
 * stores, queues and fetches.
 *
 * Two transports, and the split is the same one tl-02 and tl-05 arrived at:
 *
 *  - **Profiles queue through the reference outbox.** A profile is authored, and
 *    an authored edit made on a phone in a room with no signal must survive.
 *    Writing straight to Supabase works online and silently loses the edit
 *    offline, which the program file calls a spec violation and is right to.
 *  - **A merge is an online-only RPC.** It is atomic across four tables and the
 *    server decides whether it is allowed at all, so queueing one would show two
 *    histories combined on this device that the server may refuse an hour later.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function cachedPerson(personId: string | null | undefined): Promise<Person | null> {
  if (!personId) return null
  return (await db.persons.get(personId)) ?? null
}

export async function cachedProfile(
  personId: string | null | undefined,
): Promise<PersonProfile | null> {
  if (!personId) return null
  return (await db.personProfiles.get(personId)) ?? null
}

/**
 * Every workshop this person appears in, from BOTH sides.
 *
 * A participant row puts somebody in a workshop; so does a membership. An
 * evaluator has no participant row and must still resolve to a workshop, or their
 * own profile would be unreadable by the colleague sitting next to them — which is
 * half of what this spec is for.
 */
export async function personWorkshopIds(personId: string): Promise<string[]> {
  const [participants, accounts] = await Promise.all([
    db.participants.where('person_id').equals(personId).toArray(),
    db.workshopPeople.toArray(),
  ])
  const ids = new Set(participants.map((p) => p.workshop_id))
  const person = await cachedPerson(personId)
  const email = normalizeEmail(person?.primary_email)
  if (email) {
    for (const row of accounts) if (normalizeEmail(row.email) === email) ids.add(row.workshop_id)
  }
  return [...ids]
}

/** The caller's role in each workshop they belong to, for `viewerFor()`. */
export async function myWorkshopRoles(appUserId: string | null): Promise<Map<string, WorkshopRole>> {
  const out = new Map<string, WorkshopRole>()
  if (!appUserId) return out
  const rows = await db.workshopMembers.where('app_user_id').equals(appUserId).toArray()
  for (const r of rows) out.set(r.workshop_id, r.role)
  return out
}

export async function cachedCard(personId: string | null | undefined): Promise<PersonCard | null> {
  if (!personId) return null
  return (await db.personCards.get(personId)) ?? null
}

/**
 * Ask the server what this reader may see, and what workshops this person has
 * attended. Cached, so the drawer still opens on a phone with no signal.
 *
 * It has to be the server for both halves. A withheld profile arrives as NO ROW
 * rather than as a refusal, so the device cannot tell it from a person nobody has
 * written a background for — and the track history spans workshops the reader is
 * not a member of and therefore never pulled. Both were found by the browser
 * walkthrough; see the migration's section 6b.
 */
export async function refreshPersonCard(personId: string): Promise<PersonCard | null> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return cachedCard(personId)
  try {
    const { data, error } = await supabase.rpc('person_card', { _person_id: personId })
    if (error) throw error
    const row = (data ?? {}) as { state?: string; readable?: boolean; trainings?: unknown }
    const card: PersonCard = {
      person_id: personId,
      state: (row.state as PersonCard['state']) ?? 'none',
      readable: row.readable !== false,
      trainings: Array.isArray(row.trainings) ? (row.trainings as PersonCard['trainings']) : [],
      at: new Date().toISOString(),
    }
    await db.personCards.put(card)
    return card
  } catch (err) {
    console.warn('[honest-eval] person card fetch failed; using cache', err)
    return cachedCard(personId)
  }
}

/**
 * Derived plus self-reported trainings, in one list.
 *
 * The derived half comes from the cached card rather than from local participant
 * rows, for the reason above: an evaluator holds only their own workshop, so
 * deriving locally answers "which of their workshops can I see" — which is not the
 * question this feature was asked to answer.
 */
export async function trackHistoryFor(
  personId: string,
  excludeWorkshopId?: string | null,
): Promise<TrackTraining[]> {
  const [card, profile] = await Promise.all([cachedCard(personId), cachedProfile(personId)])
  return trackHistory({
    derived: (card?.trainings ?? []).map((t) => ({
      label: t.label,
      year: t.year,
      workshopId: t.workshop_id,
    })),
    profile,
    excludeWorkshopId,
  })
}

// ---------------------------------------------------------------------------
// Writes — offline-first, through the reference outbox
// ---------------------------------------------------------------------------

export async function upsertPerson(p: Person): Promise<void> {
  const row: Person = { ...p, primary_email: normalizeEmail(p.primary_email) }
  await db.persons.put(row)
  await enqueueReferenceWrite({
    id: `person:${row.id}`,
    table: 'person',
    op: 'upsert',
    rowKey: row.id,
    payload: row,
  })
  void pushReferenceOutbox()
}

export async function upsertPersonProfile(p: PersonProfile): Promise<void> {
  const row: PersonProfile = { ...p, updated_at: new Date().toISOString() }
  await db.personProfiles.put(row)
  await enqueueReferenceWrite({
    id: `person_profile:${row.person_id}`,
    table: 'person_profile',
    op: 'upsert',
    rowKey: row.person_id,
    payload: row,
  })
  void pushReferenceOutbox()
}

/**
 * Delete the PROFILE, not the person.
 *
 * The distinction has to survive into the code because it is the thing an admin
 * clicking Delete is most likely to be wrong about. `person` stays, every
 * `participant` row still points at it, and every observation is untouched: this
 * removes a background card and nothing else.
 */
export async function deletePersonProfile(personId: string): Promise<void> {
  await db.personProfiles.delete(personId)
  await enqueueReferenceWrite({
    id: `person_profile:${personId}`,
    table: 'person_profile',
    op: 'delete',
    rowKey: personId,
    payload: null,
  })
  void pushReferenceOutbox()
}

/**
 * Find or create the person a participant is an appearance of, and link them.
 *
 * The link rule is exact normalized email and nothing else, which is the whole of
 * automatic matching in this spec. A participant with no address gets a person of
 * their own; if that turns out to be the same human as somebody else, the merge
 * screen asks a human, because a wrong merge blends two evaluation histories.
 *
 * Idempotent: called again for an already-linked participant it returns the
 * existing id and writes nothing.
 */
export async function ensurePersonForParticipant(participant: Participant): Promise<string> {
  if (participant.person_id) return participant.person_id

  const people = await db.persons.toArray()
  let personId = personIdForEmail(people, participant.registered_email)

  if (!personId) {
    personId = newId()
    await upsertPerson({
      id: personId,
      display_name: participant.name,
      primary_email: normalizeEmail(participant.registered_email),
    })
  }

  // Written through the participant's own queued writer rather than a direct put,
  // so the link reaches the backend by the same path every other roster edit does.
  await upsertParticipant({ ...participant, person_id: personId })
  return personId
}

/*
 * There is deliberately no `ensurePersonForAccount` here.
 *
 * The obvious shape — find or create a person, then `update app_user set
 * person_id` — cannot work and would have failed silently in the one direction
 * that matters. tl-01 REVOKED the write grants on `app_user` rather than merely
 * omitting a policy, so a browser cannot write that table at all; the update would
 * come back 42501 for every caller including a platform owner, and the account
 * would go on looking unlinked with nothing on screen saying why.
 *
 * So the link is made server-side, by the `app_user_link_person` trigger in
 * 20260801000700_person_profiles.sql, which runs on insert and finds-or-creates by
 * email on exactly the rule this file uses for participants. Accounts that already
 * existed were linked by the same migration's backfill.
 */

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/**
 * Refresh the cached people and profiles.
 *
 * Deliberately NOT folded into `loadReferenceData`'s clear-then-overwrite
 * transaction, for the reason tl-07 recorded about `doc_draft`: that function
 * CLEARS, which is right for reference data the backend owns and wrong for rows
 * holding human edits. A profile whose owner is `private` is filtered out of this
 * response by RLS rather than absent, and a clearing pull would delete this
 * device's copy of every profile it merely could not read today.
 *
 * So this merges: rows that came back are written, rows that did not are left
 * alone. Divergence is bounded because the outbox is drained first and the server
 * is the only writer of anything not in it.
 */
export async function refreshPeople(): Promise<{ people: number; profiles: number } | null> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return null
  try {
    const [p, pp] = await Promise.all([
      supabase.from('person').select('*'),
      supabase.from('person_profile').select('*'),
    ])
    if (p.error) throw p.error
    if (pp.error) throw pp.error
    const people = (p.data ?? []) as Person[]
    const profiles = ((pp.data ?? []) as PersonProfile[]).map(normalizeProfileRow)
    await db.transaction('rw', [db.persons, db.personProfiles], async () => {
      if (people.length > 0) await db.persons.bulkPut(people)
      if (profiles.length > 0) await db.personProfiles.bulkPut(profiles)
    })
    return { people: people.length, profiles: profiles.length }
  } catch (err) {
    console.warn('[honest-eval] people fetch failed; using cache', err)
    return null
  }
}

/**
 * Postgres hands back `null` for an array column that was never written and a
 * jsonb `[]` as a real array. The type says these are arrays, and a component
 * calling `.map()` on a null is a blank screen rather than an error, so the shape
 * is fixed once here rather than defended against at every read site.
 */
function normalizeProfileRow(row: PersonProfile): PersonProfile {
  return {
    ...row,
    certifications: row.certifications ?? [],
    education: row.education ?? [],
    experience_areas: row.experience_areas ?? [],
    languages: row.languages ?? [],
    prior_trainings: Array.isArray(row.prior_trainings) ? row.prior_trainings : [],
  }
}

// ---------------------------------------------------------------------------
// Merge — online only
// ---------------------------------------------------------------------------

export interface MergeSummary {
  survivorName: string
  absorbedName: string
  movedParticipants: number
  movedAccounts: number
}

export type MergeResult =
  | { ok: true; summary: MergeSummary }
  | Exclude<MembershipResult, { ok: true }>

/**
 * Combine two people into one.
 *
 * Refuses unless the caller administers a workshop for BOTH, enforced server-side
 * in `merge_persons()` and reported here with tl-02's refusal shape: `42501` plus
 * a `tl12.*` slug in `detail`, which the UI maps to a chrome string rather than
 * rendering Postgres prose. The slug matcher in db/membership.ts is a SHAPE
 * (`/^tl\d{2}\./`) rather than a prefix, so these are labelled for free.
 *
 * No evaluation evidence moves. Participant rows are repointed, not deleted, and
 * the absorbed person's profile is folded in rather than discarded.
 */
export async function mergePersons(survivorId: string, absorbedId: string): Promise<MergeResult> {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) {
    return { ok: false, reason: 'offline', slug: null, message: null }
  }
  try {
    const { data, error } = await supabase.rpc('merge_persons', {
      _survivor_id: survivorId,
      _absorbed_id: absorbedId,
    })
    if (error) {
      const slug =
        typeof error.details === 'string' && /^tl\d{2}\.[a-z_]+$/.test(error.details)
          ? error.details
          : null
      return {
        ok: false,
        reason: error.code === '42501' ? 'refused' : 'failed',
        slug,
        message: error.message ?? 'That merge could not be made.',
      }
    }
    const row = (data ?? {}) as Record<string, unknown>
    // The server has changed four tables; the local cache is now behind on all of
    // them. Refreshing before returning is what stops the merge screen re-offering
    // the pair it has just combined.
    await db.persons.delete(absorbedId)
    await db.personProfiles.delete(absorbedId)
    await refreshPeople()
    const { loadReferenceData } = await import('./reference')
    await loadReferenceData()
    return {
      ok: true,
      summary: {
        survivorName: String(row.survivor_name ?? ''),
        absorbedName: String(row.absorbed_name ?? ''),
        movedParticipants: Number(row.moved_participants ?? 0),
        movedAccounts: Number(row.moved_accounts ?? 0),
      },
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      slug: null,
      message: err instanceof Error ? err.message : 'That merge could not be made.',
    }
  }
}

/** Everything stored about one person, as a file. The spec's export action. */
export async function exportPerson(personId: string): Promise<{
  schema: string
  exported_at: string
  person: Person | null
  profile: PersonProfile | null
  derived_trainings: TrackTraining[]
  appears_in: { workshop_id: string; workshop_name: string | null; participant_id: string }[]
}> {
  const [person, profile, participants, workshops] = await Promise.all([
    cachedPerson(personId),
    cachedProfile(personId),
    db.participants.where('person_id').equals(personId).toArray(),
    db.workshops.toArray(),
  ])
  const byId = new Map(workshops.map((w) => [w.id, w]))
  return {
    schema: 'cairn.person-export/v1',
    exported_at: new Date().toISOString(),
    person,
    profile,
    derived_trainings: (await trackHistoryFor(personId)).filter((t) => t.kind === 'derived'),
    appears_in: participants.map((p) => ({
      workshop_id: p.workshop_id,
      workshop_name: byId.get(p.workshop_id)?.name ?? null,
      participant_id: p.id,
    })),
  }
}
