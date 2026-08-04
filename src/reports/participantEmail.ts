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
import { getActiveScale, isLowTrigger, labelFor, maxValue, type Scale } from '../lib/scale'
import { getActiveTemplates, render, type TemplateSet } from '../templates/resolve'
import { strongestEvidence } from './dayEmail'
import {
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
  /**
   * The workshop's grading scale (tl-09). Defaults to the ACTIVE workshop's,
   * which is right for every in-app caller and wrong for a job that generates
   * documents for a workshop the operator is not currently in — those pass it.
   */
  scale?: Scale
  /**
   * The workshop's authored wording (tl-16). Defaults to the ACTIVE workshop's, on
   * exactly the rule `scale` above states and for the same reason: a job generating
   * documents for a workshop the operator is not currently in must pass this, or it
   * will print one organization's authored sentences into another's email.
   */
  templates?: TemplateSet
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
  const scale = opts.scale ?? getActiveScale()
  const t = opts.templates ?? getActiveTemplates()
  const pid = report.participant_id
  const root = segId(SEGMENT_ID_VERSION, `pe:${slug(pid)}`)
  const maxHighlights = opts.maxHighlights ?? 3
  const out: DocSegment[] = []

  const firstName = report.participant_name.split(' ')[0] || report.participant_name

  push(out, {
    id: segId(root, 'greeting'),
    kind: 'paragraph',
    text: render(t, 'participant_email.greeting', { firstName }),
    participantId: pid,
  })
  endBlock(out)

  const evidenced = report.ksaRollups.filter((k) => k.representative !== null)

  if (evidenced.length === 0) {
    push(out, {
      id: segId(root, 'none'),
      kind: 'paragraph',
      text: render(t, 'participant_email.no-evidence', { dateLabel }),
      participantId: pid,
    })
    endBlock(out)
    if (opts.fromName) {
      push(out, {
        id: segId(root, 'signoff'),
        kind: 'paragraph',
        text: render(t, 'participant_email.signoff', { fromName: opts.fromName }),
      })
    }
    return out
  }

  push(out, {
    id: segId(root, 'intro'),
    kind: 'paragraph',
    text: render(t, 'participant_email.intro', {
      workshopName,
      dateLabel,
      minValue: scale.points[0].value,
      maxValue: maxValue(scale),
    }),
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
      // The `**` is structure and stays here; the words are the template's. An
      // authored body carrying its own asterisks would double them.
      text: `**${render(t, 'participant_email.highlights-heading')}**`,
      participantId: pid,
    })
    for (const k of highlights) {
      const kRoot = segId(root, 'hl', `k:${slug(k.ksa_code)}`)
      const word = labelFor(scale, k.representative)
      push(out, {
        id: segId(kRoot, 'claim'),
        kind: 'bullet',
        text: `- ${render(t, 'participant_email.claim', {
          goalTitle: k.goal_title,
          label: word,
          value: k.representative as number,
          maxValue: maxValue(scale),
        })}`,
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
    .filter((k) => isLowTrigger(scale, k.representative))
    .sort((a, b) => (a.representative ?? 0) - (b.representative ?? 0))

  if (growth.length) {
    push(out, {
      id: segId(root, 'gr', 'h'),
      kind: 'heading',
      level: 4,
      text: `**${render(t, 'participant_email.growth-heading')}**`,
      participantId: pid,
    })
    for (const k of growth) {
      const kRoot = segId(root, 'gr', `k:${slug(k.ksa_code)}`)
      const word = labelFor(scale, k.representative)
      push(out, {
        id: segId(kRoot, 'claim'),
        kind: 'bullet',
        text: `- ${render(t, 'participant_email.claim', {
          goalTitle: k.goal_title,
          label: word,
          value: k.representative as number,
          maxValue: maxValue(scale),
        })}`,
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
    .filter((o) => isLowTrigger(scale, o.effective_designation))
  if (low.length) {
    push(out, {
      id: segId(root, 'fu'),
      kind: 'paragraph',
      text: render(t, 'participant_email.followup'),
      participantId: pid,
      evidence: low.map((o) => o.id),
      note: `Triggered by ${low.length} confirmed observation${low.length === 1 ? '' : 's'} on a point this workshop treats as a growth signal.`,
    })
    endBlock(out)
  }

  const unverified = gate && gate.total > 0 && gate.status !== 'ready'
  if (unverified || opts.statePendingVerification) {
    push(out, {
      id: segId(root, 'gate'),
      kind: 'meta',
      // The italic markers are structure, like the bullet dashes above.
      text: `_${render(t, 'participant_email.gate')}_`,
      participantId: pid,
    })
    endBlock(out)
  }

  if (opts.fromName) {
    push(out, {
      id: segId(root, 'signoff'),
      kind: 'paragraph',
      text: render(t, 'participant_email.signoff', { fromName: opts.fromName }),
    })
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
