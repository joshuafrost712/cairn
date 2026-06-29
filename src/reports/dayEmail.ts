// Render the day's evaluations into one email-ready summary across all participants.
// Where the per-participant report (markdown.ts) is a deliverable for a single
// person, this is the end-of-day note a consultant sends out: it rolls every
// participant together and, crucially, makes explicit where two evaluators agreed
// and where they conflicted on the same participant. The merge itself is already
// done in build.ts (max designation per KSA, conflict flag on a spread of 2+); this
// only renders it. Formatting follows the vault conventions: no "---" dividers, a
// sentence of body between heading levels, em dashes used sparingly.

import type { ParticipantReport, KsaRollup } from './build'
import type { AnnotatedObservation, Gate } from './verification'

const LEVEL_WORD: Record<number, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}

/** Short identifier for an evaluator from their email (local-part), for attribution. */
function evaluatorLabel(email: string | null | undefined): string {
  if (!email) return 'an evaluator'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** The agreement/conflict sentence for one KSA, the heart of "how the system handles it". */
function consensusLine(r: KsaRollup<AnnotatedObservation>): string {
  const word = LEVEL_WORD[r.representative ?? 0] ?? ''
  const head = `Designation ${r.representative}/3 (${word}).`
  if (r.designations.length <= 1) return head // single piece of evidence; nothing to reconcile
  const lo = r.designations[0]
  const hi = r.designations[r.designations.length - 1]
  if (r.conflict) {
    return `${head} Evaluators conflicted here: scores ranged ${lo}–${hi}. Flagged for review before this is finalized.`
  }
  if (lo !== hi) {
    return `${head} Evaluators broadly agreed (scores ranged ${lo}–${hi}); the strongest evidence is carried forward.`
  }
  return `${head} Evaluators agreed.`
}

/** Per-participant verification summary (verified / pending / disputed). */
function gateLine(gate: Gate | undefined): string | null {
  if (!gate || gate.total === 0) return null
  if (gate.status === 'ready') {
    return `Verification: all ${gate.total} observation(s) confirmed by at least ${gate.required} evaluators. Cleared to finalize.`
  }
  const bits = [`${gate.verified}/${gate.total} verified`]
  if (gate.pending) bits.push(`${gate.pending} pending`)
  if (gate.disputed) bits.push(`${gate.disputed} disputed`)
  return `Verification: ${bits.join(', ')} (needs ${gate.required} confirmations each). Not yet cleared to finalize.`
}

export interface DayEmailOptions {
  /** Greeting recipient, e.g. "team". Defaults to a generic opener. */
  toName?: string
  /** Who the summary is from, shown in the sign-off. */
  fromName?: string
}

/**
 * Build the end-of-day email body. `reports` and `gates` come straight from the
 * existing pipeline (buildAllReports over annotated observations, participantGate
 * per participant), so the numbers match the Reports page exactly.
 */
export function renderDayEmailMarkdown(
  reports: ParticipantReport<AnnotatedObservation>[],
  gates: Map<string, Gate>,
  workshopName: string,
  dateLabel: string,
  opts: DayEmailOptions = {},
): string {
  const withEvidence = reports.filter(
    (r) => r.totals.evidencedKsas > 0 || (gates.get(r.participant_id)?.total ?? 0) > 0,
  )

  const lines: string[] = []
  lines.push(`# End-of-day evaluation summary: ${workshopName}`)
  lines.push('')
  lines.push(opts.toName ? `Hi ${opts.toName},` : 'Hi all,')
  lines.push('')
  lines.push(
    `Here is the evaluation summary for ${dateLabel}, rolled up from the facilitator observations captured today. These are draft 0–3 designations meant as input to a human judgment, not final scores. Where more than one of us evaluated the same participant, the summary notes whether we agreed or conflicted.`,
  )
  lines.push('')

  if (withEvidence.length === 0) {
    lines.push('No observations have been recorded yet today. Once captures are routed, this summary will fill in per participant.')
    lines.push('')
    if (opts.fromName) {
      lines.push('Thanks,')
      lines.push(opts.fromName)
    }
    return lines.join('\n')
  }

  lines.push(`## Participants evaluated today (${withEvidence.length})`)
  lines.push('')
  lines.push('Each participant below has at least one observation from today. Designations behind a conflict flag still need a human decision.')
  lines.push('')

  for (const r of withEvidence) {
    const team = r.team_name ? ` (${r.team_name})` : ''
    lines.push(`## ${r.participant_name}${team}`)
    lines.push('')
    const gl = gateLine(gates.get(r.participant_id))
    if (gl) {
      lines.push(gl)
      lines.push('')
    }

    const evidenced = r.ksaRollups.filter((k) => k.representative !== null)
    if (evidenced.length === 0) {
      lines.push('No counting evidence yet; all observations are still awaiting review.')
      lines.push('')
    }

    for (const k of evidenced) {
      lines.push(`### ${k.ksa_code}: ${k.area}`)
      lines.push('')
      lines.push(`**${consensusLine(k)}**`)
      lines.push('')
      for (const o of k.contributing) {
        const who = evaluatorLabel(o.evaluator_email)
        const eff = o.effective_designation
        const adjusted = eff !== o.evidence_designation ? ` (adjusted from ${o.evidence_designation})` : ''
        const group = o.origin === 'group' ? ' [group observation]' : ''
        lines.push(`- ${who} rated ${eff}/3${adjusted}${group}: ${o.text}`)
        if (o.source_excerpt) lines.push(`  > "${o.source_excerpt}"`)
      }
      lines.push('')
    }

    const flagged = r.ksaRollups.flatMap((k) => k.toVerify.map((o) => ({ code: k.ksa_code, o })))
    if (flagged.length) {
      lines.push('Items flagged for review (not yet counted):')
      for (const { code, o } of flagged) {
        lines.push(`- **${code}** (${evaluatorLabel(o.evaluator_email)}, ${o.confidence} confidence): ${o.text}`)
      }
      lines.push('')
    }
  }

  if (opts.fromName) {
    lines.push('Thanks,')
    lines.push(opts.fromName)
  }
  return lines.join('\n')
}
