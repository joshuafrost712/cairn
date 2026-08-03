import type {
  Person,
  PersonCard,
  PersonProfile,
  PriorTraining,
  ProfileVisibility,
  TrackTraining,
  WorkshopPerson,
  WorkshopRole,
} from './types'

/**
 * The pure half of the person layer (tl-12).
 *
 * Everything here is a function of its arguments: no Dexie, no Supabase, no
 * clock. db/people.ts does the storing; this file does the deciding, and it is
 * the file the tests point at. The split matters most for two rules that are easy
 * to state and easy to get subtly wrong — who may see a profile, and which of two
 * people is the same human — because both fail silently when wrong.
 */

/** Lower-cased and trimmed. The only form an email is ever compared in. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = (email ?? '').trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/** Roles that may author somebody else's profile. Mirrors the RLS policy. */
export const PROFILE_ADMIN_ROLES: WorkshopRole[] = ['chief_admin', 'admin']

/** A profile with nothing in it. The shape an editor opens on for a new person. */
export function blankProfile(personId: string): PersonProfile {
  return {
    person_id: personId,
    headline: null,
    certifications: [],
    education: [],
    experience_areas: [],
    languages: [],
    prior_trainings: [],
    notes: null,
    // `workshop` rather than `private`, and this is Joshua's call of 2026-08-01
    // rather than the spec's. The spec gated everything behind a consent flag
    // defaulting false; he dropped the flag, on the grounds that a permission the
    // subject has no account to exercise and an administrator must sweep through
    // 26 times is a chore rather than a consent record. What remains is a real
    // choice with a real default: an admin who wants a profile withheld sets it to
    // `admins` or `private`, and the server enforces that, not the drawer.
    visibility: 'workshop',
  }
}

/** True when nothing has been filled in, so the drawer can say so rather than render an empty card. */
export function isProfileEmpty(p: PersonProfile | null | undefined): boolean {
  if (!p) return true
  return (
    !p.headline?.trim() &&
    !p.notes?.trim() &&
    p.certifications.length === 0 &&
    p.education.length === 0 &&
    p.experience_areas.length === 0 &&
    p.languages.length === 0 &&
    p.prior_trainings.length === 0
  )
}

/**
 * Who is asking, as far as a visibility decision is concerned.
 *
 * `isAdmin` means "administers a workshop this person is in", which is the same
 * predicate `person_is_administered_by_me()` computes server-side — not "is an
 * admin somewhere". The distinction is the whole of cross-workshop scoping.
 */
export interface ProfileViewer {
  isSelf: boolean
  isAdmin: boolean
  sharesWorkshop: boolean
}

export type ProfileDenial = 'not-in-workshop' | 'admins-only' | 'private'

/**
 * The server's word on a profile's state, turned into the reason to print.
 *
 * THE authority on whether a profile is withheld, because it is the only one that
 * can be: `person_profile_select` withholds by returning no row, so a client
 * looking at its own cache cannot tell a withheld profile from an unwritten one.
 * `person_card()` answers that question for a reader who may not read the row.
 *
 * Null means "nothing is being withheld" — which covers a readable profile, a
 * person with no profile yet, and the case where this device has never managed to
 * ask. See the hook for why falling back to readable is the safe direction.
 */
export function denialFromCardState(
  state: PersonCard['state'] | null | undefined,
): ProfileDenial | null {
  switch (state) {
    case 'admins':
      return 'admins-only'
    case 'private':
      return 'private'
    case 'not-in-workshop':
      return 'not-in-workshop'
    default:
      return null
  }
}

/**
 * Whether this viewer may read this profile, and if not, WHY.
 *
 * A mirror of `person_profile_select`, and mirrors are the thing this codebase
 * gets wrong: `test/personProfiles.test.ts` pins the two against each other by
 * reading the policy out of the migration SQL, the same technique tl-06 used for
 * its column guard. The client copy exists so the drawer can print the reason
 * rather than an empty card — an evaluator who sees a blank profile assumes the
 * app is broken, and one who sees "this person's background is admin-only"
 * assumes nothing.
 *
 * It is NOT the enforcement. If this function and the policy ever disagree, the
 * policy wins and the drawer renders nothing, which is the safe direction.
 */
export function canReadProfile(
  visibility: ProfileVisibility,
  viewer: ProfileViewer,
): { allowed: true } | { allowed: false; reason: ProfileDenial } {
  if (viewer.isSelf || viewer.isAdmin) return { allowed: true }
  if (!viewer.sharesWorkshop) return { allowed: false, reason: 'not-in-workshop' }
  if (visibility === 'workshop') return { allowed: true }
  return { allowed: false, reason: visibility === 'admins' ? 'admins-only' : 'private' }
}

/** Whether this viewer may edit. Deliberately narrower than reading: self or admin, never a peer. */
export function canEditProfile(viewer: ProfileViewer): boolean {
  return viewer.isSelf || viewer.isAdmin
}

/**
 * Build a viewer from what the app already knows.
 *
 * `sharesWorkshop` is derived from the person appearing in a workshop the caller
 * holds a membership in, which is why it takes the memberships rather than the
 * active workshop: a profile drawer opened from a report can be about somebody in
 * a workshop the reader is not currently switched to.
 */
export function viewerFor(args: {
  personId: string
  myPersonId: string | null | undefined
  /** Workshops the person appears in, from participant rows and memberships. */
  personWorkshopIds: string[]
  /** The caller's own role per workshop. */
  myRoles: Map<string, WorkshopRole>
}): ProfileViewer {
  const { personId, myPersonId, personWorkshopIds, myRoles } = args
  const isSelf = Boolean(myPersonId) && myPersonId === personId
  let sharesWorkshop = false
  let isAdmin = false
  for (const id of personWorkshopIds) {
    const role = myRoles.get(id)
    if (!role) continue
    sharesWorkshop = true
    if (PROFILE_ADMIN_ROLES.includes(role)) isAdmin = true
  }
  return { isSelf, isAdmin, sharesWorkshop }
}

/** One workshop this person attended, as the server reports it. */
export interface DerivedTraining {
  label: string
  year: string | null
  workshopId: string
}

/**
 * Every training this person has, derived and self-reported, in one list.
 *
 * The derived half arrives from the server (`person_card()`), NOT from local
 * participant rows, and that is the correction the browser walkthrough forced. An
 * evaluator's device holds only the workshops they belong to, so deriving here
 * from `db.participants` answered "which of their workshops can I see" and left
 * the Epistles row — the row this whole feature exists to surface — invisible to
 * exactly the person it exists for.
 *
 * The workshop currently being looked at is excluded, because "prior trainings"
 * that includes the room you are standing in is noise.
 *
 * Ordering is newest-first by whatever year the entry carries, with undated
 * entries last, and derived before self-reported on a tie — the deployment's own
 * record is the one an evaluator should read first.
 */
export function trackHistory(args: {
  derived: DerivedTraining[]
  profile: PersonProfile | null | undefined
  /** The workshop being viewed from, excluded from the derived list. */
  excludeWorkshopId?: string | null
}): TrackTraining[] {
  const { derived, profile, excludeWorkshopId } = args

  const fromDeployment: TrackTraining[] = derived
    .filter((d) => d.workshopId !== excludeWorkshopId)
    .map((d) => ({
      label: d.label,
      year: d.year ?? null,
      kind: 'derived' as const,
      workshopId: d.workshopId,
    }))

  const self: TrackTraining[] = (profile?.prior_trainings ?? [])
    .filter((t) => t.label?.trim())
    .map((t) => ({ label: t.label.trim(), year: t.year ?? null, kind: 'self_reported' as const }))

  return [...fromDeployment, ...self].sort((a, b) => {
    const ay = a.year ?? ''
    const by = b.year ?? ''
    if (ay !== by) {
      if (!ay) return 1
      if (!by) return -1
      return by.localeCompare(ay)
    }
    if (a.kind !== b.kind) return a.kind === 'derived' ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}


/**
 * Two people the deployment cannot tell apart, for the merge screen to ask about.
 *
 * `certain` is an exact normalized email match, which is what the migration and
 * `personIdForEmail` link automatically — so a certain candidate reaching this
 * list means something is already wrong (two person rows holding one address) and
 * it is worth surfacing rather than hiding. Everything else is `suggested` and
 * requires a human.
 *
 * NAME MATCHING IS A SUGGESTION AND NEVER AN ACTION. A wrong merge blends two
 * humans' evaluation histories, and unpicking it afterwards is worse than never
 * having linked them, which is the rule tl-10 applies to roster import and the
 * reason this returns candidates rather than performing anything.
 */
export interface MergeCandidate {
  a: Person
  b: Person
  confidence: 'certain' | 'suggested'
  /** Chrome id fragment naming what matched. */
  basis: 'email' | 'name' | 'name-initial' | 'name-typo'
}

export function mergeCandidates(people: Person[]): MergeCandidate[] {
  const out: MergeCandidate[] = []
  const seen = new Set<string>()
  const pairKey = (a: Person, b: Person) => [a.id, b.id].sort().join('::')

  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i]
      const b = people[j]
      const key = pairKey(a, b)
      if (seen.has(key)) continue

      const ea = normalizeEmail(a.primary_email)
      const eb = normalizeEmail(b.primary_email)
      if (ea && eb && ea === eb) {
        seen.add(key)
        out.push({ a, b, confidence: 'certain', basis: 'email' })
        continue
      }
      // Two different addresses are positive evidence of two different people, so
      // a name match between them is not offered at all. Without this the screen
      // would propose merging every pair of siblings on the roster.
      if (ea && eb && ea !== eb) continue

      const na = nameKey(a.display_name)
      const nb = nameKey(b.display_name)
      if (na && na === nb) {
        seen.add(key)
        out.push({ a, b, confidence: 'suggested', basis: 'name' })
        continue
      }
      if (initialKey(a.display_name) && initialKey(a.display_name) === initialKey(b.display_name)) {
        seen.add(key)
        out.push({ a, b, confidence: 'suggested', basis: 'name-initial' })
        continue
      }
      // One character apart. This is the case Joshua chose the full merge flow
      // FOR — "a name typed differently in each workshop" — and it is the only
      // approximate rule here, so it is fenced hard: both names long enough that a
      // single character is not most of them, and never offered when the two hold
      // different addresses (checked above). It is a SUGGESTION and the screen
      // still asks; nothing in this file ever merges anybody.
      if (na.length >= MIN_TYPO_LENGTH && nb.length >= MIN_TYPO_LENGTH && withinOneEdit(na, nb)) {
        seen.add(key)
        out.push({ a, b, confidence: 'suggested', basis: 'name-typo' })
      }
    }
  }
  return out.sort(
    (x, y) =>
      (x.confidence === 'certain' ? 0 : 1) - (y.confidence === 'certain' ? 0 : 1) ||
      x.a.display_name.localeCompare(y.a.display_name),
  )
}

/**
 * Below this, one character is too much of the name for a difference to mean
 * anything: "Ana" and "Ann" are two people far more often than one.
 */
const MIN_TYPO_LENGTH = 8

/**
 * Are these two strings one insertion, deletion or substitution apart?
 *
 * Written as an early-exit two-pointer walk rather than a Levenshtein matrix,
 * because the only question asked is "is the distance at most one" and the walk
 * answers it in linear time with no allocation. Over a roster this runs O(n^2)
 * times.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let slack = 1
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
      continue
    }
    if (slack === 0) return false
    slack--
    // Same length means a substitution, so both advance; otherwise the longer
    // string has the extra character and only it advances.
    if (short.length === long.length) i++
    j++
  }
  return true
}

/** Case, accent and punctuation folded away; word order kept. "Amos  Khokhar" → "amos khokhar". */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Surname plus first initial: "Amos Khokhar" and "A. Khokhar" collapse together.
 *
 * Only ever a SUGGESTION. Two people can share this key legitimately, which is
 * exactly why the merge screen asks and never acts.
 */
export function initialKey(name: string): string | null {
  const parts = nameKey(name).split(' ').filter(Boolean)
  if (parts.length < 2) return null
  return `${parts[0][0]} ${parts[parts.length - 1]}`
}

/**
 * The person a new email should link to, or null for "create one".
 *
 * Exact match only, and that is the whole rule. See `mergeCandidates` for why
 * nothing fuzzier is allowed to act on its own.
 */
export function personIdForEmail(people: Person[], email: string | null | undefined): string | null {
  const key = normalizeEmail(email)
  if (!key) return null
  return people.find((p) => normalizeEmail(p.primary_email) === key)?.id ?? null
}

/** Trim, drop blanks, drop duplicates, keep order. What every list field is stored as. */
export function cleanList(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const v = raw.trim()
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

/** Same, for the self-reported training list. */
export function cleanTrainings(values: PriorTraining[]): PriorTraining[] {
  const out: PriorTraining[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const label = (raw.label ?? '').trim()
    if (!label) continue
    const year = (raw.year ?? '').trim() || null
    const key = `${label.toLowerCase()}::${year ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label, year })
  }
  return out
}

/** The compact card shown during capture: a headline, the track, and the work areas. Nothing else. */
export interface CaptureCard {
  headline: string | null
  trainings: TrackTraining[]
  experienceAreas: string[]
}

/**
 * What an evaluator sees on the capture screen when they open somebody's card.
 *
 * Deliberately three fields. The spec's constraint is "an evaluator mid-observation
 * does not want a modal", and the way that constraint gets lost is one useful
 * field at a time, so the narrowing lives here in a tested function rather than in
 * whatever the component happened to render.
 */
export function captureCard(
  profile: PersonProfile | null | undefined,
  trainings: TrackTraining[],
): CaptureCard {
  return {
    headline: profile?.headline?.trim() || null,
    trainings: trainings.slice(0, 4),
    experienceAreas: (profile?.experience_areas ?? []).slice(0, 6),
  }
}

/** A directory row's person id, for opening a profile from tl-11's people list. */
export function personIdForDirectoryRow(
  row: WorkshopPerson,
  accounts: { id: string; person_id?: string | null }[],
): string | null {
  return accounts.find((a) => a.id === row.app_user_id)?.person_id ?? null
}
