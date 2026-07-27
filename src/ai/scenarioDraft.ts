import { db, newId } from '../db/local'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { upsertActivity, upsertKsa, setActivityKsas } from '../db/referenceWrite'
import type { Activity, Ksa } from '../lib/types'
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

/** Ensure a KSA code is unique in the current library (suffix on collision). */
async function uniqueCode(base: string): Promise<string> {
  const code = base.trim() || 'Q'
  const existing = await db.ksas.where('code').equals(code).first()
  if (!existing) return code
  for (let i = 2; i < 1000; i++) {
    const candidate = `${code}-${i}`
    if (!(await db.ksas.where('code').equals(candidate).first())) return candidate
  }
  return `${code}-${newId().slice(0, 6)}`
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
  const codeToKsaId = new Map<string, string>()
  let ksaCount = 0
  for (const dk of draft.ksas) {
    const code = await uniqueCode(dk.code)
    const k: Ksa = {
      id: newId(),
      code,
      area: dk.area ?? '',
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
