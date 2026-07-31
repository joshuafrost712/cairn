import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { withGoalTitles, type ResolvedKsa } from '../lib/goals'
import type { Goal, Ksa } from '../lib/types'

/**
 * The cached questions with their goal titles resolved (tl-08).
 *
 * One hook rather than a `db.ksas.toArray()` in each of six pages, because the
 * group heading a report prints now comes from a JOIN, and a join written six times
 * is a join that will be written differently in one of them. The reports layer takes
 * `ResolvedKsa[]`, so a page that forgets to resolve fails to compile instead of
 * quietly printing "Ungrouped" against every question.
 *
 * DELIBERATELY NOT WORKSHOP-SCOPED. Every page using this reads participants, teams
 * and observations across the whole cache too, and narrowing one table of the six
 * would produce a report whose questions and whose people came from different
 * scopes. Scoping the report surfaces belongs with the workshop switcher (tl-17),
 * which is where a page learns which workshop it is showing. The authoring surfaces
 * that tl-08 owns — Setup's goals, questions and wiring — ARE scoped, because that
 * is where a cross-workshop edit does damage.
 */
export function useResolvedKsas(): ResolvedKsa[] {
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const goals = useLiveQuery(() => db.goals.toArray(), [], [] as Goal[])
  return withGoalTitles(ksas ?? [], goals ?? [])
}