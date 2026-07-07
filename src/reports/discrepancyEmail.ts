// Discrepancy email renderer — pure, no IO.
//
// Produces three draft emails for each discrepancy:
//   1. To the chief evaluator: full evidence, time-gap note, asks for a joint conversation.
//   2. To evaluator A (the one with the lowest score).
//   3. To evaluator B (the one with the highest score).
//
// If the same evaluation produced multiple observations at the extremes, the first
// observation at each extreme is used as the evaluator recipient, and the chief email
// mentions the additional observations.
//
// Formatting rules: no em dashes, short paragraphs, no horizontal rules.

import type { Discrepancy } from './discrepancy'
import type { AnnotatedObservation } from './verification'

/** Short identifier from an email address (local-part before @). */
function evaluatorLabel(email: string | null | undefined): string {
  if (!email) return 'an evaluator'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** One evidence block shown inside an email. */
function evidenceBlock(o: AnnotatedObservation): string {
  const who = evaluatorLabel(o.evaluator_email)
  const eff = o.effective_designation
  const adjusted = eff !== o.evidence_designation ? ` (adjusted from ${o.evidence_designation})` : ''
  const group = o.origin === 'group' ? ' [group observation]' : ''
  const lines: string[] = []
  lines.push(`Evaluator: ${who}`)
  lines.push(`Score: ${eff}/3${adjusted}${group}`)
  lines.push(`Observation: ${o.text}`)
  if (o.source_excerpt) lines.push(`Excerpt: "${o.source_excerpt}"`)
  return lines.join('\n')
}

export interface DiscrepancyEmailDraft {
  to: string
  subject: string
  body: string
}

/**
 * Render three email drafts for a single discrepancy.
 *
 * Recipients for evaluator emails are determined by the extreme observations:
 * - evaluator A holds the lowest effective_designation among contributing observations
 * - evaluator B holds the highest
 *
 * When a recipient email is missing, the draft still appears (addressed to an empty
 * string) so the chief can fill it in manually; the body is unchanged.
 */
export function renderDiscrepancyEmails(
  d: Discrepancy,
  chiefEmail: string,
  workshopName: string,
): DiscrepancyEmailDraft[] {
  // Sort contributing observations by effective_designation so we can find the extremes.
  const sorted = [...d.observations].sort(
    (a, b) => a.effective_designation - b.effective_designation,
  )
  const loObs = sorted[0]
  const hiObs = sorted[sorted.length - 1]
  const middleObs = sorted.length > 2 ? sorted.slice(1, -1) : []

  const subject = `Score discrepancy: ${d.participant_name}, ${d.area} (${d.ksa_code}) — ${workshopName}`

  // --- 1. Chief email ---
  const chiefLines: string[] = []
  chiefLines.push(`Hi,`)
  chiefLines.push(``)
  chiefLines.push(
    `A scoring discrepancy needs your attention before ${d.participant_name}'s report can be finalized.`,
  )
  chiefLines.push(``)
  chiefLines.push(`Participant: ${d.participant_name}`)
  chiefLines.push(`KSA: ${d.ksa_code} — ${d.area}`)
  chiefLines.push(`Score range: ${d.lo}/3 to ${d.hi}/3 (spread of ${d.hi - d.lo})`)
  chiefLines.push(``)
  if (d.timeGapNote) {
    chiefLines.push(`Note on timing: ${d.timeGapNote}`)
    chiefLines.push(``)
  }
  chiefLines.push(`Evidence:`)
  chiefLines.push(``)
  chiefLines.push(evidenceBlock(loObs))
  chiefLines.push(``)
  chiefLines.push(evidenceBlock(hiObs))
  if (middleObs.length > 0) {
    chiefLines.push(``)
    chiefLines.push(
      `Additional observations (${middleObs.length}): ${middleObs.map((o) => `${evaluatorLabel(o.evaluator_email)} (${o.effective_designation}/3)`).join(', ')}.`,
    )
  }
  chiefLines.push(``)
  chiefLines.push(
    `Please hold a short joint conversation with ${evaluatorLabel(loObs.evaluator_email)} and ${evaluatorLabel(hiObs.evaluator_email)} to reconcile these scores before the report is finalized. Mark the discrepancy as reconciled in the Discrepancy Inbox once that conversation is complete.`,
  )
  chiefLines.push(``)
  chiefLines.push(`Thanks,`)
  chiefLines.push(`Throughline`)

  // --- 2. Evaluator A email (low scorer) ---
  const evalALines: string[] = []
  evalALines.push(`Hi ${evaluatorLabel(loObs.evaluator_email)},`)
  evalALines.push(``)
  evalALines.push(
    `Your score for ${d.participant_name} on ${d.area} (${d.ksa_code}) differs from a colleague's by ${d.hi - d.lo} points. The chief evaluator has flagged this for a brief joint conversation to reconcile before the report is finalized.`,
  )
  evalALines.push(``)
  evalALines.push(`Your observation:`)
  evalALines.push(``)
  evalALines.push(evidenceBlock(loObs))
  evalALines.push(``)
  evalALines.push(`Colleague's observation:`)
  evalALines.push(``)
  evalALines.push(evidenceBlock(hiObs))
  if (d.timeGapNote) {
    evalALines.push(``)
    evalALines.push(`Timing note: ${d.timeGapNote}`)
  }
  evalALines.push(``)
  evalALines.push(
    `The chief evaluator will reach out to schedule a short conversation. No action needed from you until then.`,
  )
  evalALines.push(``)
  evalALines.push(`Thanks,`)
  evalALines.push(`Throughline`)

  // --- 3. Evaluator B email (high scorer) ---
  const evalBLines: string[] = []
  evalBLines.push(`Hi ${evaluatorLabel(hiObs.evaluator_email)},`)
  evalBLines.push(``)
  evalBLines.push(
    `Your score for ${d.participant_name} on ${d.area} (${d.ksa_code}) differs from a colleague's by ${d.hi - d.lo} points. The chief evaluator has flagged this for a brief joint conversation to reconcile before the report is finalized.`,
  )
  evalBLines.push(``)
  evalBLines.push(`Your observation:`)
  evalBLines.push(``)
  evalBLines.push(evidenceBlock(hiObs))
  evalBLines.push(``)
  evalBLines.push(`Colleague's observation:`)
  evalBLines.push(``)
  evalBLines.push(evidenceBlock(loObs))
  if (d.timeGapNote) {
    evalBLines.push(``)
    evalBLines.push(`Timing note: ${d.timeGapNote}`)
  }
  evalBLines.push(``)
  evalBLines.push(
    `The chief evaluator will reach out to schedule a short conversation. No action needed from you until then.`,
  )
  evalBLines.push(``)
  evalBLines.push(`Thanks,`)
  evalBLines.push(`Throughline`)

  return [
    { to: chiefEmail, subject, body: chiefLines.join('\n') },
    { to: loObs.evaluator_email ?? '', subject, body: evalALines.join('\n') },
    { to: hiObs.evaluator_email ?? '', subject, body: evalBLines.join('\n') },
  ]
}
