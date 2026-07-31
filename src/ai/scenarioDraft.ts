import { db, newId } from '../db/local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { upsertActivity, upsertGoal, upsertKsa, setActivityKsas } from '../db/referenceWrite'
import { nextGoalCode } from '../lib/goals'
import type { Activity, Goal, Ksa } from '../lib/types'
import {
  SCENARIO_RULES,
  SCENARIO_SCHEMA,
  validateScenarioDraft,
  type ScenarioDraft,
} from './scenarioContract'

/**
 * Whether the one-click AI path is available. It runs through the Supabase Edge
 * Function `draft-scenario` (which holds the Gemini key server-side), so it needs
 * Supabase configured. The copy/paste path always works, with no backend.
 */
export const canDraftWithAI = isSupabaseConfigured

/** The self-contained prompt for the copy/paste path: rules + schema + document. */
export function buildScenarioPrompt(documentText: string): string {
  return `${SCENARIO_RULES}

Output must validate against this JSON schema:
${JSON.stringify(SCENARIO_SCHEMA, null, 2)}

--- BEGIN SOURCE DOCUMENT ---
${documentText}
--- END SOURCE DOCUMENT ---

Return only the JSON object.`
}

/** Tolerantly pull a JSON object out of a model reply (strips prose / code fences). */
export function parseDraftReply(text: string): { ok: true; value: ScenarioDraft } | { ok: false; reason: string } {
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'Could not parse JSON from the reply.' }
  }
  return validateScenarioDraft(parsed)
}

/**
 * Call the draft-scenario Edge Function (Gemini free tier, server-side key). Returns
 * a validated draft or a human-readable reason. Never throws.
 */
export async function draftScenarioWithAI(
  documentText: string,
): Promise<{ ok: true; value: ScenarioDraft } | { ok: false; reason: string }> {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, reason: 'AI drafting needs the backend; use the copy/paste path instead.' }
  }
  try {
    const { data, error } = await supabase.functions.invoke('draft-scenario', {
      body: { document: documentText },
    })
    if (error) return { ok: false, reason: error.message }
    // The function returns { scenario } (parsed), { raw } (unparsed text), or { error }.
    if (data && typeof data === 'object') {
      if ('error' in data) return { ok: false, reason: String((data as { error: unknown }).error) }
      if ('scenario' in data) return validateScenarioDraft((data as { scenario: unknown }).scenario)
      if ('raw' in data) return parseDraftReply(String((data as { raw: unknown }).raw))
    }
    if (typeof data === 'string') return parseDraftReply(data)
    return validateScenarioDraft(data)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'AI request failed.' }
  }
}

/**
 * Ensure a question code is unique IN THIS WORKSHOP (suffix on collision).
 *
 * Workshop-scoped as of tl-08. It used to check the whole `ksa` table, which was
 * right while codes were globally unique and is now needlessly destructive: it
 * would suffix a perfectly legal `Q1` because a different organization's workshop
 * already had one.
 */
async function uniqueCode(base: string, workshopId: string): Promise<string> {
  const taken = new Set(
    (await db.ksas.where('workshop_id').equals(workshopId).toArray()).map((k) => k.code),
  )
  const code = base.trim() || 'Q'
  if (!taken.has(code)) return code
  for (let i = 2; i < 1000; i++) {
    const candidate = `${code}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${code}-${newId().slice(0, 6)}`
}

/**
 * Turn the draft's free-text `area` strings into real goals in this workshop,
 * reusing a goal that already carries the same title.
 *
 * The draft schema still speaks of an "area" because that is what a model is good
 * at producing from a course outline: a heading, as a string. tl-08's change is
 * that the string lands as a `goal` row rather than as a column on each question,
 * so an administrator can then rename it once instead of on every question.
 */
async function goalIdsForDraft(
  areas: string[],
  workshopId: string,
): Promise<Map<string, string>> {
  const existing = await db.goals.where('workshop_id').equals(workshopId).toArray()
  const byTitle = new Map(existing.map((g) => [g.title.trim(), g.id]))
  const out = new Map<string, string>()
  let created = existing.length
  for (const raw of areas) {
    const title = raw.trim()
    if (!title) continue
    const found = byTitle.get(title)
    if (found) {
      out.set(title, found)
      continue
    }
    const goal: Goal = {
      id: newId(),
      workshop_id: workshopId,
      code: nextGoalCode(existing),
      title,
      description: null,
      sort_order: created++,
    }
    await upsertGoal(goal)
    existing.push(goal)
    byTitle.set(title, goal.id)
    out.set(title, goal.id)
  }
  return out
}

/**
 * Land a validated draft into a scenario as EDITABLE rows the author then reviews
 * in the Builder. Creates new activities (fresh ids), creates new KSAs (unique
 * codes so shared/global questions are never clobbered), and wires them. Returns
 * counts. Does not delete or overwrite anything already in the scenario.
 */
export async function importScenarioDraft(
  draft: ScenarioDraft,
  workshopId: string,
): Promise<{ activities: number; ksas: number; wired: number }> {
  // Create KSAs, mapping the draft code -> the (possibly suffixed) new KSA.
  const goalIds = await goalIdsForDraft(
    draft.ksas.map((dk) => dk.area ?? ''),
    workshopId,
  )
  const codeToKsaId = new Map<string, string>()
  let ksaCount = 0
  for (const dk of draft.ksas) {
    const code = await uniqueCode(dk.code, workshopId)
    const k: Ksa = {
      id: newId(),
      workshop_id: workshopId,
      code,
      goal_id: goalIds.get((dk.area ?? '').trim()) ?? null,
      short_label: dk.short_label,
      description: dk.description ?? '',
      evaluator_facing_prompt: dk.evaluator_facing_prompt,
      ai_facing_rubric: null,
      evidence_levels: dk.evidence_levels ?? { '0': '', '1': '', '2': '', '3': '' },
      cbc_subpoint_refs: [],
      guiding_questions: dk.guiding_questions ?? [],
    }
    await upsertKsa(k)
    codeToKsaId.set(dk.code, k.id)
    ksaCount++
  }

  // Create activities, mapping the draft title -> the new activity.
  const existingCount = await db.activities.where('workshop_id').equals(workshopId).count()
  const titleToActivityId = new Map<string, string>()
  let actCount = 0
  draft.activities.forEach(() => actCount++)
  const sorted = [...draft.activities].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  for (let i = 0; i < sorted.length; i++) {
    const da = sorted[i]
    const a: Activity = {
      id: newId(),
      workshop_id: workshopId,
      title: da.title,
      day: null,
      start_time: null,
      end_time: null,
      sort_order: existingCount + i,
      genre_group: da.genre_group ?? null,
    }
    await upsertActivity(a)
    titleToActivityId.set(da.title, a.id)
  }

  // Wire questions onto events.
  let wired = 0
  for (const w of draft.wiring) {
    const activityId = titleToActivityId.get(w.activity_title)
    if (!activityId) continue
    const ksaIds = w.ksa_codes.map((c) => codeToKsaId.get(c)).filter((id): id is string => Boolean(id))
    if (ksaIds.length) {
      await setActivityKsas(activityId, ksaIds)
      wired += ksaIds.length
    }
  }

  return { activities: actCount, ksas: ksaCount, wired }
}
