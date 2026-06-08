// Render a ParticipantReport to clean markdown for pasting into a Google Doc or
// sharing with the participant. Formatting follows the vault conventions: no "---"
// dividers, a sentence of body text between heading levels, em dashes used sparingly.

import type { ParticipantReport, KsaRollup } from './build'

const LEVEL_WORD: Record<number, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}

function designationLine(r: KsaRollup): string {
  if (r.representative === null) return 'No evidence recorded yet.'
  const word = LEVEL_WORD[r.representative] ?? ''
  const spread =
    r.designations.length > 1 ? ` (recorded evidence ranged ${r.designations[0]}–${r.designations[r.designations.length - 1]})` : ''
  const conflict = r.conflict ? ' This KSA shows conflicting evidence and should be reviewed before it is finalized.' : ''
  return `**Designation: ${r.representative}/3 (${word}).**${spread}${conflict}`
}

export function renderParticipantReportMarkdown(report: ParticipantReport, workshopName: string, generatedOn: string): string {
  const lines: string[] = []
  lines.push(`# Participant evaluation: ${report.participant_name}`)
  lines.push('')
  const teamBit = report.team_name ? `, ${report.team_name}` : ''
  lines.push(`${workshopName}${teamBit}. Draft evidence summary generated ${generatedOn} from facilitator observations. Numbers are draft 0–3 designations and the evidence levels behind them are still being finalized, so treat this as input to a human judgment rather than a final score.`)
  lines.push('')
  lines.push(
    `Evidence has been recorded against ${report.totals.evidencedKsas} of ${report.totals.totalKsas} competency areas${report.totals.needsReviewCount ? `, with ${report.totals.needsReviewCount} item(s) flagged for review` : ''}.`,
  )
  lines.push('')

  lines.push('## Evidence by competency area')
  lines.push('')
  const evidenced = report.ksaRollups.filter((r) => r.representative !== null)
  const unevidenced = report.ksaRollups.filter((r) => r.representative === null)

  if (evidenced.length === 0) {
    lines.push('No counting evidence has been recorded for this participant yet.')
    lines.push('')
  }

  for (const r of evidenced) {
    lines.push(`### ${r.ksa_code}: ${r.area}`)
    lines.push('')
    lines.push(designationLine(r))
    lines.push('')
    for (const o of r.contributing) {
      const tag = o.origin === 'group' ? ' [group observation]' : ''
      lines.push(`- ${o.evidence_designation}/3${tag}: ${o.text}`)
      if (o.source_excerpt) lines.push(`  > "${o.source_excerpt}"`)
    }
    lines.push('')
  }

  if (unevidenced.length) {
    lines.push('### Competency areas without evidence yet')
    lines.push('')
    lines.push(
      `No observations have been recorded for: ${unevidenced.map((r) => `${r.ksa_code} (${r.area})`).join('; ')}.`,
    )
    lines.push('')
  }

  const flagged = report.ksaRollups.flatMap((r) => r.toVerify.map((o) => ({ code: r.ksa_code, o })))
  if (flagged.length) {
    lines.push('## Items flagged for review')
    lines.push('')
    lines.push('These observations need a human decision before they count toward a designation, because the participant was ambiguous, the competency mapping was a stretch, or the evidence was too thin to rate.')
    lines.push('')
    for (const { code, o } of flagged) {
      lines.push(`- **${code}**: ${o.text} (${o.confidence} confidence)`)
      if (o.source_excerpt) lines.push(`  > "${o.source_excerpt}"`)
    }
    lines.push('')
  }

  lines.push('## CBC competency mapping')
  lines.push('')
  lines.push('Draft designations grouped by the CBC sub-points each competency area feeds, as a starting point for the eventual CBC submission.')
  lines.push('')
  for (const c of report.cbc) {
    const parts = c.entries.map((e) => `${e.ksa_code} ${e.representative === null ? '(no evidence)' : `${e.representative}/3`}`)
    lines.push(`- **${c.subpoint}**: ${parts.join(', ')}`)
  }
  lines.push('')

  return lines.join('\n')
}
