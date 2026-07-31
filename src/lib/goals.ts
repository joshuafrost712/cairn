/**
 * Goals and per-event prompt resolution (tl-08).
 *
 * Pure. No IO, no Dexie, no React — the same contract impact.ts holds, and for the
 * same reason: these are the two decisions in the app that are easy to get subtly
 * wrong and impossible to eyeball afterwards.
 *
 * TWO RESOLUTIONS LIVE HERE, AND NOWHERE ELSE.
 *
 *  1. **A question's group label** comes from its goal, not from a string on the
 *     question. Before tl-08, `ksa.area` was free text checked against a hardcoded
 *     list of the six Psalms competency areas, and every report grouped on it. So
 *     the display was load-bearing on a field nothing validated. Now the goal owns
 *     the title and `withGoalTitles()` stamps it onto each question as
 *     `goal_title`, which is the ONLY field the reports, the AI layer and the
 *     admin tables are allowed to group or sort on.
 *
 *  2. **A question's wording on a particular event** comes from the wiring row's
 *     override where it has one, and from the question otherwise.
 *     `resolveForActivity()` is the single site. The spec says why: a second
 *     resolution site is how the capture screen, the Setup preview and the routing
 *     capture file come to show an evaluator three different questions, and only
 *     one of them is the one their answer will be read against.
 *
 * THE RULE A FUTURE EDITOR WILL VIOLATE: do not add `?? ksa.area` as a fallback
 * anywhere. A question with no goal is genuinely ungrouped, and saying so is
 * useful; quietly reviving the legacy column would resurrect the disagreement this
 * spec exists to end.
 */

import type { ActivityKsa, Goal, Ksa } from './types'

/** What the level above a question is called when a workshop has not renamed it. */
export const GOAL_LABEL_DEFAULT = 'Goal'

/**
 * What the reports print for a question whose `goal_id` is null.
 *
 * A visible word rather than an empty cell, because a question that groups
 * nowhere is a setup gap an administrator can fix, and an empty heading reads as
 * a rendering bug.
 */
export const UNGROUPED_TITLE = 'Ungrouped'

/** A question with its goal's title resolved. The shape every consumer takes. */
export interface ResolvedKsa extends Ksa {
  /** The goal's title, or UNGROUPED_TITLE. Never blank, never the legacy `area`. */
  goal_title: string
  /** The goal's position in the workshop, for stable grouping. Ungrouped sorts last. */
  goal_sort: number
}

/** Sort order for ungrouped questions: after every real goal, whatever its index. */
const UNGROUPED_SORT = Number.MAX_SAFE_INTEGER

/** What this workshop calls a goal. Blank or absent falls to the app default. */
export function goalLabel(workshop: { goal_label?: string | null } | null | undefined): string {
  const raw = workshop?.goal_label
  return raw && raw.trim() ? raw.trim() : GOAL_LABEL_DEFAULT
}

/**
 * Stamp each question with its goal's title and position.
 *
 * Takes the goals as a list rather than a map so callers cannot half-build the
 * index; the map is an implementation detail of this function.
 */
export function withGoalTitles(ksas: Ksa[], goals: Goal[]): ResolvedKsa[] {
  const byId = new Map(goals.map((g) => [g.id, g]))
  return ksas.map((k) => {
    const goal = k.goal_id ? byId.get(k.goal_id) : undefined
    return {
      ...k,
      goal_title: goal?.title?.trim() ? goal.title.trim() : UNGROUPED_TITLE,
      goal_sort: goal ? goal.sort_order : UNGROUPED_SORT,
    }
  })
}

/**
 * Questions grouped under their goals, in the order an administrator arranged
 * them: goals by `sort_order`, questions by `code` inside a goal, ungrouped last.
 *
 * Returns a group for every goal INCLUDING empty ones. An empty goal is a real
 * state somebody just created and is about to fill, and dropping it from the list
 * would make the question editor forget the goal exists the moment its last
 * question moves away.
 */
export interface GoalGroup {
  goal: Goal | null
  ksas: ResolvedKsa[]
}

export function groupByGoal(ksas: Ksa[], goals: Goal[]): GoalGroup[] {
  const resolved = withGoalTitles(ksas, goals)
  const ordered = [...goals].sort(
    (a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code),
  )
  const byCode = (a: Ksa, b: Ksa) => a.code.localeCompare(b.code, undefined, { numeric: true })

  const groups: GoalGroup[] = ordered.map((goal) => ({
    goal,
    ksas: resolved.filter((k) => k.goal_id === goal.id).sort(byCode),
  }))

  const known = new Set(goals.map((g) => g.id))
  const orphans = resolved.filter((k) => !k.goal_id || !known.has(k.goal_id)).sort(byCode)
  if (orphans.length > 0) groups.push({ goal: null, ksas: orphans })
  return groups
}

/** The next free `G<n>` code in a workshop, so adding a goal needs no typing. */
export function nextGoalCode(goals: Goal[]): string {
  const used = new Set(goals.map((g) => g.code.trim().toUpperCase()))
  for (let i = 1; i <= used.size + 1; i++) {
    const candidate = `G${i}`
    if (!used.has(candidate)) return candidate
  }
  return `G${used.size + 1}`
}

/** The next free question code in a workshop. Scoped, because codes are now per-workshop. */
export function nextQuestionCode(ksas: Ksa[]): string {
  const used = new Set(ksas.map((k) => k.code.trim().toUpperCase()))
  for (let i = 1; i <= used.size + 1; i++) {
    const candidate = `Q${i}`
    if (!used.has(candidate)) return candidate
  }
  return `Q${used.size + 1}`
}

/**
 * The wiring fields that carry a per-event override, so a caller can neither miss
 * one nor invent one.
 */
export type OverrideField = 'prompt_override' | 'guiding_questions_override'

export const OVERRIDE_FIELDS: OverrideField[] = ['prompt_override', 'guiding_questions_override']

/** Whether a wiring row overrides anything at all. Drives the "overridden" badge. */
export function hasOverride(link: Pick<ActivityKsa, OverrideField>): boolean {
  return OVERRIDE_FIELDS.some((f) => isOverridden(link[f]))
}

/**
 * Whether one override value is set.
 *
 * An empty STRING is not an override — clearing the box means "fall back", which
 * is the only behaviour that lets an admin undo an override without a second
 * control. An empty ARRAY is: "show no guiding questions on this event" is a real
 * instruction and differs from "show the question's own".
 */
function isOverridden(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return Array.isArray(value)
}

/**
 * A question as it should appear on one event.
 *
 * The returned object is a question, not a question-plus-override, on purpose:
 * every consumer downstream reads `evaluator_facing_prompt` and
 * `guiding_questions` and must not have to know an override exists. `overridden`
 * rides along for the one surface that does care — the Setup editor, which shows
 * an admin that this event's wording is not the question's own.
 */
export interface ActivityKsaResolved extends ResolvedKsa {
  sort_order: number
  overridden: boolean
}

export function resolveForActivity(
  ksa: ResolvedKsa,
  link: Pick<ActivityKsa, 'sort_order' | OverrideField>,
): ActivityKsaResolved {
  const promptOverridden = isOverridden(link.prompt_override)
  const guidingOverridden = isOverridden(link.guiding_questions_override)
  return {
    ...ksa,
    evaluator_facing_prompt: promptOverridden
      ? (link.prompt_override as string)
      : ksa.evaluator_facing_prompt,
    guiding_questions: guidingOverridden
      ? (link.guiding_questions_override as string[])
      : ksa.guiding_questions,
    sort_order: link.sort_order,
    overridden: promptOverridden || guidingOverridden,
  }
}

/**
 * Normalize what a form produced into what is stored.
 *
 * Blank string -> null, so clearing the field falls back with no residue (the
 * spec's acceptance criterion, and the reason a stored empty string would be a
 * bug: it would render as a question with no prompt at all).
 */
export function normalizeOverride(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Same, for the guiding-questions array. Null when the admin has cleared it entirely. */
export function normalizeGuidingOverride(
  lines: string[] | null | undefined,
): string[] | null {
  if (lines == null) return null
  const cleaned = lines.map((l) => l.trim()).filter(Boolean)
  // An admin who deletes every line has said "none on this event", which is an
  // override; one who never opened the field has said nothing, which is null. The
  // caller distinguishes them by passing null for the latter.
  return cleaned
}
