// Render the day's evaluations into one email-ready summary across all participants.
// This is the end-of-day note a consultant sends out. It is deliberately NOT a
// rehash of every observation: for each participant it surfaces two or three
// highlights to encourage, the growth area(s) that matter, and — when a confirmed
// low designation (0 or 1) appears — a recommendation to hold a short mentoring
// conversation the next day. Evidence stays traceable: every highlight and growth
// note carries the evaluator's attribution and the verbatim excerpt behind it, and
// where two evaluators conflicted on the same participant that is made explicit so
// a human reconciles it before anything is finalized.
//
// The merge itself is already done in build.ts (max designation per KSA, conflict
// flag on a spread of 2+); this only selects and renders it. Formatting follows the
// vault conventions: no "---" dividers, a sentence of body between heading levels,
// em dashes used sparingly.

import type { ParticipantReport, KsaRollup } from './build'
import type { AnnotatedObservation, Gate } from './verification'

const LEVEL_WORD: Record<number, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}

// A confirmed designation at or below this level is treated as a growth signal
// worth a mentoring conversation. Kept as a named constant so the threshold is
// visible and easy to change.
const MENTORING_THRESHOLD = 1

/** Short identifier for an evaluator from their email (local-part), for attribution. */
function evaluatorLabel(email: string | null | undefined): string {
  if (!email) return 'an evaluator'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** Per-participant verification summary, shown only when the gate is not yet clear. */
function gateLine(gate: Gate | undefined): string | null {
  if (!gate || gate.total === 0) return null
  if (gate.status === 'ready') return null
  const bits = [`${gate.verified}/${gate.total} verified`]
  if (gate.pending) bits.push(`${gate.pending} pending`)
  if (gate.disputed) bits.push(`${gate.disputed} disputed`)
  return `_Verification: ${bits.join(', ')} (needs ${gate.required} confirmations each); not yet cleared to finalize._`
}

/** The strongest single piece of counting evidence for a KSA, for a one-line highlight. */
function strongestEvidence(k: KsaRollup<AnnotatedObservation>): AnnotatedObservation | null {
  if (!k.contributing.length) return null
  return [...k.contributing].sort((a, b) => {
    const d = b.effective_designation - a.effective_designation
    if (d !== 0) return d
    // tie-break: prefer a "strong" sentiment reading
    const rank = (o: AnnotatedObservation) => (o.sentiment_flag === 'strong' ? 0 : o.sentiment_flag === 'neutral' ? 1 : 2)
    return rank(a) - rank(b)
  })[0]
}

/** One evidence bullet: who saw it, the designation, and the verbatim excerpt. */
function evidenceBullet(o: AnnotatedObservation): string[] {
  const who = evaluatorLabel(o.evaluator_email)
  const eff = o.effective_designation
  const adjusted = eff !== o.evidence_designation ? ` (adjusted from ${o.evidence_designation})` : ''
  const group = o.origin === 'group' ? ' [group observation]' : ''
  const out = [`  - ${who} rated ${eff}/3${adjusted}${group}: ${o.text}`]
  if (o.source_excerpt) out.push(`    > "${o.source_excerpt}"`)
  return out
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
    `Here are the highlights and growth areas for ${dateLabel}, drawn from the facilitator observations captured today. These are draft 0–3 designations meant as input to a human judgment, not final scores. Where more than one of us evaluated the same participant, the summary notes whether we agreed or need to reconcile.`,
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

  for (const r of withEvidence) {
    const team = r.team_name ? ` (${r.team_name})` : ''
    lines.push(`## ${r.participant_name}${team}`)
    lines.push('')

    const evidenced = r.ksaRollups.filter((k) => k.representative !== null)

    // Highlights: the KSAs where the best evidence is competent/strong (2–3),
    // top three, each with the single strongest piece of evidence behind it.
    const highlightKsas = evidenced
      .filter((k) => (k.representative ?? 0) >= 2)
      .sort((a, b) => (b.representative ?? 0) - (a.representative ?? 0))
      .slice(0, 3)

    if (highlightKsas.length) {
      lines.push('**Highlights to encourage**')
      for (const k of highlightKsas) {
        const best = strongestEvidence(k)
        const word = LEVEL_WORD[k.representative ?? 0] ?? ''
        lines.push(`- Strong work on ${k.area} (${word}, ${k.representative}/3).`)
        if (best) lines.push(...evidenceBullet(best))
      }
      lines.push('')
    }

    // Growth areas: KSAs whose best evidence is still 0–1.
    const growthKsas = evidenced
      .filter((k) => (k.representative ?? 0) <= MENTORING_THRESHOLD)
      .sort((a, b) => (a.representative ?? 0) - (b.representative ?? 0))

    if (growthKsas.length) {
      lines.push('**Growth areas**')
      for (const k of growthKsas) {
        const word = LEVEL_WORD[k.representative ?? 0] ?? ''
        lines.push(`- ${k.area}: ${word} (${k.representative}/3).`)
        const best = strongestEvidence(k)
        if (best) lines.push(...evidenceBullet(best))
      }
      lines.push('')
    }

    // Reconciliation: any KSA where two evaluators conflicted (spread of 2+).
    const conflicts = evidenced.filter((k) => k.conflict)
    if (conflicts.length) {
      lines.push('**Needs reconciliation**')
      for (const k of conflicts) {
        const lo = k.designations[0]
        const hi = k.designations[k.designations.length - 1]
        lines.push(`- ${k.area}: evaluators conflicted here (scores ranged ${lo}–${hi}). Flagged for review before this is finalized.`)
        // Show every side of the conflict so the disagreement is fully traceable.
        for (const o of k.contributing) lines.push(...evidenceBullet(o))
      }
      lines.push('')
    }

    // Mentoring recommendation: any confirmed (counting) observation at or below
    // the threshold means a short follow-up conversation is warranted tomorrow.
    const lowConfirmed = evidenced
      .flatMap((k) => k.contributing)
      .some((o) => o.effective_designation <= MENTORING_THRESHOLD)
    if (lowConfirmed) {
      lines.push(
        `**Recommended follow-up:** A short mentoring conversation tomorrow to work through the growth area(s) above, agree on specific next steps, and note how the feedback is received.`,
      )
      lines.push('')
    }

    const gl = gateLine(gates.get(r.participant_id))
    if (gl) {
      lines.push(gl)
      lines.push('')
    }
  }

  if (opts.fromName) {
    lines.push('Thanks,')
    lines.push(opts.fromName)
  }
  return lines.join('\n')
}
