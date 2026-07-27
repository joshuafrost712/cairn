// Turning a segment's observation ids into what the evidence pane shows.
//
// Pure, so it can be tested without a DOM. What it deliberately does NOT do is
// synthesize, summarize, or justify. Joshua's brief was explicit: clicking a
// line should route you to the evidence that fed it, not to a model's account of
// why the line says what it says. Every field below is a value read off a record.

import type { Activity, EvaluationRecord } from '../lib/types'
import type { AnnotatedObservation } from '../reports/verification'

export interface VerdictView {
  evaluator: string
  decision: string
  adjustedTo: number | null
  at: string
}

export interface EvidenceView {
  observationId: string
  /** False when the observation has been deleted since the document was built. */
  present: boolean
  text: string | null
  excerpt: string | null
  evaluator: string | null
  designation: number | null
  /** Set when a verdict moved the designation, so the pane can say "adjusted from 1". */
  adjustedFrom: number | null
  status: string | null
  needsReview: boolean
  origin: string | null
  /** Null when the capture is not on this device. The card says so. */
  activityTitle: string | null
  capturedAt: string | null
  verdicts: VerdictView[]
  /** Deep link into the correction surface. */
  recordsHref: string | null
}

export interface EvidenceContext {
  observations: Map<string, AnnotatedObservation>
  /** capture_client_id -> EvaluationRecord */
  captures: Map<string, EvaluationRecord>
  /** activity id -> Activity */
  activities: Map<string, Activity>
}

export function buildEvidenceContext(
  observations: AnnotatedObservation[],
  evaluations: EvaluationRecord[],
  activities: Activity[],
): EvidenceContext {
  return {
    observations: new Map(observations.map((o) => [o.id, o])),
    captures: new Map(evaluations.map((e) => [e.client_id, e])),
    activities: new Map(activities.map((a) => [a.id, a])),
  }
}

/**
 * Resolve one observation id.
 *
 * A missing observation returns a row rather than nothing. Dropping it would
 * make a claim look like it rested on three observations when the document was
 * built on four, and the reader would have no way to notice.
 */
export function resolveOne(id: string, ctx: EvidenceContext): EvidenceView {
  const o = ctx.observations.get(id)
  if (!o) {
    return {
      observationId: id,
      present: false,
      text: null,
      excerpt: null,
      evaluator: null,
      designation: null,
      adjustedFrom: null,
      status: null,
      needsReview: false,
      origin: null,
      activityTitle: null,
      capturedAt: null,
      verdicts: [],
      recordsHref: null,
    }
  }

  const capture = ctx.captures.get(o.capture_client_id)
  const activity = capture?.activity_id ? ctx.activities.get(capture.activity_id) : undefined

  return {
    observationId: id,
    present: true,
    text: o.text,
    excerpt: o.source_excerpt,
    // Fall back to the capture's evaluator: observation.evaluator_email is
    // best-effort and often null on rows that arrived through routing.
    evaluator: o.evaluator_email ?? capture?.evaluator_email ?? null,
    designation: o.effective_designation,
    adjustedFrom:
      o.effective_designation !== o.evidence_designation ? o.evidence_designation : null,
    status: o.vstatus,
    needsReview: o.needs_review,
    origin: o.origin,
    activityTitle: activity?.title ?? null,
    capturedAt: capture?.created_at ?? null,
    verdicts: o.verdicts.map((v) => ({
      evaluator: v.evaluator_email,
      decision: v.decision,
      adjustedTo: v.adjusted_designation ?? null,
      at: v.at,
    })),
    recordsHref: o.participant_id ? `/admin/records?participant=${encodeURIComponent(o.participant_id)}` : null,
  }
}

/** Resolve a segment's whole evidence list, in the order the segment named it. */
export function resolveEvidence(ids: string[], ctx: EvidenceContext): EvidenceView[] {
  return ids.map((id) => resolveOne(id, ctx))
}

/** A one-line summary for the pane header: "3 observations, 1 no longer on this device". */
export function evidenceSummary(views: EvidenceView[]): string {
  if (views.length === 0) return 'No evidence behind this line.'
  const missing = views.filter((v) => !v.present).length
  const n = views.length
  const head = `${n} observation${n === 1 ? '' : 's'}`
  return missing ? `${head}, ${missing} no longer on this device` : head
}
