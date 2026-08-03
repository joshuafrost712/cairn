import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  blankProfile,
  canEditProfile,
  canReadProfile,
  captureCard,
  cleanList,
  cleanTrainings,
  denialFromCardState,
  initialKey,
  isProfileEmpty,
  mergeCandidates,
  nameKey,
  normalizeEmail,
  personIdForEmail,
  trackHistory,
  viewerFor,
  withinOneEdit,
} from '../src/lib/people'
import { classifySetupChange, type SetupChange } from '../src/setup/impact'
import { findChromeNode } from '../src/lib/content/chrome'
import { BACKUP_SCHEMA_ID } from '../src/db/backup'
import type { Person, PersonProfile, WorkshopRole } from '../src/lib/types'

/**
 * tl-12: the person layer's rules, and the tripwires that keep them true.
 *
 * The rules that decide who may read somebody's credentials are stated twice —
 * once in `person_profile`'s RLS and once in `canReadProfile`, so the drawer can
 * say WHY rather than render an empty card — and a mirror that drifts is this
 * codebase's characteristic failure. So the last block reads the policy out of the
 * migration and asserts the two agree on the shape.
 */

const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20260801000700_person_profiles.sql', import.meta.url),
  'utf8',
)

/**
 * The migration with its `--` commentary stripped.
 *
 * Needed because this file argues at length, in comments, about a consent flag it
 * deliberately does not have — and a tripwire that greps the whole file for the
 * word would fire on the paragraph explaining its absence. Assertions about what
 * the SCHEMA contains use this; assertions about what the SQL says use MIGRATION.
 */
const SCHEMA = MIGRATION.replace(/^\s*--.*$/gm, '')

const person = (over: Partial<Person> = {}): Person => ({
  id: 'p1',
  display_name: 'Amos Khokhar',
  primary_email: 'amos@example.org',
  ...over,
})

const profileWith = (over: Partial<PersonProfile> = {}): PersonProfile => ({
  ...blankProfile('p1'),
  ...over,
})

const roles = (entries: [string, WorkshopRole][]) => new Map<string, WorkshopRole>(entries)

// ---------------------------------------------------------------------------

describe('visibility', () => {
  it('lets a fellow member read a workshop-visible profile', () => {
    const viewer = { isSelf: false, isAdmin: false, sharesWorkshop: true }
    expect(canReadProfile('workshop', viewer)).toEqual({ allowed: true })
  })

  it('withholds an admins-only profile from an evaluator IN the workshop, and says which', () => {
    const viewer = { isSelf: false, isAdmin: false, sharesWorkshop: true }
    expect(canReadProfile('admins', viewer)).toEqual({ allowed: false, reason: 'admins-only' })
  })

  it('withholds a private profile from a fellow member', () => {
    const viewer = { isSelf: false, isAdmin: false, sharesWorkshop: true }
    expect(canReadProfile('private', viewer)).toEqual({ allowed: false, reason: 'private' })
  })

  it('withholds even a workshop-visible profile from somebody in no shared workshop', () => {
    const viewer = { isSelf: false, isAdmin: false, sharesWorkshop: false }
    expect(canReadProfile('workshop', viewer)).toEqual({
      allowed: false,
      reason: 'not-in-workshop',
    })
  })

  it('lets the person themselves read their own, at every setting', () => {
    const me = { isSelf: true, isAdmin: false, sharesWorkshop: false }
    for (const v of ['workshop', 'admins', 'private'] as const) {
      expect(canReadProfile(v, me)).toEqual({ allowed: true })
    }
  })

  it('lets an administrator of one of their workshops read it, at every setting', () => {
    const admin = { isSelf: false, isAdmin: true, sharesWorkshop: true }
    for (const v of ['workshop', 'admins', 'private'] as const) {
      expect(canReadProfile(v, admin)).toEqual({ allowed: true })
    }
  })

  /**
   * The rule the whole feature turns on. A peer may READ a background and may
   * never WRITE one, which is what keeps the card background rather than a place
   * evaluative opinion accumulates outside the observation record.
   */
  it('never lets a peer edit, however much they can see', () => {
    expect(canEditProfile({ isSelf: false, isAdmin: false, sharesWorkshop: true })).toBe(false)
    expect(canEditProfile({ isSelf: true, isAdmin: false, sharesWorkshop: false })).toBe(true)
    expect(canEditProfile({ isSelf: false, isAdmin: true, sharesWorkshop: true })).toBe(true)
  })

  it('defaults a new profile to workshop-visible, which is Joshua`s call and not the spec`s', () => {
    expect(blankProfile('p1').visibility).toBe('workshop')
  })
})

describe('viewerFor', () => {
  it('is an admin only where the PERSON is, not wherever the caller happens to be one', () => {
    const viewer = viewerFor({
      personId: 'p1',
      myPersonId: null,
      // The person is in w2. The caller administers w1 and is a plain evaluator in w2.
      personWorkshopIds: ['w2'],
      myRoles: roles([
        ['w1', 'chief_admin'],
        ['w2', 'evaluator'],
      ]),
    })
    expect(viewer).toEqual({ isSelf: false, isAdmin: false, sharesWorkshop: true })
  })

  it('shares no workshop when the caller belongs to none of theirs', () => {
    const viewer = viewerFor({
      personId: 'p1',
      myPersonId: null,
      personWorkshopIds: ['w2'],
      myRoles: roles([['w1', 'admin']]),
    })
    expect(viewer.sharesWorkshop).toBe(false)
    expect(viewer.isAdmin).toBe(false)
  })

  it('does not make everybody `self` when the caller has no person of their own', () => {
    expect(
      viewerFor({ personId: 'p1', myPersonId: null, personWorkshopIds: [], myRoles: roles([]) })
        .isSelf,
    ).toBe(false)
    expect(
      viewerFor({
        personId: 'p1',
        myPersonId: undefined,
        personWorkshopIds: [],
        myRoles: roles([]),
      }).isSelf,
    ).toBe(false)
  })
})

describe('track history', () => {
  /**
   * The derived half now arrives from `person_card()` rather than from local
   * participant rows, and the change was forced by the browser walkthrough: an
   * evaluator's device holds only the workshops they belong to, so deriving here
   * answered "which of their workshops can I see" and hid the Epistles row this
   * feature exists to surface. These fixtures are therefore what the SERVER sends.
   */
  const derived = [
    { label: 'Epistles 2025', year: '2025', workshopId: 'w2' },
    { label: 'Narrative 2024', year: '2024', workshopId: 'w3' },
    { label: 'Psalms 2026', year: '2026', workshopId: 'w1' },
  ]

  it('lists the other workshops and excludes the one being looked at', () => {
    const out = trackHistory({ derived, profile: null, excludeWorkshopId: 'w1' })
    expect(out.map((t) => t.label)).toEqual(['Epistles 2025', 'Narrative 2024'])
    expect(out.every((t) => t.kind === 'derived')).toBe(true)
  })

  it('marks a hand-entered training as self-reported and keeps it visibly apart', () => {
    const out = trackHistory({
      derived,
      profile: profileWith({ prior_trainings: [{ label: 'CLAT course, Nairobi', year: '2023' }] }),
      excludeWorkshopId: 'w1',
    })
    const kinds = Object.fromEntries(out.map((t) => [t.label, t.kind]))
    expect(kinds['Epistles 2025']).toBe('derived')
    expect(kinds['CLAT course, Nairobi']).toBe('self_reported')
  })

  it('sorts newest first and puts undated entries last', () => {
    const out = trackHistory({
      derived,
      profile: profileWith({
        prior_trainings: [
          { label: 'Some course', year: null },
          { label: 'Another', year: '2025' },
        ],
      }),
      excludeWorkshopId: 'w1',
    })
    expect(out.map((t) => t.label)).toEqual([
      'Epistles 2025',
      'Another',
      'Narrative 2024',
      'Some course',
    ])
  })

  it('shows nothing when the server sent nothing, rather than guessing locally', () => {
    expect(trackHistory({ derived: [], profile: null })).toEqual([])
  })
})

describe('the denial, which only the server can answer', () => {
  /**
   * This is the corrected version of the bug the walkthrough found. The client used
   * to read `visibility` off the cached profile row — a row RLS withholds by not
   * sending it — so a withheld profile defaulted to `workshop`, read as allowed,
   * and rendered "no background has been recorded" about one that had.
   */
  it('reports the state the server named', () => {
    expect(denialFromCardState('admins')).toBe('admins-only')
    expect(denialFromCardState('private')).toBe('private')
    expect(denialFromCardState('not-in-workshop')).toBe('not-in-workshop')
  })

  it('withholds nothing for a readable profile or for a person with none yet', () => {
    expect(denialFromCardState('workshop')).toBeNull()
    expect(denialFromCardState('none')).toBeNull()
  })

  it('withholds nothing when this device has never managed to ask', () => {
    // The safe direction: worst case is an empty drawer, and the server has
    // already withheld the row itself, so nothing leaks either way.
    expect(denialFromCardState(null)).toBeNull()
    expect(denialFromCardState(undefined)).toBeNull()
  })

  it('has words for every reason it can return', () => {
    for (const state of ['admins', 'private', 'not-in-workshop'] as const) {
      const reason = denialFromCardState(state)
      expect(findChromeNode(`profile.denied.${reason}`)?.label, `no copy for ${reason}`).toBeTruthy()
    }
  })
})

describe('linking, which is exact email and nothing else', () => {
  it('matches on a normalized address', () => {
    const people = [person({ id: 'p1', primary_email: 'amos@example.org' })]
    expect(personIdForEmail(people, '  AMOS@Example.ORG ')).toBe('p1')
  })

  it('returns null for a blank address rather than matching the first person with none', () => {
    const people = [person({ id: 'p1', primary_email: null })]
    expect(personIdForEmail(people, null)).toBeNull()
    expect(personIdForEmail(people, '   ')).toBeNull()
  })

  it('never matches on a name', () => {
    const people = [person({ id: 'p1', display_name: 'Amos Khokhar', primary_email: null })]
    expect(personIdForEmail(people, 'amos@example.org')).toBeNull()
  })

  it('normalizes an email the same way everywhere', () => {
    expect(normalizeEmail(' A@B.Com ')).toBe('a@b.com')
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
  })
})

describe('merge candidates', () => {
  it('flags two rows holding one address as certain, because that should not exist', () => {
    const out = mergeCandidates([
      person({ id: 'a', primary_email: 'amos@example.org' }),
      person({ id: 'b', display_name: 'A Khokhar', primary_email: 'AMOS@example.org' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('certain')
    expect(out[0].basis).toBe('email')
  })

  /**
   * The guard that stops the screen proposing every pair of siblings on a roster.
   * Two DIFFERENT addresses are positive evidence of two different people, so a
   * name match between them is not offered at all.
   */
  it('never suggests two people who hold different addresses', () => {
    expect(
      mergeCandidates([
        person({ id: 'a', display_name: 'Amos Khokhar', primary_email: 'amos@example.org' }),
        person({ id: 'b', display_name: 'Amos Khokhar', primary_email: 'amos.k@example.org' }),
      ]),
    ).toEqual([])
  })

  it('suggests a name match when at least one side has no address', () => {
    const out = mergeCandidates([
      person({ id: 'a', display_name: 'Amos Khokhar', primary_email: null }),
      person({ id: 'b', display_name: 'amos  khokhar', primary_email: 'amos@example.org' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('suggested')
    expect(out[0].basis).toBe('name')
  })

  it('suggests a surname-plus-initial match, and only ever as a suggestion', () => {
    const out = mergeCandidates([
      person({ id: 'a', display_name: 'Amos Khokhar', primary_email: null }),
      person({ id: 'b', display_name: 'A. Khokhar', primary_email: null }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('suggested')
    expect(out[0].basis).toBe('name-initial')
  })

  /**
   * The case Joshua chose the full merge flow FOR: "a name typed differently in
   * each workshop". The initial rule above does not catch a misspelling, which the
   * browser walkthrough found by trying one.
   */
  it('suggests two names one character apart', () => {
    const out = mergeCandidates([
      person({ id: 'a', display_name: 'Amos Khokhar', primary_email: null }),
      person({ id: 'b', display_name: 'Amos Kokhar', primary_email: null }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('suggested')
    expect(out[0].basis).toBe('name-typo')
  })

  it('does not suggest a one-character difference between two SHORT names', () => {
    // "Ana" and "Ann" are two people far more often than one.
    expect(
      mergeCandidates([
        person({ id: 'a', display_name: 'Ana', primary_email: null }),
        person({ id: 'b', display_name: 'Ann', primary_email: null }),
      ]),
    ).toEqual([])
  })

  it('does not suggest a one-character difference when they hold different addresses', () => {
    expect(
      mergeCandidates([
        person({ id: 'a', display_name: 'Amos Khokhar', primary_email: 'a@x.org' }),
        person({ id: 'b', display_name: 'Amos Kokhar', primary_email: 'b@x.org' }),
      ]),
    ).toEqual([])
  })

  it('measures one edit as insertion, deletion or substitution, and never zero', () => {
    expect(withinOneEdit('khokhar', 'kokhar')).toBe(true)   // deletion
    expect(withinOneEdit('kokhar', 'khokhar')).toBe(true)   // insertion
    expect(withinOneEdit('khokhar', 'khokhat')).toBe(true)  // substitution
    expect(withinOneEdit('khokhar', 'khokhar')).toBe(false) // identical is not an edit
    expect(withinOneEdit('khokhar', 'kkhar')).toBe(false)   // two apart
    expect(withinOneEdit('sitorus', 'khokhar')).toBe(false)
  })

  it('offers nothing at all when everybody is distinct', () => {
    expect(
      mergeCandidates([
        person({ id: 'a', display_name: 'Amos Khokhar', primary_email: 'a@x.org' }),
        person({ id: 'b', display_name: 'Bina Sitorus', primary_email: 'b@x.org' }),
      ]),
    ).toEqual([])
  })

  it('folds case, accents and punctuation out of a name key but keeps word order', () => {
    expect(nameKey('  Amós   O’Brien-Khokhar ')).toBe('amos o brien khokhar')
    expect(nameKey('Khokhar Amos')).not.toBe(nameKey('Amos Khokhar'))
    expect(initialKey('Amos Khokhar')).toBe('a khokhar')
    expect(initialKey('Amos')).toBeNull()
  })
})

describe('every merge basis has words', () => {
  it('so the panel never prints an id at somebody', () => {
    for (const basis of ['email', 'name', 'name-initial', 'name-typo'] as const) {
      expect(
        findChromeNode(`setup.people.merge-basis.${basis}`)?.label,
        `no copy for ${basis}`,
      ).toBeTruthy()
    }
  })
})

describe('field cleaning', () => {
  it('trims, drops blanks and de-duplicates case-insensitively, keeping order', () => {
    expect(cleanList([' CLAT ', 'clat', '', '  ', 'Ethnopoetics'])).toEqual([
      'CLAT',
      'Ethnopoetics',
    ])
  })

  it('drops a training with no label and de-duplicates on label plus year', () => {
    expect(
      cleanTrainings([
        { label: ' Epistles ', year: ' 2025 ' },
        { label: 'Epistles', year: '2025' },
        { label: 'Epistles', year: '2024' },
        { label: '  ', year: '2020' },
      ]),
    ).toEqual([
      { label: 'Epistles', year: '2025' },
      { label: 'Epistles', year: '2024' },
    ])
  })

  it('knows an untouched profile from one with something in it', () => {
    expect(isProfileEmpty(blankProfile('p1'))).toBe(true)
    expect(isProfileEmpty(null)).toBe(true)
    expect(isProfileEmpty(profileWith({ headline: '   ' }))).toBe(true)
    expect(isProfileEmpty(profileWith({ languages: ['Indonesian'] }))).toBe(false)
  })
})

/**
 * The narrowing exists so it can be tested. "An evaluator mid-observation does not
 * want a modal" is a constraint that gets lost one useful field at a time, and the
 * way it stops getting lost is that adding a field here fails a test.
 */
describe('the capture card is deliberately three things', () => {
  const p = profileWith({
    headline: 'Consultant-in-training',
    certifications: ['CBC level 2'],
    education: ['MA Linguistics'],
    notes: 'A long note nobody wants mid-observation.',
    experience_areas: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  })
  const trainings = Array.from({ length: 9 }, (_, i) => ({
    label: `T${i}`,
    kind: 'derived' as const,
  }))

  it('carries the headline, the track and the work areas, and caps both lists', () => {
    const card = captureCard(p, trainings)
    expect(card.headline).toBe('Consultant-in-training')
    expect(card.trainings).toHaveLength(4)
    expect(card.experienceAreas).toHaveLength(6)
  })

  it('carries nothing else', () => {
    expect(Object.keys(captureCard(p, trainings)).sort()).toEqual([
      'experienceAreas',
      'headline',
      'trainings',
    ])
  })

  it('reports a blank headline as absent rather than as an empty line', () => {
    expect(captureCard(profileWith({ headline: '  ' }), []).headline).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const change = (over: Partial<SetupChange>): SetupChange => ({
  entity: 'profile',
  operation: 'update',
  entityId: 'p1',
  label: 'Amos Khokhar',
  ...over,
})

describe('the classifier', () => {
  it('calls a profile edit safe, so no dialog fires on a background note', () => {
    for (const op of ['create', 'update', 'delete'] as const) {
      const impact = classifySetupChange(change({ operation: op }), 'in_progress')
      expect(impact.severity).toBe('safe')
      expect(impact.silent).toBe(true)
    }
  })

  it('calls a merge destructive and demands the name typed', () => {
    const impact = classifySetupChange(
      change({
        entity: 'person_merge',
        label: 'Amos Kokhar → Amos Khokhar',
        counts: { participants: 2, observations: 31, reports: 2 },
      }),
      'in_progress',
    )
    expect(impact.severity).toBe('destructive')
    expect(impact.requiresTypedName).toBe(true)
  })

  /**
   * The sharp case. A merge is an `update`, so without the exemption in
   * `applyState` the draft-workshop discount would not merely soften it — it would
   * return `safe` and the dialog would not appear at all.
   */
  it('does not discount a merge in a draft workshop', () => {
    const impact = classifySetupChange(
      change({ entity: 'person_merge', counts: { observations: 0 } }),
      'draft',
    )
    expect(impact.severity).toBe('destructive')
    expect(impact.silent).toBe(false)
  })

  it('never tells an administrator that a merge deletes evidence, because it does not', () => {
    const impact = classifySetupChange(
      change({ entity: 'person_merge', counts: { participants: 2, observations: 31, reports: 2 } }),
      'in_progress',
    )
    const text = impact.consequences
      .map((con) => findChromeNode(con.id)?.label ?? '')
      .join(' ')
      .toLowerCase()
    expect(text).toContain('no evidence moves or disappears')
    expect(text).not.toMatch(/delete[sd]? .*(observation|evidence)/)
  })

  it('gives every consequence it can emit actual words, with every token filled', () => {
    const impact = classifySetupChange(
      change({ entity: 'person_merge', counts: { participants: 2, observations: 31, reports: 2 } }),
      'in_progress',
    )
    expect(impact.consequences.length).toBeGreaterThan(0)
    for (const con of impact.consequences) {
      const node = findChromeNode(con.id)
      expect(node?.label, `missing chrome node ${con.id}`).toBeTruthy()
      const filled = (node?.label ?? '').replace(/\{(\w+)\}/g, (whole, key: string) =>
        con.tokens && key in con.tokens ? String(con.tokens[key]) : whole,
      )
      expect(filled, `unfilled token in ${con.id}`).not.toMatch(/\{\w+\}/)
    }
  })
})

// ---------------------------------------------------------------------------

/**
 * The mirror check.
 *
 * `canReadProfile` exists so the drawer can print a reason instead of a blank
 * card, which means the same rule is now written twice. These read the policy out
 * of the migration and assert the client copy agrees on the shape: not a proof of
 * equivalence, but enough that dropping a clause from either side fails here
 * rather than in the field.
 */
describe('the client mirror agrees with the policy it mirrors', () => {
  const selectPolicy = /create policy person_profile_select[\s\S]*?;/.exec(MIGRATION)?.[0] ?? ''

  it('found the policy at all', () => {
    expect(selectPolicy).toContain('using')
  })

  it('names self, admin, creator and the workshop case, and nothing else', () => {
    expect(selectPolicy).toContain('is_my_person(person_id)')
    expect(selectPolicy).toContain('person_is_administered_by_me(person_id)')
    expect(selectPolicy).toContain('i_created_person(person_id)')
    expect(selectPolicy).toContain("visibility = 'workshop' and person_shares_workshop(person_id)")
    // No `admins` or `private` clause on the read side: those two are covered by
    // the admin and self branches. If one ever appears, the client mirror is wrong.
    expect(selectPolicy).not.toContain("visibility = 'admins' and")
    expect(selectPolicy).not.toContain("visibility = 'private' and")
  })

  it('permits exactly the three visibility values the client offers', () => {
    expect(MIGRATION).toContain("check (visibility in ('workshop', 'admins', 'private'))")
  })

  it('keeps the write side narrower than the read side: no bare workshop clause', () => {
    const write = /create policy person_profile_(insert|update)[\s\S]*?;/g
    for (const m of MIGRATION.matchAll(write)) {
      expect(m[0]).not.toContain('person_shares_workshop')
    }
  })

  /**
   * Joshua dropped the consent flag on 2026-08-01. This is a tripwire rather than
   * an opinion: if a later spec reintroduces it, the client's `canReadProfile` will
   * not know about it and would report a withheld profile as readable, which is the
   * one direction this mirror must never be wrong in.
   */
  it('has no consent column, per Joshua`s 2026-08-01 decision', () => {
    expect(SCHEMA).not.toMatch(/consent_given/)
    expect(SCHEMA).not.toMatch(/consent_at/)
  })
})

describe('the merge RPC`s contract, as the SQL states it', () => {
  it('requires the caller to administer a workshop for BOTH people', () => {
    expect(MIGRATION).toContain(
      'if not (person_is_administered_by_me(_survivor_id) and person_is_administered_by_me(_absorbed_id))',
    )
  })

  it('repoints participants rather than deleting them, so no evidence moves', () => {
    expect(MIGRATION).toContain('update participant set person_id = _survivor_id')
    expect(MIGRATION).not.toMatch(/delete\s+from\s+participant/i)
    expect(MIGRATION).not.toMatch(/delete\s+from\s+observation/i)
  })

  it('narrows visibility on a merge rather than widening it', () => {
    expect(MIGRATION).toContain('narrower_visibility(_sp.visibility, _ap.visibility)')
  })

  it('raises its refusals with the shared helper, so they carry a tl12 slug', () => {
    const slugs = [...MIGRATION.matchAll(/raise_refusal\('([a-z0-9._]+)'/g)].map((m) => m[1])
    expect(slugs.length).toBeGreaterThan(0)
    for (const slug of slugs) {
      expect(slug).toMatch(/^tl12\./)
      // The slug is only useful if the browser has words for it.
      expect(findChromeNode(`refusal.${slug}`)?.label, `no copy for ${slug}`).toBeTruthy()
    }
  })
})

describe('the schema this device expects', () => {
  it('links participants and accounts with a nullable person_id, never a cascade delete', () => {
    expect(MIGRATION).toContain(
      'alter table participant add column if not exists person_id uuid references person (id) on delete set null',
    )
    expect(MIGRATION).toContain(
      'alter table app_user    add column if not exists person_id uuid references person (id) on delete set null',
    )
  })

  it('links a new account server-side, since app_user has no client write path', () => {
    expect(MIGRATION).toContain('create trigger app_user_link_person_trigger')
    expect(MIGRATION).toContain('after insert on app_user')
  })

  it('answers the two questions the client cannot answer for itself', () => {
    // Both were found in a browser, not by reading, and both exist because RLS
    // filters rather than refuses. See the migration's section 6b.
    expect(MIGRATION).toContain('create or replace function person_card(_person_id uuid)')
    expect(MIGRATION).toContain("'state', 'not-in-workshop'")
    // A withheld profile must not leak its owner's track history through the card.
    expect(MIGRATION).toContain('if _readable then')
  })

  it('bumped the backup schema, so a v1 file cannot arrive silently without profiles', () => {
    expect(BACKUP_SCHEMA_ID).toBe('cairn.backup/v2')
  })
})
