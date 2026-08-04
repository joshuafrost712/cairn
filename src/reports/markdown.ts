// Render a ParticipantReport to clean markdown for pasting into a Google Doc or
// sharing with the participant. Formatting follows the vault conventions: no "---"
// dividers, a sentence of body text between heading levels, em dashes used sparingly.
//
// Structure comes out as DocSegments (see segments.ts) so the workbench can put
// the evidence for any one line beside it. renderParticipantReportMarkdown is a
// thin wrapper and its output is unchanged, held there by the golden round-trip
// test in test/reportSegments.test.ts.

import type { ParticipantReport, KsaRollup } from './build'
import type { Gate } from './verification'
import { getActiveScale, labelFor, maxValue, type Scale } from '../lib/scale'
import { getActiveTemplates, render, type TemplateSet } from '../templates/resolve'
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
  type EvidenceObservation,
} from './segments'

function designationLine(r: KsaRollup, scale: Scale): string {
  if (r.representative === null) return 'No evidence recorded yet.'
  const word = labelFor(scale, r.representative)
  const spread =
    r.designations.length > 1 ? ` (recorded evidence ranged ${r.designations[0]}–${r.designations[r.designations.length - 1]})` : ''
  const conflict = r.conflict ? ' This KSA shows conflicting evidence and should be reviewed before it is finalized.' : ''
  return `**Designation: ${r.representative}/${maxValue(scale)} (${word}).**${spread}${conflict}`
}

/** Build the participant report as segments. */
export function buildParticipantReportSegments(
  report: ParticipantReport<EvidenceObservation>,
  workshopName: string,
  generatedOn: string,
  gate?: Gate,
  // Resolved once, here, and passed down. A helper reaching for the active
  // workshop's scale instead would print one workshop's words on another's
  // numbers the first time somebody generated a report while switched away.
  scale: Scale = getActiveScale(),
  // Resolved once and passed down like `scale` above, and defaulting the same way.
  // A caller rendering a report for a workshop the operator is not currently in must
  // pass both, or it prints one organization's words on another's numbers (tl-16).
  templates: TemplateSet = getActiveTemplates(),
): DocSegment[] {
  const t = templates
  const pid = report.participant_id
  const root = segId(SEGMENT_ID_VERSION, `pr:${slug(pid)}`)
  const out: DocSegment[] = []

  push(out, {
    id: segId(root, 'title'),
    kind: 'heading',
    level: 1,
    text: `# ${render(t, 'participant_report.title', { participantName: report.participant_name })}`,
    participantId: pid,
  })
  endBlock(out)

  const teamBit = report.team_name ? `, ${report.team_name}` : ''
  push(out, {
    id: segId(root, 'intro'),
    kind: 'paragraph',
    text: render(t, 'participant_report.intro', {
      workshopName,
      teamBit,
      generatedOn,
      minValue: scale.points[0].value,
      maxValue: maxValue(scale),
    }),
    participantId: pid,
  })
  endBlock(out)

  if (gate) {
    const verdict =
      gate.status === 'ready'
        ? render(t, 'participant_report.gate-ready', {
            total: gate.total,
            required: gate.required,
          })
        : render(t, 'participant_report.gate-locked', {
            verified: gate.verified,
            total: gate.total,
            required: gate.required,
            // Two optional clauses arrive as one already-worded fragment rather than
            // as two more tokens, because a template that had to spell both
            // conditionals would need a conditional syntax, and a conditional syntax
            // is the point at which an authored template becomes a program.
            extra: `${gate.pending ? `, ${gate.pending} pending` : ''}${gate.disputed ? `, ${gate.disputed} disputed` : ''}`,
          })
    push(out, {
      id: segId(root, 'gate'),
      kind: 'meta',
      text: `**Verification status.** ${verdict}`,
      participantId: pid,
    })
    endBlock(out)
  }

  push(out, {
    id: segId(root, 'totals'),
    kind: 'paragraph',
    text: render(t, 'participant_report.totals', {
      evidenced: report.totals.evidencedKsas,
      total: report.totals.totalKsas,
      reviewBit: report.totals.needsReviewCount
        ? `, with ${report.totals.needsReviewCount} item(s) flagged for review`
        : '',
    }),
    participantId: pid,
  })
  endBlock(out)

  push(out, {
    id: segId(root, 'ev', 'h'),
    kind: 'heading',
    level: 2,
    text: `## ${render(t, 'participant_report.evidence-heading')}`,
    participantId: pid,
  })
  endBlock(out)

  const evidenced = report.ksaRollups.filter((r) => r.representative !== null)
  const unevidenced = report.ksaRollups.filter((r) => r.representative === null)

  if (evidenced.length === 0) {
    push(out, {
      id: segId(root, 'ev', 'none'),
      kind: 'paragraph',
      text: render(t, 'participant_report.evidence-none'),
      participantId: pid,
    })
    endBlock(out)
  }

  for (const r of evidenced) {
    const kRoot = segId(root, 'ev', `k:${slug(r.ksa_code)}`)
    push(out, {
      id: segId(kRoot, 'h'),
      kind: 'heading',
      level: 3,
      text: `### ${r.ksa_code}: ${r.goal_title}`,
      participantId: pid,
      ksaCode: r.ksa_code,
    })
    endBlock(out)
    push(out, {
      id: segId(kRoot, 'claim'),
      kind: 'paragraph',
      text: designationLine(r, scale),
      participantId: pid,
      ksaCode: r.ksa_code,
      evidence: claimEvidence(r),
      note: derivationNote(r),
    })
    endBlock(out)
    for (const o of r.contributing) {
      out.push(
        evidenceSegment(o, {
          id: segId(kRoot, `ev:${slug(o.id)}`),
          participantId: pid,
          ksaCode: r.ksa_code,
        }),
      )
    }
    endBlock(out)
  }

  if (unevidenced.length) {
    push(out, {
      id: segId(root, 'gap', 'h'),
      kind: 'heading',
      level: 3,
      text: `### ${render(t, 'participant_report.unevidenced-heading')}`,
      participantId: pid,
    })
    endBlock(out)
    push(out, {
      id: segId(root, 'gap', 'list'),
      kind: 'paragraph',
      text: render(t, 'participant_report.unevidenced-list', {
        areas: unevidenced.map((r) => `${r.ksa_code} (${r.goal_title})`).join('; '),
      }),
      participantId: pid,
    })
    endBlock(out)
  }

  const flagged = report.ksaRollups.flatMap((r) => r.toVerify.map((o) => ({ code: r.ksa_code, o })))
  if (flagged.length) {
    push(out, {
      id: segId(root, 'flag', 'h'),
      kind: 'heading',
      level: 2,
      text: `## ${render(t, 'participant_report.flagged-heading')}`,
      participantId: pid,
    })
    endBlock(out)
    push(out, {
      id: segId(root, 'flag', 'intro'),
      kind: 'paragraph',
      text: render(t, 'participant_report.flagged-intro'),
      participantId: pid,
    })
    endBlock(out)
    for (const { code, o } of flagged) {
      const head = `- **${code}**: ${o.text} (${o.confidence} confidence)`
      push(out, {
        id: segId(root, 'flag', `ev:${slug(o.id)}`),
        kind: 'evidence',
        text: o.source_excerpt ? `${head}\n  > "${o.source_excerpt}"` : head,
        participantId: pid,
        ksaCode: code,
        evidence: [o.id],
      })
    }
    endBlock(out)
  }

  push(out, {
    id: segId(root, 'cbc', 'h'),
    kind: 'heading',
    level: 2,
    text: `## ${render(t, 'participant_report.cbc-heading')}`,
    participantId: pid,
  })
  endBlock(out)
  push(out, {
    id: segId(root, 'cbc', 'intro'),
    kind: 'paragraph',
    text: render(t, 'participant_report.cbc-intro'),
    participantId: pid,
  })
  endBlock(out)

  // A CBC bullet asserts several KSA representatives at once, so it carries the
  // union of the evidence behind them. Clicking it should show why every number
  // on the line is what it is, not just the first.
  const byCode = new Map(report.ksaRollups.map((r) => [r.ksa_code, r]))
  for (const c of report.cbc) {
    const parts = c.entries.map((e) => `${e.ksa_code} ${e.representative === null ? '(no evidence)' : `${e.representative}/${maxValue(scale)}`}`)
    push(out, {
      id: segId(root, 'cbc', `s:${slug(c.subpoint)}`),
      kind: 'bullet',
      text: `- **${c.subpoint}**: ${parts.join(', ')}`,
      participantId: pid,
      evidence: c.entries.flatMap((e) => {
        const r = byCode.get(e.ksa_code)
        return r ? claimEvidence(r) : []
      }),
    })
  }
  endBlock(out)

  return out
}

/** The same document as markdown. Kept as the stable public entry point. */
export function renderParticipantReportMarkdown(
  report: ParticipantReport<EvidenceObservation>,
  workshopName: string,
  generatedOn: string,
  gate?: Gate,
  scale?: Scale,
  templates?: TemplateSet,
): string {
  return segmentsToMarkdown(
    buildParticipantReportSegments(
      report,
      workshopName,
      generatedOn,
      gate,
      scale ?? getActiveScale(),
      templates ?? getActiveTemplates(),
    ),
  )
}
