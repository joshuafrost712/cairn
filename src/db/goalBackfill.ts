/**
 * The on-device half of tl-08's backfill.
 *
 * Pure and unit-tested, following the shape tl-04 established with
 * `planBackfill`: the Dexie upgrade function is plumbing, and every decision it
 * applies is computed here where it can be tested without an IndexedDB.
 *
 * WHY A LOCAL BACKFILL AT ALL, when the migration already did this server-side.
 * Because a device that upgrades before it next syncs would otherwise hold
 * questions with no `workshop_id` and no `goal_id`: the workshop-scoped question
 * list would come back empty and every report grouping would read "Ungrouped".
 * The capture screen would still work (it resolves through the wiring, not the
 * scope), which is precisely what makes the failure quiet.
 *
 * The rules match the migration's on purpose, so a device that backfills locally
 * and a device that pulls from the server land on the same grouping:
 *
 *   1. A question belongs to the workshop its WIRING points at — the workshop
 *      holding the most `activity_ksa` rows for it, ties broken on the earliest
 *      event. That is a fact in the data, not a guess.
 *   2. A question wired nowhere falls to the earliest workshop, then to the
 *      active one.
 *   3. One goal per distinct `area` string per workshop, ordered by the six
 *      Psalms areas where the string matches and alphabetically after that.
 *
 * Two differences from the migration, both deliberate:
 *
 *   * **Goal ids are local and deterministic** (`local-goal:<workshop>:<n>`),
 *     not uuids. They exist to keep this device coherent until its next pull,
 *     which clears and replaces the goal cache with the server's rows. They are
 *     NEVER enqueued to the reference outbox: pushing a locally-invented goal
 *     would create a second goal for the same area on the backend.
 *   * **No cloning of a question wired across two workshops.** The migration
 *     clones and repoints; doing that locally would invent ids that then collide
 *     conceptually with the server's clones. The device assigns such a question
 *     to its primary workshop and waits for the pull, which is a display gap for
 *     one sync cycle rather than a fabricated row.
 */

import { KSA_AREAS } from '../lib/types'

/** Only the fields the plan needs, so a test does not have to build whole entities. */
export interface BackfillKsa {
  id: string
  code: string
  area?: string | null
  workshop_id?: string | null
  goal_id?: string | null
}

export interface BackfillLink {
  activity_id: string
  ksa_id: string
}

export interface BackfillActivity {
  id: string
  workshop_id: string
  sort_order: number
}

export interface BackfillWorkshop {
  id: string
  name: string
  start_date?: string | null
}

export interface PlannedGoal {
  id: string
  workshop_id: string
  code: string
  title: string
  sort_order: number
}

export interface GoalBackfillPlan {
  /** Goal rows to write into the local cache. */
  goals: PlannedGoal[]
  /** ksa id -> the workshop and goal it now belongs to. */
  assignments: Map<string, { workshop_id: string; goal_id: string | null }>
  /**
   * Questions that could not be placed in any workshop: no wiring, and no
   * workshop on the device at all. They stay unscoped and invisible to the
   * question list until the next pull, which is the honest outcome rather than
   * attaching them somewhere arbitrary.
   */
  unplaced: string[]
  /**
   * Questions wired into more than one workshop. The migration clones these; the
   * device assigns each to its primary workshop and reports the rest here so the
   * upgrade can say so in the console rather than losing the fact silently.
   */
  crossWorkshop: string[]
}

/** Where a title sits in the legacy Psalms ordering. Unmatched titles sort after. */
function areaOrdinal(title: string): number {
  const i = (KSA_AREAS as readonly string[]).indexOf(title)
  return i === -1 ? 999 : i
}

export function planGoalBackfill(input: {
  ksas: BackfillKsa[]
  links: BackfillLink[]
  activities: BackfillActivity[]
  workshops: BackfillWorkshop[]
  activeWorkshopId: string | null
}): GoalBackfillPlan {
  const { ksas, links, activities, workshops, activeWorkshopId } = input

  const activityById = new Map(activities.map((a) => [a.id, a]))

  // Earliest workshop, by the same rule the migration uses: start_date ascending
  // with nulls last, then name. Deterministic, and independent of row order.
  const ordered = [...workshops].sort((a, b) => {
    const as = a.start_date ?? null
    const bs = b.start_date ?? null
    if (as !== bs) {
      if (as == null) return 1
      if (bs == null) return -1
      return as.localeCompare(bs)
    }
    return a.name.localeCompare(b.name)
  })
  const fallback =
    ordered[0]?.id ??
    (activeWorkshopId && workshops.some((w) => w.id === activeWorkshopId) ? activeWorkshopId : null) ??
    activeWorkshopId

  // How many links each question has into each workshop, and the earliest event
  // in that workshop holding it, for the tie-break.
  const tally = new Map<string, Map<string, { count: number; minSort: number }>>()
  for (const link of links) {
    const activity = activityById.get(link.activity_id)
    if (!activity) continue
    const perWorkshop = tally.get(link.ksa_id) ?? new Map()
    const entry = perWorkshop.get(activity.workshop_id) ?? { count: 0, minSort: Infinity }
    entry.count++
    entry.minSort = Math.min(entry.minSort, activity.sort_order)
    perWorkshop.set(activity.workshop_id, entry)
    tally.set(link.ksa_id, perWorkshop)
  }

  const assignments = new Map<string, { workshop_id: string; goal_id: string | null }>()
  const unplaced: string[] = []
  const crossWorkshop: string[] = []
  // workshop id -> the titles it needs goals for, in first-seen order.
  const titlesByWorkshop = new Map<string, Set<string>>()

  for (const k of ksas) {
    const perWorkshop = tally.get(k.id)
    let workshopId: string | null = k.workshop_id ?? null
    if (!workshopId && perWorkshop && perWorkshop.size > 0) {
      const ranked = [...perWorkshop.entries()].sort(
        (a, b) => b[1].count - a[1].count || a[1].minSort - b[1].minSort || a[0].localeCompare(b[0]),
      )
      workshopId = ranked[0][0]
      if (perWorkshop.size > 1) crossWorkshop.push(k.id)
    }
    if (!workshopId) workshopId = fallback
    if (!workshopId) {
      unplaced.push(k.id)
      continue
    }

    const title = (k.area ?? '').trim()
    if (title) {
      const set = titlesByWorkshop.get(workshopId) ?? new Set<string>()
      set.add(title)
      titlesByWorkshop.set(workshopId, set)
    }
    // goal_id is filled in below, once every workshop's goals have codes.
    assignments.set(k.id, { workshop_id: workshopId, goal_id: null })
  }

  const goals: PlannedGoal[] = []
  const goalIdByWorkshopTitle = new Map<string, string>()
  for (const [workshopId, titles] of titlesByWorkshop) {
    const sorted = [...titles].sort(
      (a, b) => areaOrdinal(a) - areaOrdinal(b) || a.localeCompare(b),
    )
    sorted.forEach((title, i) => {
      const id = `local-goal:${workshopId}:${i + 1}`
      goals.push({ id, workshop_id: workshopId, code: `G${i + 1}`, title, sort_order: i })
      goalIdByWorkshopTitle.set(`${workshopId}::${title}`, id)
    })
  }

  for (const k of ksas) {
    const assignment = assignments.get(k.id)
    if (!assignment) continue
    const title = (k.area ?? '').trim()
    if (!title) continue
    assignment.goal_id = goalIdByWorkshopTitle.get(`${assignment.workshop_id}::${title}`) ?? null
  }

  return { goals, assignments, unplaced, crossWorkshop }
}
