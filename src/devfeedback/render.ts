import { IMPORTANCE_ORDER, type FeedbackComment, type Importance } from './db'

const IMPORTANCE_LABEL: Record<Importance, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/**
 * The standing instruction that opens every batch. This is what makes the
 * feedback "handled all at once": Claude is told to read the whole set, find
 * shared root causes, and propose ONE consolidated plan, not to fix each
 * comment in isolation.
 */
const HEADER = `> **How to handle this batch.** These comments were collected together on
> purpose. Read every item first, then cluster them by theme and shared root
> cause (note the importance ranks). Propose ONE consolidated plan grouped by
> pattern and get approval before changing anything. Do NOT act on comments
> individually — overarching issues are easier and safer to fix all at once.`

function escapeQuote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * Render a batch of comments to a single markdown document: the handling header,
 * a glance summary, the comments grouped by importance, and a fenced JSON block
 * carrying the raw records for fidelity.
 */
export function renderBatchMarkdown(comments: FeedbackComment[], generatedAt: string): string {
  const sorted = [...comments].sort(
    (a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || a.createdAt.localeCompare(b.createdAt),
  )
  const counts = sorted.reduce<Record<Importance, number>>(
    (acc, c) => ({ ...acc, [c.importance]: acc[c.importance] + 1 }),
    { high: 0, medium: 0, low: 0 },
  )

  const lines: string[] = []
  lines.push(`# Feedback batch — ${generatedAt}`)
  lines.push('')
  lines.push(HEADER)
  lines.push('')
  lines.push(
    `**${sorted.length} comment${sorted.length === 1 ? '' : 's'}** · ` +
      `${counts.high} high · ${counts.medium} medium · ${counts.low} low`,
  )
  lines.push('')

  let lastImportance: Importance | null = null
  let n = 0
  for (const c of sorted) {
    if (c.importance !== lastImportance) {
      lines.push(`## ${IMPORTANCE_LABEL[c.importance]} importance`)
      lines.push('')
      lastImportance = c.importance
    }
    n += 1
    lines.push(`### ${n}. ${c.locationLabel || c.route}`)
    lines.push('')
    lines.push(`- **Route:** \`${c.route}\``)
    lines.push(`- **Location:** ${c.locationLabel || '(page level)'}`)
    lines.push('')
    if (c.selectionText) {
      lines.push('Highlighted:')
      lines.push('')
      lines.push(escapeQuote(c.selectionText))
      lines.push('')
    }
    lines.push(c.comment)
    lines.push('')
  }

  lines.push('## Raw records')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({ schema: 'cairn.feedback-batch/v1', generatedAt, comments: sorted }, null, 2))
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}
