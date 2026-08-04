/**
 * The authored templates: the offline-first cache, the one write path, and the thing
 * that keeps the pure layer's synchronous mirror correct (tl-16).
 *
 * The split is db/scale.ts's exactly, and for its reason. The MIRROR lives in
 * src/templates/resolve.ts, which is pure, because its readers are pure — the three
 * segment builders are synchronous functions called from a dozen places including
 * the report layer's own tests — and making them async so they could consult Dexie
 * would ripple through every caller to buy nothing. This module is the half that has
 * an IndexedDB to read: it pulls the rows and calls `setActiveTemplates`.
 *
 * ONE THING THIS MODULE MUST NOT BECOME. `ai_template` is deliberately NOT in
 * `loadReferenceData()`'s clear-and-overwrite set, for the reason Wave 2 gave about
 * `doc_draft`: that function is right for reference data and catastrophic for rows
 * holding human edits, because it deletes what the remote did not return. It is
 * pulled here, additively, and pruned only from the workshops the pull was
 * AUTHORIZED to see — the `inScope` distinction db/scale.ts and db/settings.ts both
 * carry, which is what tells "no rows because there are none" (prune) from "no rows
 * because RLS filtered this workshop out" (leave alone). Getting it backwards would
 * silently revert a workshop's whole authored library to shipped wording on every
 * device belonging to somebody who is not a member of it.
 */

import { aiTemplatePk, db } from './local'
import { enqueueReferenceWrite, pushReferenceOutbox } from './referenceWrite'
import { supabase } from '../lib/supabase'
import { templateSpec, type AiTemplateRow } from '../templates/defaults'
import {
  DEFAULT_TEMPLATES,
  buildTemplateSet,
  setActiveTemplates,
  type TemplateSet,
} from '../templates/resolve'
import { validateTemplateBody, type TemplateProblem } from '../templates/validate'

/** Cached override rows for one workshop. */
export async function templateRowsFor(workshopId: string): Promise<AiTemplateRow[]> {
  return db.aiTemplates.where('workshop_id').equals(workshopId).toArray()
}

/** One workshop's resolved set. The read anything cross-workshop must use. */
export async function templatesForWorkshop(workshopId: string | null): Promise<TemplateSet> {
  if (!workshopId) return DEFAULT_TEMPLATES
  return buildTemplateSet(workshopId, await templateRowsFor(workshopId))
}

/**
 * Re-point the synchronous mirror at whichever workshop is selected.
 *
 * Called from `loadReferenceData()` in the same breath as the scale and settings
 * mirrors, so there is no window in which fresh rows sit in Dexie while a generated
 * email still carries the previous workshop's wording.
 */
export async function mirrorActiveTemplates(workshopId: string | null): Promise<TemplateSet> {
  const set = await templatesForWorkshop(workshopId)
  setActiveTemplates(set)
  return set
}

interface RemoteTemplate {
  workshop_id: string
  kind: string
  template_key: string
  body: string
  updated_by?: string | null
  updated_at?: string | null
}

/**
 * Replace the cached override rows with what the backend returned.
 *
 * A row whose `template_key` this build does not declare is cached anyway rather
 * than dropped, and that is deliberate: `bodyFor()` already ignores an unknown key
 * when resolving, so it cannot reach a document, and keeping it means a device that
 * has been downgraded does not silently delete a newer client's authored work on its
 * next pull.
 */
export async function cacheTemplates(
  rows: RemoteTemplate[],
  inScope?: Iterable<string>,
): Promise<void> {
  const typed: AiTemplateRow[] = rows.map((r) => ({
    pk: aiTemplatePk(r.workshop_id, r.template_key),
    workshop_id: r.workshop_id,
    kind: (templateSpec(r.template_key)?.kind ?? r.kind) as AiTemplateRow['kind'],
    template_key: r.template_key,
    body: r.body,
    updated_by: r.updated_by ?? null,
    updated_at: r.updated_at ?? new Date().toISOString(),
  }))

  const touched = new Set([...(inScope ?? []), ...rows.map((r) => r.workshop_id)])
  await db.transaction('rw', db.aiTemplates, async () => {
    for (const workshopId of touched) {
      const stale = await db.aiTemplates.where('workshop_id').equals(workshopId).toArray()
      const keep = new Set(typed.filter((t) => t.workshop_id === workshopId).map((t) => t.pk))
      await db.aiTemplates.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
    }
    await db.aiTemplates.bulkPut(typed)
  })
}

/**
 * Pull the authorized workshops' templates.
 *
 * Its own function rather than a branch inside `loadReferenceData` for the reason at
 * the top of this file: that function's pull is destructive, and this one is not.
 * Failures are swallowed and reported by return value — a device that cannot reach
 * the network keeps its cached library and generates from it, which is the offline
 * behaviour the whole cache exists for.
 */
export async function pullTemplates(workshopIds: string[]): Promise<{ pulled: number } | null> {
  if (!supabase || workshopIds.length === 0) return null
  const { data, error } = await supabase
    .from('ai_template')
    .select('workshop_id, kind, template_key, body, updated_by, updated_at')
    .in('workshop_id', workshopIds)
  if (error || !data) return null
  await cacheTemplates(data as RemoteTemplate[], workshopIds)
  return { pulled: data.length }
}

/**
 * Re-point the mirror only when the workshop written to is the ACTIVE one.
 *
 * The unconditional version was a defect the second-AI review found: `ProposalPanel` (the
 * dev surface) applies any pending proposal with no workshop filter, so approving a
 * leftover proposal for workshop A while working in B pointed the pure layer at A and left
 * it there until the next `loadReferenceData`. Every document generated in B afterwards
 * would have carried A's wording. The settings and scale mirrors avoid this only by
 * being called with the resolved active id and nothing else; this one is called from a
 * writer, so it has to check.
 *
 * NO STORED SELECTION COUNTS AS A MATCH, and the first version of this guard getting that
 * wrong is why the condition is spelled out rather than written as `!==`. `getActiveWorkshopId()`
 * returns null until somebody has explicitly switched workshop — which is the normal state
 * of a one-workshop deployment and of every fresh device — so a strict inequality skipped
 * the mirror on exactly the devices where there is only one workshop it could mean. The
 * browser walkthrough caught it: a freshly generated draft was reported stale, because the
 * mirror still held the empty set while the draft carried the override's fingerprint.
 */
async function mirrorIfActive(workshopId: string): Promise<void> {
  const { getActiveWorkshopId } = await import('../lib/activeWorkshop')
  const active = getActiveWorkshopId()
  if (active !== null && active !== workshopId) return
  await mirrorActiveTemplates(workshopId)
}

export type SaveTemplateResult =
  | { ok: true; reverted: boolean }
  | { ok: false; problem: TemplateProblem }

/**
 * Store one authored body.
 *
 * Validated here as well as in the editor, because this is the function the proposal
 * queue's approve path calls and an approval can happen a day after the edit was
 * typed — by which time this build may be a deploy newer than the one that accepted
 * it, with a variable renamed. Refusing at apply time is the check that catches that.
 */
export async function saveTemplate(
  workshopId: string,
  templateKey: string,
  body: string,
  by: string | null,
): Promise<SaveTemplateResult> {
  const spec = templateSpec(templateKey)
  if (!spec) return { ok: false, problem: { code: 'unknown_key' } }

  const verdict = validateTemplateBody(templateKey, body)
  if (!verdict.ok) return { ok: false, problem: verdict.problem }

  const pk = aiTemplatePk(workshopId, templateKey)
  const row: AiTemplateRow = {
    pk,
    workshop_id: workshopId,
    kind: spec.kind,
    template_key: templateKey,
    body,
    updated_by: by,
    updated_at: new Date().toISOString(),
  }

  await db.aiTemplates.put(row)
  await enqueueReferenceWrite({
    id: `ai_template:${pk}`,
    table: 'ai_template',
    op: 'upsert',
    rowKey: pk,
    // `pk` is not sent: it is this app's flattening of the pair, and Postgres's own
    // key is the `id` uuid with a unique constraint on the pair, which is what the
    // upsert's onConflict names.
    payload: {
      workshop_id: workshopId,
      kind: spec.kind,
      template_key: templateKey,
      body,
      updated_by: by,
    },
  })
  void pushReferenceOutbox()

  await mirrorIfActive(workshopId)
  return { ok: true, reverted: false }
}

/**
 * Revert one slot to the shipped default, by deleting the override.
 *
 * Deleting rather than writing the default text back, and the difference matters
 * later rather than now: a row holding today's shipped wording would go on holding it
 * after a deploy that improved the default, so a workshop that had asked for "the
 * app's own words" would be pinned to an old build's words with nothing saying so.
 * Absence tracks the deploy; a copy does not.
 */
export async function revertTemplate(
  workshopId: string,
  templateKey: string,
): Promise<SaveTemplateResult> {
  if (!templateSpec(templateKey)) return { ok: false, problem: { code: 'unknown_key' } }
  const pk = aiTemplatePk(workshopId, templateKey)

  await db.aiTemplates.delete(pk)
  await enqueueReferenceWrite({
    id: `ai_template:${pk}`,
    table: 'ai_template',
    op: 'delete',
    rowKey: pk,
    payload: null,
  })
  void pushReferenceOutbox()

  await mirrorIfActive(workshopId)
  return { ok: true, reverted: true }
}

/**
 * One instruction body, resolved for a NAMED workshop rather than the active one.
 *
 * The helper the AI providers use, and it exists because the second-AI review found all
 * four of them relying on the mirror. A provider is handed a job carrying a
 * `workshopId`; the operator may have switched away between queueing the work and its
 * running, and in `local-agent` mode a batch can run minutes later on a machine nobody
 * is sitting at. `localAgent.ts` already resolved the SCALE explicitly for exactly this
 * reason and its comment argues the case — then passed no instruction body, so a
 * five-point workshop got its own rubric with another workshop's contract beside it.
 *
 * Async, which is why it is here and not in the pure layer: a provider is already async
 * and has no reason not to be, unlike the segment builders.
 *
 * IT FAILS SOFT, AND THAT IS NOT DEFENSIVE PADDING. Putting a Dexie read on the path to
 * a prompt makes the hand-off depend on IndexedDB, and tl-13 already wrote down why that
 * is a live hazard rather than a theoretical one: a blocked upgrade is "an ordinary event
 * for an installed PWA with a second tab open on the previous version", which is exactly
 * why the trace is fired and not awaited. An unreadable store must not stop an operator
 * being handed their prompt, so it degrades to the SHIPPED body — the behaviour of every
 * build before tl-16 — rather than throwing. It warns, because silently ignoring a
 * workshop's authored instructions is worth a line in a console even when it is the right
 * thing to do.
 */
export async function instructionFor(
  workshopId: string,
  key:
    | 'instructions.general'
    | 'instructions.observation_routing'
    | 'instructions.scenario_draft'
    | 'instructions.conversation_guidance',
): Promise<string> {
  const { bodyFor, DEFAULT_TEMPLATES: SHIPPED } = await import('../templates/resolve')
  try {
    return bodyFor(await templatesForWorkshop(workshopId), key)
  } catch (err) {
    console.warn(`[honest-eval] could not read the authored ${key}; using the shipped text`, err)
    return bodyFor(SHIPPED, key)
  }
}
