import { describe, it, expect } from 'vitest'
import { planGoalBackfill } from '../src/db/goalBackfill'
import { KSA_AREAS } from '../src/lib/types'

/**
 * The on-device half of tl-08's backfill.
 *
 * Tested because it is the code path a device takes when it upgrades BEFORE it next
 * syncs, which is the path nobody exercises by hand: the developer's browser has a
 * network, so it pulls the server's already-backfilled rows and never runs this at
 * all. A field phone opened on a plane runs exactly this and nothing else.
 *
 * The rules are asserted to match the migration's, because two backfills that
 * disagree produce two devices that group the same evidence differently.
 */

const workshops = [
  { id: 'w-bali', name: 'Psalms (Bali 2026)', start_date: '2026-08-24' },
  { id: 'w-crash', name: 'OBT Crash Course', start_date: '2026-11-01' },
]

const activities = [
  { id: 'a-bali-1', workshop_id: 'w-bali', sort_order: 1 },
  { id: 'a-bali-2', workshop_id: 'w-bali', sort_order: 2 },
  { id: 'a-crash-1', workshop_id: 'w-crash', sort_order: 1 },
]

describe('planGoalBackfill', () => {
  it('assigns a question to the workshop its wiring already points at', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: 'Genre Theory, Discovery, and Matching' }],
      links: [{ activity_id: 'a-crash-1', ksa_id: 'k-1' }],
      activities,
      workshops,
      activeWorkshopId: 'w-bali',
    })
    // Wiring beats the active workshop: it is a fact in the data rather than a
    // property of whichever workshop this device happened to have selected.
    expect(plan.assignments.get('k-1')?.workshop_id).toBe('w-crash')
    expect(plan.unplaced).toEqual([])
  })

  it('falls an unwired question to the earliest workshop', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: 'Checking Artistic Translations' }],
      links: [],
      activities,
      workshops,
      activeWorkshopId: 'w-crash',
    })
    expect(plan.assignments.get('k-1')?.workshop_id).toBe('w-bali')
  })

  it('breaks a cross-workshop tie on link count, then on the earliest event', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: 'Checking Artistic Translations' }],
      links: [
        { activity_id: 'a-bali-1', ksa_id: 'k-1' },
        { activity_id: 'a-bali-2', ksa_id: 'k-1' },
        { activity_id: 'a-crash-1', ksa_id: 'k-1' },
      ],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    expect(plan.assignments.get('k-1')?.workshop_id).toBe('w-bali')
    // Reported rather than silently resolved: the backend clones such a question,
    // and the device says so in the console instead of losing the fact.
    expect(plan.crossWorkshop).toEqual(['k-1'])
  })

  it('reports a question it cannot place instead of inventing a home', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: 'Checking Artistic Translations' }],
      links: [],
      activities: [],
      workshops: [],
      activeWorkshopId: null,
    })
    expect(plan.unplaced).toEqual(['k-1'])
    expect(plan.assignments.size).toBe(0)
    expect(plan.goals).toEqual([])
  })

  it('leaves an already-scoped question alone', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: 'Checking Artistic Translations', workshop_id: 'w-crash' }],
      links: [{ activity_id: 'a-bali-1', ksa_id: 'k-1' }],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    // Idempotence: a second upgrade must not re-decide what the first one settled.
    expect(plan.assignments.get('k-1')?.workshop_id).toBe('w-crash')
  })

  it('creates one goal per distinct area per workshop, in the legacy Psalms order', () => {
    const plan = planGoalBackfill({
      ksas: [
        // Deliberately out of order, and with a duplicate area.
        { id: 'k-1', code: 'Q1', area: KSA_AREAS[3] },
        { id: 'k-2', code: 'Q2', area: KSA_AREAS[0] },
        { id: 'k-3', code: 'Q3', area: KSA_AREAS[0] },
        { id: 'k-4', code: 'Q4', area: 'Something a different organization wrote' },
      ],
      links: [],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    const bali = plan.goals.filter((g) => g.workshop_id === 'w-bali')
    expect(bali.map((g) => g.title)).toEqual([
      KSA_AREAS[0],
      KSA_AREAS[3],
      // An unrecognized heading sorts after the six, alphabetically among its peers.
      'Something a different organization wrote',
    ])
    expect(bali.map((g) => g.code)).toEqual(['G1', 'G2', 'G3'])
    expect(bali.map((g) => g.sort_order)).toEqual([0, 1, 2])
    // The duplicate area produced one goal, and both questions point at it.
    expect(plan.assignments.get('k-2')?.goal_id).toBe(plan.assignments.get('k-3')?.goal_id)
    expect(plan.assignments.get('k-1')?.goal_id).not.toBe(plan.assignments.get('k-2')?.goal_id)
  })

  it('keeps two workshops’ goals separate even when the titles match', () => {
    const plan = planGoalBackfill({
      ksas: [
        { id: 'k-1', code: 'Q1', area: KSA_AREAS[0], workshop_id: 'w-bali' },
        { id: 'k-2', code: 'Q1', area: KSA_AREAS[0], workshop_id: 'w-crash' },
      ],
      links: [],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    // Both hold a Q1 and both hold a G1, and they are different rows. That is the
    // whole point of the spec, asserted on the device side of it.
    expect(plan.goals).toHaveLength(2)
    expect(plan.assignments.get('k-1')?.goal_id).not.toBe(plan.assignments.get('k-2')?.goal_id)
  })

  it('leaves goal_id null for a question with no area at all', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: '   ' }],
      links: [],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    expect(plan.goals).toEqual([])
    expect(plan.assignments.get('k-1')).toEqual({ workshop_id: 'w-bali', goal_id: null })
  })

  it('produces local goal ids that cannot be mistaken for server rows', () => {
    const plan = planGoalBackfill({
      ksas: [{ id: 'k-1', code: 'Q1', area: KSA_AREAS[1] }],
      links: [],
      activities,
      workshops,
      activeWorkshopId: null,
    })
    // Deterministic and obviously local, so a stray one showing up in Postgres would
    // be recognizable rather than looking like a uuid somebody meant.
    expect(plan.goals[0].id).toBe('local-goal:w-bali:1')
  })
})
