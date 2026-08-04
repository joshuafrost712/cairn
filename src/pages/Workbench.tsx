import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { gateForDraft, resolveSnapshotEvidence, saveDraft } from '../db/drafts'
import { annotateObservations } from '../reports/verification'
import { segmentsToMarkdown } from '../reports/segments'
import { applyOverrides, makeOverride, revertOverride } from '../drafts/merge'
import {
  approvalBlockers,
  approveDraft,
  isEditable,
  overrideGate,
  templatesMoved,
  unapproveDraft,
} from '../drafts/state'
import { templatesForWorkshop } from '../db/templates'
import { templateFingerprint } from '../templates/resolve'
import { buildEvidenceContext } from '../workbench/evidenceView'
import { PageHeader } from '../layout/PageHeader'
import { DocumentPane } from '../components/workbench/DocumentPane'
import { EvidencePane } from '../components/workbench/EvidencePane'
import { ApprovalBar } from '../components/workbench/ApprovalBar'
import { StaleBanner } from '../components/workbench/StaleBanner'
import { SendQueue } from '../components/workbench/SendQueue'
import { EmptyState } from '../components/data/EmptyState'
import { Drawer } from '../components/data/Drawer'
import type { Gate } from '../reports/verification'
import type { Activity, EvaluationRecord, ObservationRecord, VerificationVerdict } from '../lib/types'

/**
 * Review one document against its evidence, edit it, approve it.
 *
 * Two panes at 900px and up. Below that the evidence moves into a bottom sheet,
 * because the alternative on a phone is a column of quotes shoved between the
 * lines they belong to, which makes the document unreadable to save a tap.
 */
export function Workbench() {
  const { draftId } = useParams()
  const id = draftId ? decodeURIComponent(draftId) : ''
  const { identity } = useAuth()

  const draft = useLiveQuery(() => db.docDrafts.get(id), [id])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])
  const evaluations = useLiveQuery(() => db.evaluations.toArray(), [], [] as EvaluationRecord[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [gate, setGate] = useState<Gate | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // tl-16. Resolved for the DRAFT's workshop rather than the active one, because a
  // document is reviewed long after it was generated and the operator may have
  // switched away by then; comparing against another workshop's fingerprint would
  // report drift on every draft in the queue.
  const [currentTemplates, setCurrentTemplates] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!draft) return
    void templatesForWorkshop(draft.workshopId).then((set) => {
      if (!cancelled) setCurrentTemplates(templateFingerprint(set))
    })
    return () => {
      cancelled = true
    }
  }, [draft])

  // The gate is a query, not a subscription: it is read at approval time and
  // shown as context. A live one would let the Approve button flicker between
  // enabled and disabled while somebody else's verdicts sync in.
  useEffect(() => {
    let cancelled = false
    if (!draft) return
    void gateForDraft(draft).then((g) => {
      if (!cancelled) setGate(g)
    })
    return () => {
      cancelled = true
    }
  }, [draft])

  const ctx = useMemo(
    () =>
      buildEvidenceContext(
        annotateObservations(observations ?? [], verdicts ?? []),
        evaluations ?? [],
        activities ?? [],
      ),
    [observations, verdicts, evaluations, activities],
  )

  const selected = draft?.segments.find((s) => s.id === selectedId) ?? null
  const blockers = draft ? approvalBlockers(draft, { gate }) : []
  const gateBlocked = blockers.some((b) => b.startsWith('Not verified'))
  const editable = draft ? isEditable(draft.status) : false

  if (draft === undefined) return <p className="muted small">Loading…</p>

  if (!draft) {
    return (
      <>
        <PageHeader title="Draft not found" crumbs={[{ label: 'Outgoing', to: '/outgoing' }]} />
        <EmptyState title="This draft is not on this device">
          <Link to="/outgoing">Back to the queue</Link>
        </EmptyState>
      </>
    )
  }

  const mutate = async (next: typeof draft) => {
    setBusy(true)
    setErr(null)
    try {
      await saveDraft({ ...next, updatedAt: new Date().toISOString() })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commit = async (segmentId: string, text: string) => {
    const seg = draft.segments.find((s) => s.id === segmentId)
    if (!seg) return
    setEditingId(null)
    // Committing the generated text unchanged is not an edit. Recording one
    // would put a permanent "edited" mark on a line nobody touched, and would
    // start flagging it stale on every future regeneration.
    if (text === seg.text) {
      await mutate({ ...draft, overrides: revertOverride(draft.overrides, segmentId) })
      return
    }
    const ov = makeOverride(seg, text, new Date().toISOString(), identity?.email ?? null)
    await mutate({
      ...draft,
      overrides: [...revertOverride(draft.overrides, segmentId), ov],
      // Editing a line IS reviewing it, so its stale flag is answered.
      flags: draft.flags.filter((f) => f.segmentId !== segmentId),
    })
  }

  const remove = async (segmentId: string) => {
    const seg = draft.segments.find((s) => s.id === segmentId)
    if (!seg) return
    const ov = makeOverride(seg, null, new Date().toISOString(), identity?.email ?? null)
    await mutate({ ...draft, overrides: [...revertOverride(draft.overrides, segmentId), ov] })
  }

  const restore = async (segmentId: string) => {
    await mutate({ ...draft, overrides: revertOverride(draft.overrides, segmentId) })
  }

  const approve = async () => {
    setBusy(true)
    setErr(null)
    try {
      const evidence = await resolveSnapshotEvidence(draft.segments)
      const approved = approveDraft(
        draft,
        { by: identity?.email ?? null, at: new Date().toISOString(), snapshotEvidence: evidence },
        { gate },
      )
      await saveDraft(approved)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const finalText = segmentsToMarkdown(applyOverrides(draft.segments, draft.overrides))

  return (
    <>
      <PageHeader
        title={draft.title}
        crumbs={[
          { label: 'Workbench' },
          { label: 'Outgoing', to: '/outgoing' },
          { label: draft.title },
        ]}
        meta={`${draft.subject} · ${draft.recipients.map((r) => r.email || 'no address').join(', ')}`}
      />

      {err && <div className="banner warn">{err}</div>}

      <StaleBanner
        draft={draft}
        templatesMoved={currentTemplates !== null && templatesMoved(draft, currentTemplates)}
        onGoTo={(sid) => {
          setSelectedId(sid)
          setDrawerOpen(true)
        }}
        onDiscardOrphan={(sid) =>
          mutate({ ...draft, orphans: draft.orphans.filter((o) => o.segmentId !== sid) })
        }
      />

      <div className="wb">
        <div>
          <DocumentPane
            segments={draft.segments}
            overrides={draft.overrides}
            flags={draft.flags}
            selectedId={selectedId}
            editingId={editingId}
            editable={editable}
            onSelect={(sid) => {
              setSelectedId(sid)
              setDrawerOpen(true)
            }}
            onStartEdit={setEditingId}
            onCommit={commit}
            onCancelEdit={() => setEditingId(null)}
            onDelete={remove}
            onRestore={restore}
          />

          <ApprovalBar
            draft={draft}
            blockers={blockers}
            gateBlocked={gateBlocked}
            busy={busy}
            onApprove={approve}
            onOverrideGate={(reason) =>
              mutate(overrideGate(draft, reason, new Date().toISOString()))
            }
            onReopen={async () => {
              try {
                await saveDraft(unapproveDraft(draft, new Date().toISOString()))
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              }
            }}
          />
        </div>

        {/* The pinned pane at 900px and up. Hidden below that, where the same
            content appears in the drawer instead. */}
        <aside className="wb__aside only-wide">
          <EvidencePane segment={selected} ctx={ctx} />
        </aside>
      </div>

      <div className="only-narrow">
        <Drawer
          open={drawerOpen && selected !== null}
          onClose={() => setDrawerOpen(false)}
          title="Evidence"
          side="bottom"
        >
          <EvidencePane segment={selected} ctx={ctx} />
        </Drawer>
      </div>

      <SendQueue draft={draft} onSave={(next) => saveDraft(next)} />

      <details className="card">
        <summary>The document as it will be sent</summary>
        <textarea
          className="mono"
          readOnly
          rows={16}
          value={finalText}
          onFocus={(e) => e.currentTarget.select()}
        />
      </details>
    </>
  )
}
