// Draft persistence: the one place the pure draft layer meets Dexie.
//
// Follows the src/db/mentoring.ts idiom: deterministic ids, an idempotent
// reconcile that can be re-run at any moment, and no destructive overwrite of a
// row a human has touched.

import { db, newId } from './local'
import { buildAllReports } from '../reports/build'
import { annotateObservations, participantGate, type Gate } from '../reports/verification'
import {
  allActivityAnalytics,
  buildCaptureIndex,
  situate,
} from '../reports/analytics'
import { buildParticipantEmailSegments, participantEmailSubject } from '../reports/participantEmail'
import {
  buildEventDigestSegments,
  conversationsForEvent,
  eventDigestSubject,
} from '../reports/eventDigest'
import { mergeDraft } from '../drafts/merge'
import { draftId, superseding } from '../drafts/state'
import type { DraftDoc, DraftRecipient, ApprovedEvidence } from '../drafts/types'
import type { DocSegment } from '../reports/segments'

const EMPTY_MERGE = { overrides: [], orphans: [] }

/**
 * Write a regenerated document into the store without losing edits.
 *
 * Idempotent by construction: the id is derived from kind, subject, date and
 * revision, so regenerating the same evening's email updates the same row.
 *
 * The one branch that matters: if the current row is already approved, this does
 * NOT touch it. It writes a successor revision and marks the old one superseded,
 * so the approved artifact and its snapshot stay exactly as the approver saw
 * them.
 */
async function upsertDraft(fresh: Omit<DraftDoc, 'overrides' | 'orphans' | 'flags'>): Promise<DraftDoc> {
  const existing = await db.docDrafts.get(fresh.id)

  if (!existing) {
    const row: DraftDoc = { ...fresh, overrides: [], orphans: [], flags: [] }
    await db.docDrafts.put(row)
    return row
  }

  const merged = mergeDraft(existing, fresh.segments)

  if (existing.status === 'draft') {
    const row: DraftDoc = {
      ...existing,
      ...fresh,
      // Merge output wins over both: it is the reconciliation of the two.
      segments: merged.segments,
      overrides: merged.overrides,
      orphans: merged.orphans,
      flags: merged.flags,
      // Preserve the human's decisions on this row.
      recipients: existing.recipients,
      gateOverride: existing.gateOverride,
      gateOverrideReason: existing.gateOverrideReason,
      revision: existing.revision,
      id: existing.id,
    }
    await db.docDrafts.put(row)
    return row
  }

  // Approved, sending, sent, or superseded: leave it alone and make a successor.
  const next = superseding(existing, merged, fresh.generatedAt)
  const alreadyThere = await db.docDrafts.get(next.id)
  if (alreadyThere) return alreadyThere

  await db.transaction('rw', db.docDrafts, async () => {
    if (existing.status !== 'sent' && existing.status !== 'sending') {
      await db.docDrafts.update(existing.id, { status: 'superseded' })
    }
    await db.docDrafts.put(next)
  })
  return next
}

export interface GenerateOptions {
  /** ISO timestamp; passed in so callers (and tests) control the clock. */
  now: string
  /** The day this batch is for, e.g. '2026-08-26'. Part of the draft id. */
  dateLabel: string
  fromName?: string
}

/**
 * Generate (or refresh) one participant email per participant with evidence.
 *
 * Participants with no observations are skipped rather than sent an empty note.
 * A participant with no registered email still gets a draft: the missing address
 * is an approval blocker the admin can see and fix on the roster, whereas
 * silently omitting them means nobody notices until after the workshop.
 */
export async function generateParticipantEmails(opts: GenerateOptions): Promise<DraftDoc[]> {
  const [participants, ksas, teams, observations, verdicts, workshops] = await Promise.all([
    db.participants.toArray(),
    db.ksas.toArray(),
    db.teams.toArray(),
    db.observations.toArray(),
    db.verifications.toArray(),
    db.workshops.toArray(),
  ])

  const workshop = workshops[0] ?? null
  const workshopName = workshop?.name ?? 'Workshop'
  const sortedKsas = [...ksas].sort((a, b) => a.code.localeCompare(b.code))
  const annotated = annotateObservations(observations, verdicts)
  const reports = buildAllReports(participants, sortedKsas, annotated, teams)

  const out: DraftDoc[] = []
  for (const report of reports) {
    if (report.totals.evidencedKsas === 0) continue
    const person = participants.find((p) => p.id === report.participant_id)
    const gate = participantGate(annotated.filter((o) => o.participant_id === report.participant_id))
    const segments = buildParticipantEmailSegments(report, gate, workshopName, opts.dateLabel, {
      fromName: opts.fromName,
    })

    out.push(
      await upsertDraft({
        id: draftId('participant_email', report.participant_id, opts.dateLabel, 1),
        kind: 'participant_email',
        subjectKey: report.participant_id,
        workshopId: workshop?.id ?? null,
        title: report.participant_name,
        subject: participantEmailSubject(workshopName, opts.dateLabel),
        dateLabel: opts.dateLabel,
        revision: 1,
        supersedes: null,
        fanout: 'per-recipient',
        recipients: [recipient(person?.registered_email ?? '', report.participant_name)],
        segments,
        status: 'draft',
        gateOverride: false,
        gateOverrideReason: null,
        generatedAt: opts.now,
        updatedAt: opts.now,
        approvedBy: null,
        approvedAt: null,
        approvedSnapshot: null,
      }),
    )
  }
  return out
}

export interface DigestOptions extends GenerateOptions {
  /** The facilitator team. Passed in because it is not in the data model yet. */
  facilitators: { email: string; name?: string }[]
  /** Only these activities; omit for every activity on `dateLabel`. */
  activityIds?: string[]
}

/** Generate (or refresh) one facilitator digest per event. */
export async function generateEventDigests(opts: DigestOptions): Promise<DraftDoc[]> {
  const [activities, ksas, observations, verdicts, evaluations, conversations, workshops] =
    await Promise.all([
      db.activities.toArray(),
      db.ksas.toArray(),
      db.observations.toArray(),
      db.verifications.toArray(),
      db.evaluations.toArray(),
      db.mentoringConversations.toArray(),
      db.workshops.toArray(),
    ])

  const workshop = workshops[0] ?? null
  const sortedKsas = [...ksas].sort((a, b) => a.code.localeCompare(b.code))
  const annotated = annotateObservations(observations, verdicts)
  const index = buildCaptureIndex(evaluations)
  const situated = situate(annotated, index)

  const wanted = opts.activityIds
    ? activities.filter((a) => opts.activityIds!.includes(a.id))
    : activities.filter((a) => a.day === opts.dateLabel)

  const analytics = allActivityAnalytics(wanted, sortedKsas, situated, evaluations)

  // The fallback join for a conversation whose activity was never stamped.
  const obsToActivity = new Map(situated.map((o) => [o.id, o.activity_id]))

  const out: DraftDoc[] = []
  for (const a of analytics) {
    const convs = conversationsForEvent(a, conversations, obsToActivity)
    const segments = buildEventDigestSegments(a, convs, { fromName: opts.fromName })

    out.push(
      await upsertDraft({
        id: draftId('event_digest', a.activity_id, opts.dateLabel, 1),
        kind: 'event_digest',
        subjectKey: a.activity_id,
        workshopId: workshop?.id ?? null,
        title: a.title,
        subject: eventDigestSubject(a),
        dateLabel: opts.dateLabel,
        revision: 1,
        supersedes: null,
        // One message to the whole team, not one each: this is the difference
        // between a team email and 6 identical copies in everybody's inbox.
        fanout: 'single',
        recipients: opts.facilitators.map((f) => recipient(f.email, f.name ?? null)),
        segments,
        status: 'draft',
        gateOverride: false,
        gateOverrideReason: null,
        generatedAt: opts.now,
        updatedAt: opts.now,
        approvedBy: null,
        approvedAt: null,
        approvedSnapshot: null,
      }),
    )
  }
  return out
}

function recipient(email: string, name: string | null): DraftRecipient {
  return { email, name, status: 'pending', at: null, error: null }
}

/**
 * Resolve every observation a document cites, as it stands right now.
 *
 * `present: false` rather than omission when an observation has been deleted: a
 * snapshot that quietly dropped a missing citation would make the approved
 * document look better evidenced than it was.
 */
export async function resolveSnapshotEvidence(segments: DocSegment[]): Promise<ApprovedEvidence[]> {
  const ids = [...new Set(segments.flatMap((s) => s.evidence))]
  if (ids.length === 0) return []

  const [rows, verdicts] = await Promise.all([
    db.observations.bulkGet(ids),
    db.verifications.where('observation_id').anyOf(ids).toArray(),
  ])
  const annotated = annotateObservations(rows.filter((r) => r !== undefined), verdicts)
  const byId = new Map(annotated.map((o) => [o.id, o]))

  return ids.map((id) => {
    const o = byId.get(id)
    if (!o) {
      return {
        observation_id: id,
        present: false,
        text: null,
        source_excerpt: null,
        evaluator_email: null,
        evidence_designation: null,
        effective_designation: null,
        vstatus: null,
        verdicts: [],
      }
    }
    return {
      observation_id: id,
      present: true,
      text: o.text,
      source_excerpt: o.source_excerpt,
      evaluator_email: o.evaluator_email ?? null,
      evidence_designation: o.evidence_designation,
      effective_designation: o.effective_designation,
      vstatus: o.vstatus,
      verdicts: o.verdicts.map((v) => ({
        evaluator_email: v.evaluator_email,
        decision: v.decision,
        adjusted_designation: v.adjusted_designation ?? null,
        at: v.at,
      })),
    }
  })
}

/** The gate for a draft's subject, or undefined for documents without one. */
export async function gateForDraft(draft: DraftDoc): Promise<Gate | undefined> {
  if (draft.kind === 'event_digest') return undefined
  const [observations, verdicts] = await Promise.all([
    db.observations.where('participant_id').equals(draft.subjectKey).toArray(),
    db.verifications.toArray(),
  ])
  return participantGate(annotateObservations(observations, verdicts))
}

export async function saveDraft(draft: DraftDoc): Promise<void> {
  await db.docDrafts.put(draft)
}

export async function deleteDraft(id: string): Promise<void> {
  await db.docDrafts.delete(id)
}

/** Only ever used for a hand-made draft; generated ones use the deterministic id. */
export function adHocDraftId(): string {
  return `draft::${newId()}`
}

export { EMPTY_MERGE }
