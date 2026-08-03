// The per-participant evaluation email: what the participant themselves receives.
//
// Same evidence and the same rollup as the day email, addressed differently. Two
// differences from the internal document are deliberate rather than cosmetic:
//
//   - Second person throughout. "Strong work on Genre Theory" is a note about
//     someone; "You named the genre and defended it" is a note to them.
//   - Evidence bullets do NOT name the evaluator. The quote is what the
//     participant needs (it is the reason the designation is what it is);
//     knowing which colleague wrote it turns a piece of feedback into an
//     attribution to argue with. Attribution stays fully visible in the admin's
//     evidence pane, which is where it belongs.
//
// Formatting follows the vault conventions: no "---" dividers, a sentence of
// body between heading levels, em dashes used sparingly.

import type { ParticipantReport } from './build'
import type { AnnotatedObservation, Gate } from './verification'
import { strongestEvidence } from './dayEmail'
import {
  LEVEL_WORD,
  MENTORING_THRESHOLD,
  SEGMENT_ID_VERSION,
  claimEvidence,
  derivationNote,
  endBlock,
  evidenceSegment,
  push,
  segId,
  segmentsToMarkdown,
  slug,
  type DocSegment,
} from './segments'

export interface ParticipantEmailOptions {
  /** Who the email is from, shown in the sign-off. */
  fromName?: string
  /** How many highlights to include. Three is enough to be encouraging without being a list. */
  maxHighlights?: number
  /**
   * Include the verification caveat even when the gate is clear.
   *
   * Off by default: a cleared gate needs no sentence. Turned on by the approval
   * flow when an admin overrides a locked gate to send anyway, so the document
   * itself says it went out unverified.
   */
  statePendingVerification?: boolean
}

/**
 * Build a participant's evaluation email as segments.
 *
 * Returns an empty document (just the greeting and sign-off) rather than
 * throwing when there is no evidence: an empty workshop day is a real state and
 * the caller decides whether to send it, but nothing here should invent content
 * to fill the gap.
 */
export function buildParticipantEmailSegments(
  report: ParticipantReport<AnnotatedObservation>,
  gate: Gate | undefined,
  workshopName: string,
  dateLabel: string,
  opts: ParticipantEmailOptions = {},
): DocSegment[] {
  const pid = report.participant_id
  const root = segId(SEGMENT_ID_VERSION, `pe:${slug(pid)}`)
  const maxHighlights = opts.maxHighlights ?? 3
  const out: DocSegment[] = []

  const firstName = report.participant_name.split(' ')[0] || report.participant_name

  push(out, {
    id: segId(root, 'greeting'),
    kind: 'paragraph',
    text: `Hi ${firstName},`,
    participantId: pid,
  })
  endBlock(out)

  const evidenced = report.ksaRollups.filter((k) => k.representative !== null)

  if (evidenced.length === 0) {
    push(out, {
      id: segId(root, 'none'),
      kind: 'paragraph',
      text: `We did not record observations for you on ${dateLabel}. That is not a judgment about your work; it means none of the facilitators wrote notes covering you today.`,
      participantId: pid,
    })
    endBlock(out)
    if (opts.fromName) {
      push(out, { id: segId(root, 'signoff'), kind: 'paragraph', text: `Thanks,\n${opts.fromName}` })
    }
    return out
  }

  push(out, {
    id: segId(root, 'intro'),
    kind: 'paragraph',
    text: `Here is what the facilitators noted about your work at ${workshopName} on ${dateLabel}. The 0–3 numbers are draft designations against the competency areas, and each one is followed by the evidence it came from so you can see exactly what it is based on. Treat them as a read on one day's work, not a final assessment.`,
    participantId: pid,
  })
  endBlock(out)

  const highlights = evidenced
    .filter((k) => (k.representative ?? 0) >= 2)
    .sort((a, b) => (b.representative ?? 0) - (a.representative ?? 0))
    .slice(0, maxHighlights)

  if (highlights.length) {
    push(out, {
      id: segId(root, 'hl', 'h'),
      kind: 'heading',
      level: 4,
      text: '**What went well**',
      participantId: pid,
    })
    for (const k of highlights) {
      const kRoot = segId(root, 'hl', `k:${slug(k.ksa_code)}`)
      const word = LEVEL_WORD[k.representative ?? 0] ?? ''
      push(out, {
        id: segId(kRoot, 'claim'),
        kind: 'bullet',
        text: `- ${k.goal_title}: ${word} (${k.representative}/3).`,
        participantId: pid,
        ksaCode: k.ksa_code,
        evidence: claimEvidence(k),
        note: derivationNote(k),
      })
      const best = strongestEvidence(k)
      if (best) {
        out.push(
          evidenceSegment(best, {
            id: segId(kRoot, `ev:${slug(best.id)}`),
            indent: '  ',
            showEvaluator: false,
            participantId: pid,
            ksaCode: k.ksa_code,
          }),
        )
      }
    }
    endBlock(out)
  }

  const growth = evidenced
    .filter((k) => (k.representative ?? 0) <= MENTORING_THRESHOLD)
    .sort((a, b) => (a.representative ?? 0) - (b.representative ?? 0))

  if (growth.length) {
    push(out, {
      id: segId(root, 'gr', 'h'),
      kind: 'heading',
      level: 4,
      text: '**Where to keep working**',
      participantId: pid,
    })
    for (const k of growth) {
      const kRoot = segId(root, 'gr', `k:${slug(k.ksa_code)}`)
      const word = LEVEL_WORD[k.representative ?? 0] ?? ''
      push(out, {
        id: segId(kRoot, 'claim'),
        kind: 'bullet',
        text: `- ${k.goal_title}: ${word} (${k.representative}/3).`,
        participantId: pid,
        ksaCode: k.ksa_code,
        evidence: claimEvidence(k),
        note: derivationNote(k),
      })
      const best = strongestEvidence(k)
      if (best) {
        out.push(
          evidenceSegment(best, {
            id: segId(kRoot, `ev:${slug(best.id)}`),
            indent: '  ',
            showEvaluator: false,
            participantId: pid,
            ksaCode: k.ksa_code,
          }),
        )
      }
    }
    endBlock(out)
  }

  // A conflict is not the participant's problem to solve, and telling them their
  // evaluators disagreed invites them to litigate it. It stays in the internal
  // documents. What DOES belong here is the caveat that the numbers are not
  // final, which the intro already says and the gate line reinforces below.
  const low = evidenced
    .flatMap((k) => k.contributing)
    .filter((o) => o.effective_designation <= MENTORING_THRESHOLD)
  if (low.length) {
    push(out, {
      id: segId(root, 'fu'),
      kind: 'paragraph',
      text: 'One of us will find you for a short conversation about the area above. It is a working conversation, not a review: the aim is to agree what to try next.',
      participantId: pid,
      evidence: low.map((o) => o.id),
      note: `Triggered by ${low.length} confirmed observation${low.length === 1 ? '' : 's'} at or below ${MENTORING_THRESHOLD}/3.`,
    })
    endBlock(out)
  }

  const unverified = gate && gate.total > 0 && gate.status !== 'ready'
  if (unverified || opts.statePendingVerification) {
    push(out, {
      id: segId(root, 'gate'),
      kind: 'meta',
      text: '_These designations are still being confirmed by a second facilitator, so any of them may change._',
      participantId: pid,
    })
    endBlock(out)
  }

  if (opts.fromName) {
    push(out, { id: segId(root, 'signoff'), kind: 'paragraph', text: `Thanks,\n${opts.fromName}` })
  }
  return out
}

/** The same document as markdown. */
export function renderParticipantEmailMarkdown(
  report: ParticipantReport<AnnotatedObservation>,
  gate: Gate | undefined,
  workshopName: string,
  dateLabel: string,
  opts: ParticipantEmailOptions = {},
): string {
  return segmentsToMarkdown(buildParticipantEmailSegments(report, gate, workshopName, dateLabel, opts))
}

/** Subject line for the email. Kept beside the body so the two cannot drift. */
export function participantEmailSubject(workshopName: string, dateLabel: string): string {
  return `${workshopName}: your evaluation notes for ${dateLabel}`
}
