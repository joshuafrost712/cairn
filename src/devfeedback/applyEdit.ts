/**
 * The two write paths behind edit-in-place, kept apart because the two kinds of
 * copy carry different risk.
 *
 *   chrome -> patched straight into src/content/chrome.json on disk. Safe to apply
 *             immediately: it is a git-tracked file change that only reaches an
 *             evaluator on the next deploy.
 *   ref    -> never written here. Reference copy is read live from Supabase by
 *             every evaluator's device, so an edit is filed as a proposal and
 *             applied only on approval (see ProposalPanel).
 */

export interface ChromeEdit {
  nodeId: string
  field: string
  oldText: string
  newText: string
}

/**
 * Patch a chrome string on disk through the dev server. Returns an outcome rather
 * than a bare boolean so the panel can tell "the endpoint isn't there" (a deployed
 * build) apart from "someone else changed this text first", which need different
 * messages.
 */
export type ChromeEditResult = 'applied' | 'stale' | 'unavailable' | 'rejected'

export async function applyChromeEdit(edit: ChromeEdit): Promise<ChromeEditResult> {
  if (!import.meta.env.DEV) return 'unavailable'
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__content-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    })
    if (res.ok) return 'applied'
    if (res.status === 409) return 'stale'
    return 'rejected'
  } catch {
    return 'unavailable'
  }
}

/**
 * Append an applied reference edit to feedback/content-edits/<date>.md so seed.ts
 * can be reconciled and the change is visible in git. Best-effort by design: the
 * database write has already happened and must not be undone because logging
 * failed, so this never throws and its result is advisory.
 */
export async function logAppliedEdit(entry: {
  table: string
  rowId: string
  field: string
  oldText: string
  newText: string
}): Promise<boolean> {
  if (!import.meta.env.DEV) return false
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  const markdown = [
    '',
    `## ${entry.table} \`${entry.rowId}\` · ${entry.field}`,
    `_applied ${now.toISOString()}_`,
    '',
    '```diff',
    ...entry.oldText.split('\n').map((l) => `- ${l}`),
    ...entry.newText.split('\n').map((l) => `+ ${l}`),
    '```',
  ].join('\n')
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__content-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, markdown }),
    })
    return res.ok
  } catch {
    return false
  }
}
