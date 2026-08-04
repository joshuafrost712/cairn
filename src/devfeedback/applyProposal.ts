/**
 * Applying one staged proposal, in one place (tl-16).
 *
 * ## Why this is a module rather than a click handler
 *
 * The apply logic lived inside `ProposalPanel`, which is dev-gated: it renders nothing
 * without `?dev=1`. That was fine while the only database-backed copy was reference text
 * that Joshua edited in dev mode. tl-16 gives an ADMINISTRATOR authored templates, and
 * an administrator does not run the app in dev mode, so the Setup templates section needs
 * the same approve action. Two copies of "check staleness, write through the outbox,
 * resolve the proposal, drain, log" is precisely the shape this codebase keeps recording
 * as its characteristic failure — one copy gets a fix and the other does not — so the
 * panel and the section both call this.
 *
 * ## The four things it does, in this order, and why the order is the specification
 *
 *  1. **Re-read the current value and compare it to `oldText`.** The Web App Build
 *     Protocol requires staleness to be checked at APPROVE time and not only at propose
 *     time, because the window between the two is where a second administrator lives.
 *  2. **Write through the app's own write path**, never straight to Supabase. Both
 *     branches queue in `referenceOutbox`, which `loadReferenceData()` drains before its
 *     destructive pull. A direct write works online and silently loses the edit offline.
 *  3. **Resolve the proposal.** After the write, so a throw in between leaves it pending
 *     and retryable rather than marked applied over a change that did not land.
 *  4. **Drain and log.** The drain is reported honestly rather than assumed (the widget's
 *     invariant #1: never claim a success you did not observe), and the log is
 *     best-effort because the write has already happened and must not be undone because
 *     recording it failed.
 */

import { upsertActivity, upsertKsa, upsertWorkshop, pushReferenceOutbox } from '../db/referenceWrite'
import { revertTemplate, saveTemplate, templatesForWorkshop } from '../db/templates'
import { bodyFor } from '../templates/resolve'
import { defaultBody, templateSpec } from '../templates/defaults'
import type { TemplateProblem } from '../templates/validate'
import type { Activity, Ksa, Workshop } from '../lib/types'
import { resolveProposal, type ContentProposal } from './db'
import { logAppliedEdit } from './applyEdit'
import { loadRefRow, readRefField, writeRefField } from './refField'

export type ApplyCode = 'applied' | 'missing' | 'stale' | 'invalid'

export interface ApplyResult {
  code: ApplyCode
  /** Set on `invalid`: which rule refused it, so the caller can name the field. */
  problem?: TemplateProblem
  /** `applied` only: entries still waiting to reach the backend. */
  stillPending?: number
  /** `applied` only: the drain itself threw, so it stays queued and retries. */
  syncFailed?: boolean
  /** `applied` only: whether the before/after reached the git-tracked log. */
  logged: boolean
  /**
   * `applied` only, `ai_template` only: this was a revert rather than an override.
   *
   * Derived rather than flagged on the proposal. A proposed body that is byte-identical
   * to the shipped default IS a revert, and storing it as an override would pin the
   * workshop to this build's wording forever — a later deploy that improved the default
   * would never reach a workshop that had explicitly asked for "the app's own words".
   * Deriving it means the queue needs no new column and an admin who reverts by pasting
   * the default text back gets the same, correct result as one who clicks Revert.
   */
  reverted?: boolean
}

/** Split an `ai_template` proposal's rowId back into its pair. */
export function parseTemplateRowId(rowId: string): { workshopId: string; templateKey: string } | null {
  const i = rowId.indexOf('::')
  if (i <= 0) return null
  const workshopId = rowId.slice(0, i)
  const templateKey = rowId.slice(i + 2)
  if (!workshopId || !templateKey) return null
  return { workshopId, templateKey }
}

/**
 * The value a proposal must still be sitting on for it to be applicable.
 *
 * Exported because the editor seeds a proposal's `oldText` with it, and a read used to
 * seed an edit that differed from the read used to apply it is how a staleness check
 * starts refusing valid work (or accepting stale work) without anybody noticing.
 */
export async function currentProposalText(p: ContentProposal): Promise<string | null> {
  if (p.table === 'ai_template') {
    const parsed = parseTemplateRowId(p.rowId)
    if (!parsed) return null
    if (!templateSpec(parsed.templateKey)) return null
    const set = await templatesForWorkshop(parsed.workshopId)
    return bodyFor(set, parsed.templateKey)
  }
  const row = await loadRefRow(p.table, p.rowId)
  if (!row) return null
  return readRefField(row, p.field)
}

export async function applyProposal(
  p: ContentProposal,
  by: string | null = null,
): Promise<ApplyResult> {
  const current = await currentProposalText(p)
  if (current === null) return { code: 'missing', logged: false }
  if (current !== p.oldText) return { code: 'stale', logged: false }

  let reverted = false

  if (p.table === 'ai_template') {
    const parsed = parseTemplateRowId(p.rowId)
    // Unreachable given `currentProposalText` returned a string, and asserted rather
    // than assumed because the alternative is a `!` on a value the type says may be null.
    if (!parsed) return { code: 'missing', logged: false }

    reverted = p.newText === defaultBody(parsed.templateKey)
    const outcome = reverted
      ? await revertTemplate(parsed.workshopId, parsed.templateKey)
      : await saveTemplate(parsed.workshopId, parsed.templateKey, p.newText, by)

    // Validated again HERE and not only in the editor, because an approval can happen a
    // day after the edit was typed and this build may by then be a deploy newer than the
    // one that accepted it, with a variable renamed out from under the body.
    if (!outcome.ok) return { code: 'invalid', problem: outcome.problem, logged: false }
  } else {
    const row = await loadRefRow(p.table, p.rowId)
    if (!row) return { code: 'missing', logged: false }
    const next = writeRefField(row, p.field, p.newText)
    if (p.table === 'ksa') await upsertKsa(next as Ksa)
    else if (p.table === 'activity') await upsertActivity(next as Activity)
    else await upsertWorkshop(next as Workshop)
  }

  await resolveProposal(p.id, 'applied')

  let stillPending = 0
  let syncFailed = false
  try {
    const drained = await pushReferenceOutbox()
    stillPending = drained.pending
  } catch {
    syncFailed = true
  }

  const logged = await logAppliedEdit({
    table: p.table,
    rowId: p.rowId,
    field: p.field,
    oldText: p.oldText,
    newText: p.newText,
  })

  return { code: 'applied', stillPending, syncFailed, logged, reverted }
}
