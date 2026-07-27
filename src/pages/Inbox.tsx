import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth, useIsChief } from '../auth/AuthContext'
import { buildAllReports } from '../reports/build'
import { annotateObservations } from '../reports/verification'
import { findDiscrepancies, buildCaptureTimeMap, discrepancyId } from '../reports/discrepancy'
import { renderDiscrepancyEmails } from '../reports/discrepancyEmail'
import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict, EvaluationRecord, DiscrepancyResolution } from '../lib/types'
import type { Discrepancy } from '../reports/discrepancy'
import type { DiscrepancyEmailDraft } from '../reports/discrepancyEmail'

// Chief-only discrepancy inbox. Shows every open (unresolved) conflict between evaluators,
// with evidence, time-gap notes, and three ready-to-send email drafts per discrepancy.
// The "Mark reconciled" button records the acknowledgement in the local discrepancyResolutions
// table; resolved discrepancies drop off the open list and appear in a collapsible section.

function EmailDraftCard({ draft, label }: { draft: DiscrepancyEmailDraft; label: string }) {
  const [msg, setMsg] = useState<string | null>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.body)
      setMsg('Copied to clipboard.')
    } catch {
      setMsg('Clipboard blocked; select the text to copy.')
    }
  }

  const mailto = `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`

  return (
    <div className="rail stack-tight">
      <p className="small">
        <strong>{label}</strong>
        {draft.to ? (
          <span className="muted"> — to: {draft.to}</span>
        ) : (
          <span className="muted"> — recipient email unknown; fill in manually</span>
        )}
      </p>
      <div className="row">
        <button className="primary btn--sm" onClick={copy}>
          Copy
        </button>
        <button className="btn--sm" onClick={() => { window.location.href = mailto }}>
          Open in mail app
        </button>
      </div>
      {msg && <p className="small muted">{msg}</p>}
      <textarea
        className="mono textarea--mono-sm"
        readOnly
        value={draft.body}
        rows={6}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  )
}

function DiscrepancyCard({
  d,
  workshopName,
  chiefEmail,
  onReconcile,
}: {
  d: Discrepancy
  workshopName: string
  chiefEmail: string
  onReconcile: (id: string) => void
}) {
  const [showEmails, setShowEmails] = useState(false)
  const drafts = useMemo(
    () => renderDiscrepancyEmails(d, chiefEmail, workshopName),
    [d, chiefEmail, workshopName],
  )
  const id = discrepancyId(d.participant_id, d.ksa_code)

  return (
    <div className="card stack">
      <div className="row row--top">
        <div style={{ flex: 1 }}>
          <strong>{d.participant_name}</strong>
          <span className="muted small"> · {d.ksa_code} — {d.area}</span>
          <div className="small" style={{ marginTop: 'var(--s-1)' }}>
            <span className="pill queued">scores: {d.lo}/3 to {d.hi}/3</span>
          </div>
        </div>
        <div className="row">
          <Link to="/observations" className="btn-link">
            Review in verification
          </Link>
          <button className="primary btn--sm" onClick={() => onReconcile(id)}>
            Mark reconciled
          </button>
        </div>
      </div>

      {d.timeGapNote && <div className="banner info">{d.timeGapNote}</div>}

      <div className="stack-tight">
        {d.observations.map((o) => (
          <div key={o.id} className="rail small">
            <span className="pill">{o.effective_designation}/3</span>{' '}
            <strong>{o.evaluator_email ?? 'unknown evaluator'}</strong>: {o.text}
            {o.source_excerpt && <div className="muted">“{o.source_excerpt}”</div>}
          </div>
        ))}
      </div>

      <div>
        <button className="ghost btn--sm btn--face" onClick={() => setShowEmails((v) => !v)}>
          {showEmails ? 'Hide email drafts' : 'Show email drafts'}
        </button>
      </div>

      {showEmails && (
        <div>
          <EmailDraftCard draft={drafts[0]} label="To the chief evaluator" />
          <EmailDraftCard
            draft={drafts[1]}
            label={`To evaluator (low score: ${d.lo}/3)`}
          />
          <EmailDraftCard
            draft={drafts[2]}
            label={`To evaluator (high score: ${d.hi}/3)`}
          />
        </div>
      )}
    </div>
  )
}

export function Inbox() {
  const isChief = useIsChief()
  const { identity } = useAuth()

  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])
  const evaluations = useLiveQuery(() => db.evaluations.toArray(), [], [] as EvaluationRecord[])
  const resolutions = useLiveQuery(() => db.discrepancyResolutions.toArray(), [], [] as DiscrepancyResolution[])
  const workshop = useLiveQuery(() => db.workshops.toCollection().first(), [])

  const sortedKsas = useMemo(() => [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code)), [ksas])
  const annotated = useMemo(() => annotateObservations(observations ?? [], verdicts ?? []), [observations, verdicts])
  const reports = useMemo(
    () => buildAllReports(participants ?? [], sortedKsas, annotated, teams ?? []),
    [participants, sortedKsas, annotated, teams],
  )
  const captureTimes = useMemo(() => buildCaptureTimeMap(evaluations ?? []), [evaluations])
  const allDiscrepancies = useMemo(() => findDiscrepancies(reports, captureTimes), [reports, captureTimes])

  const resolvedIds = useMemo(
    () => new Set((resolutions ?? []).map((r) => r.id)),
    [resolutions],
  )
  const open = useMemo(() => allDiscrepancies.filter((d) => !resolvedIds.has(discrepancyId(d.participant_id, d.ksa_code))), [allDiscrepancies, resolvedIds])
  const reconciled = useMemo(() => allDiscrepancies.filter((d) => resolvedIds.has(discrepancyId(d.participant_id, d.ksa_code))), [allDiscrepancies, resolvedIds])

  const [showReconciled, setShowReconciled] = useState(false)

  const markReconciled = async (id: string) => {
    const rec: DiscrepancyResolution = {
      id,
      resolved_by: identity?.email ?? 'unknown',
      note: null,
      at: new Date().toISOString(),
    }
    await db.discrepancyResolutions.put(rec)
  }

  if (!isChief) {
    return (
      <>
        <div className="card">
          <h1>Discrepancy inbox</h1>
          <p>This inbox is for chief evaluators. Sign in with a chief evaluator or admin account to access it.</p>
          <Link to="/">Back to home</Link>
        </div>
      </>
    )
  }

  const workshopName = workshop?.name ?? 'Workshop'
  const chiefEmail = identity?.email ?? ''

  return (
    <>
      <div className="card">
        <h1>Discrepancy inbox</h1>
        <p className="small muted">
          Open discrepancies are KSA scores where two evaluators disagree by 2 or more points.
          Each card shows the evidence, a note if the observations were captured hours apart, and
          three ready-to-send email drafts. Mark a discrepancy reconciled once you have held the
          joint conversation.
        </p>
        {open.length > 0 && (
          <p className="small">
            <span className="pill queued">{open.length} open</span>
            {reconciled.length > 0 && (
              <span className="muted"> · {reconciled.length} reconciled</span>
            )}
          </p>
        )}
      </div>

      {open.length === 0 && (
        <div className="banner">
          No open discrepancies.
        </div>
      )}

      {open.map((d) => (
        <DiscrepancyCard
          key={discrepancyId(d.participant_id, d.ksa_code)}
          d={d}
          workshopName={workshopName}
          chiefEmail={chiefEmail}
          onReconcile={markReconciled}
        />
      ))}

      {reconciled.length > 0 && (
        <div className="card stack">
          <button
            className="ghost btn--sm btn--face btn--block-left"
            onClick={() => setShowReconciled((v) => !v)}
          >
            {showReconciled ? 'Hide' : 'Show'} {reconciled.length} reconciled
          </button>
          {showReconciled && (
            <div className="stack-tight">
              {reconciled.map((d) => {
                const id = discrepancyId(d.participant_id, d.ksa_code)
                const res = (resolutions ?? []).find((r) => r.id === id)
                return (
                  <div key={id} className="rail small">
                    <span className="pill synced">reconciled</span>{' '}
                    <strong>{d.participant_name}</strong>
                    <span className="muted"> · {d.ksa_code} — {d.area} ({d.lo}/3 to {d.hi}/3)</span>
                    {res && (
                      <div className="muted">
                        Marked by {res.resolved_by} on {new Date(res.at).toLocaleString()}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

    </>
  )
}
