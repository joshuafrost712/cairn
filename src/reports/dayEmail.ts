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
//
// Structure now comes out as DocSegments (see segments.ts) so the workbench can
// show the evidence behind any one line. renderDayEmailMarkdown is a thin wrapper
// over that and its output is byte-identical to what it produced before, which the
// golden round-trip test in test/reportSegments.test.ts holds in place.

import type { ParticipantReport, KsaRollup } from './build'
import type { AnnotatedObservation, Gate } from './verification'
import {
  LEVEL_WORD,
  MENTORING_THRESHOLD,
  SEGMENT_ID_VERSION,
  claimEvidence,
  endBlock,
  evidenceSegment,
  push,
  segId,
  segmentsToMarkdown,
  slug,
  type DocSegment,
} from './segments'

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
export function strongestEvidence(k: KsaRollup<AnnotatedObservation>): AnnotatedObservation | null {
  if (!k.contributing.length) return null
  return [...k.contributing].sort((a, b) => {
    const d = b.effective_designation - a.effective_designation
    if (d !== 0) return d
    // tie-break: prefer a "strong" sentiment reading
    const rank = (o: AnnotatedObservation) => (o.sentiment_flag === 'strong' ? 0 : o.sentiment_flag === 'neutral' ? 1 : 2)
    return rank(a) - rank(b)
  })[0]
}

export interface DayEmailOptions {
  /** Greeting recipient, e.g. "team". Defaults to a generic opener. */
  toName?: string
  /** Who the summary is from, shown in the sign-off. */
  fromName?: string
}

/**
 * Build the end-of-day email as segments. `reports` and `gates` come straight
 * from the existing pipeline (buildAllReports over annotated observations,
 * participantGate per participant), so the numbers match the Reports page.
 */
export function buildDayEmailSegments(
  reports: ParticipantReport<AnnotatedObservation>[],
  gates: Map<string, Gate>,
  workshopName: string,
  dateLabel: string,
  opts: DayEmailOptions = {},
): DocSegment[] {
  const root = segId(SEGMENT_ID_VERSION, 'de')
  const withEvidence = reports.filter(
    (r) => r.totals.evidencedKsas > 0 || (gates.get(r.participant_id)?.total ?? 0) > 0,
  )

  const out: DocSegment[] = []

  push(out, { id: segId(root, 'title'), kind: 'heading', level: 1, text: `# End-of-day evaluation summary: ${workshopName}` })
  endBlock(out)
  push(out, { id: segId(root, 'greeting'), kind: 'paragraph', text: opts.toName ? `Hi ${opts.toName},` : 'Hi all,' })
  endBlock(out)
  push(out, {
    id: segId(root, 'intro'),
    kind: 'paragraph',
    text: `Here are the highlights and growth areas for ${dateLabel}, drawn from the facilitator observations captured today. These are draft 0–3 designations meant as input to a human judgment, not final scores. Where more than one of us evaluated the same participant, the summary notes whether we agreed or need to reconcile.`,
  })
  endBlock(out)

  if (withEvidence.length === 0) {
    push(out, {
      id: segId(root, 'none'),
      kind: 'paragraph',
      text: 'No observations have been recorded yet today. Once captures are routed, this summary will fill in per participant.',
    })
    endBlock(out)
    if (opts.fromName) {
      push(out, { id: segId(root, 'signoff'), kind: 'paragraph', text: `Thanks,\n${opts.fromName}` })
    }
    return out
  }

  for (const r of withEvidence) {
    const pid = r.participant_id
    const pRoot = segId(root, `p:${slug(pid)}`)
    const team = r.team_name ? ` (${r.team_name})` : ''
    push(out, {
      id: segId(pRoot, 'h'),
      kind: 'heading',
      level: 2,
      text: `## ${r.participant_name}${team}`,
      participantId: pid,
    })
    endBlock(out)

    const evidenced = r.ksaRollups.filter((k) => k.representative !== null)

    // Highlights: the KSAs where the best evidence is competent/strong (2–3),
    // top three, each with the single strongest piece of evidence behind it.
    const highlightKsas = evidenced
      .filter((k) => (k.representative ?? 0) >= 2)
      .sort((a, b) => (b.representative ?? 0) - (a.representative ?? 0))
      .slice(0, 3)

    if (highlightKsas.length) {
      push(out, { id: segId(pRoot, 'hl', 'h'), kind: 'heading', level: 4, text: '**Highlights to encourage**', participantId: pid })
      for (const k of highlightKsas) {
        const kRoot = segId(pRoot, 'hl', `k:${slug(k.ksa_code)}`)
        const best = strongestEvidence(k)
        const word = LEVEL_WORD[k.representative ?? 0] ?? ''
        push(out, {
          id: segId(kRoot, 'claim'),
          kind: 'bullet',
          text: `- Strong work on ${k.goal_title} (${word}, ${k.representative}/3).`,
          participantId: pid,
          ksaCode: k.ksa_code,
          evidence: claimEvidence(k),
        })
        if (best) {
          out.push(
            evidenceSegment(best, {
              id: segId(kRoot, `ev:${slug(best.id)}`),
              indent: '  ',
              showEvaluator: true,
              participantId: pid,
              ksaCode: k.ksa_code,
            }),
          )
        }
      }
      endBlock(out)
    }

    // Growth areas: KSAs whose best evidence is still 0–1.
    const growthKsas = evidenced
      .filter((k) => (k.representative ?? 0) <= MENTORING_THRESHOLD)
      .sort((a, b) => (a.representative ?? 0) - (b.representative ?? 0))

    if (growthKsas.length) {
      push(out, { id: segId(pRoot, 'gr', 'h'), kind: 'heading', level: 4, text: '**Growth areas**', participantId: pid })
      for (const k of growthKsas) {
        const kRoot = segId(pRoot, 'gr', `k:${slug(k.ksa_code)}`)
        const word = LEVEL_WORD[k.representative ?? 0] ?? ''
        push(out, {
          id: segId(kRoot, 'claim'),
          kind: 'bullet',
          text: `- ${k.goal_title}: ${word} (${k.representative}/3).`,
          participantId: pid,
          ksaCode: k.ksa_code,
          evidence: claimEvidence(k),
        })
        const best = strongestEvidence(k)
        if (best) {
          out.push(
            evidenceSegment(best, {
              id: segId(kRoot, `ev:${slug(best.id)}`),
              indent: '  ',
              showEvaluator: true,
              participantId: pid,
              ksaCode: k.ksa_code,
            }),
          )
        }
      }
      endBlock(out)
    }

    // Reconciliation: any KSA where two evaluators conflicted (spread of 2+).
    // Note the distinct 'rc' prefix: a KSA can legitimately be both a highlight
    // and a conflict, with the same strongest observation under each.
    const conflicts = evidenced.filter((k) => k.conflict)
    if (conflicts.length) {
      push(out, { id: segId(pRoot, 'rc', 'h'), kind: 'heading', level: 4, text: '**Needs reconciliation**', participantId: pid })
      for (const k of conflicts) {
        const kRoot = segId(pRoot, 'rc', `k:${slug(k.ksa_code)}`)
        const lo = k.designations[0]
        const hi = k.designations[k.designations.length - 1]
        push(out, {
          id: segId(kRoot, 'claim'),
          kind: 'bullet',
          text: `- ${k.goal_title}: evaluators conflicted here (scores ranged ${lo}–${hi}). Flagged for review before this is finalized.`,
          participantId: pid,
          ksaCode: k.ksa_code,
          evidence: claimEvidence(k),
        })
        // Show every side of the conflict so the disagreement is fully traceable.
        for (const o of k.contributing) {
          out.push(
            evidenceSegment(o, {
              id: segId(kRoot, `ev:${slug(o.id)}`),
              indent: '  ',
              showEvaluator: true,
              participantId: pid,
              ksaCode: k.ksa_code,
            }),
          )
        }
      }
      endBlock(out)
    }

    // Mentoring recommendation: any confirmed (counting) observation at or below
    // the threshold means a short follow-up conversation is warranted tomorrow.
    const low = evidenced
      .flatMap((k) => k.contributing)
      .filter((o) => o.effective_designation <= MENTORING_THRESHOLD)
    if (low.length) {
      push(out, {
        id: segId(pRoot, 'fu'),
        kind: 'paragraph',
        text: `**Recommended follow-up:** A short mentoring conversation tomorrow to work through the growth area(s) above, agree on specific next steps, and note how the feedback is received.`,
        participantId: pid,
        evidence: low.map((o) => o.id),
        note: `Triggered by ${low.length} confirmed observation${low.length === 1 ? '' : 's'} at or below ${MENTORING_THRESHOLD}/3.`,
      })
      endBlock(out)
    }

    const gl = gateLine(gates.get(pid))
    if (gl) {
      push(out, { id: segId(pRoot, 'gate'), kind: 'meta', text: gl, participantId: pid })
      endBlock(out)
    }
  }

  if (opts.fromName) {
    push(out, { id: segId(root, 'signoff'), kind: 'paragraph', text: `Thanks,\n${opts.fromName}` })
  }
  return out
}

/** The same document as markdown. Kept as the stable public entry point. */
export function renderDayEmailMarkdown(
  reports: ParticipantReport<AnnotatedObservation>[],
  gates: Map<string, Gate>,
  workshopName: string,
  dateLabel: string,
  opts: DayEmailOptions = {},
): string {
  return segmentsToMarkdown(buildDayEmailSegments(reports, gates, workshopName, dateLabel, opts))
}
