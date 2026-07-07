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
    <div style={{ marginBottom: '0.75rem', paddingLeft: '0.5rem', borderLeft: '3px solid var(--line)' }}>
      <p className="small" style={{ margin: '0 0 0.35rem' }}>
        <strong>{label}</strong>
        {draft.to ? (
          <span className="muted"> — to: {draft.to}</span>
        ) : (
          <span className="muted"> — recipient email unknown; fill in manually</span>
        )}
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
        <button className="primary" style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }} onClick={copy}>
          Copy
        </button>
        <button
          style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
          onClick={() => { window.location.href = mailto }}
        >
          Open in mail app
        </button>
      </div>
      {msg && <p className="small muted" style={{ margin: '0.3rem 0 0' }}>{msg}</p>}
      <textarea
        className="mono"
        readOnly
        value={draft.body}
        rows={6}
        style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}
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
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <strong>{d.participant_name}</strong>
          <span className="muted small"> · {d.ksa_code} — {d.area}</span>
          <div style={{ marginTop: '0.2rem' }}>
            <span className="pill queued">scores: {d.lo}/3 to {d.hi}/3</span>
          </div>
        </div>
        <div className="row" style={{ gap: '0.4rem' }}>
          <Link
            to="/observations"
            className="small"
            style={{ padding: '0.4rem 0.75rem', border: '1px solid var(--line)', borderRadius: '10px', background: '#fff', color: 'var(--accent)', textDecoration: 'none' }}
          >
            Review in verification
          </Link>
          <button
            className="primary"
            style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
            onClick={() => onReconcile(id)}
          >
            Mark reconciled
          </button>
        </div>
      </div>

      {d.timeGapNote && (
        <div className="banner" style={{ marginTop: '0.5rem', background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af' }}>
          {d.timeGapNote}
        </div>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        {d.observations.map((o) => (
          <div key={o.id} className="small" style={{ marginBottom: '0.4rem', paddingLeft: '0.5rem', borderLeft: '3px solid var(--line)' }}>
            <span className="pill" style={{ marginRight: '0.3rem' }}>{o.effective_designation}/3</span>
            <strong>{o.evaluator_email ?? 'unknown evaluator'}</strong>: {o.text}
            {o.source_excerpt && (
              <div className="muted" style={{ marginTop: '0.15rem' }}>"{o.source_excerpt}"</div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <button
          className="ghost"
          style={{ fontSize: '0.82rem', padding: '0.3rem 0.6rem', borderRadius: '8px', background: '#f3f4f6', border: '1px solid var(--line)' }}
          onClick={() => setShowEmails((v) => !v)}
        >
          {showEmails ? 'Hide email drafts' : 'Show email drafts'}
        </button>
      </div>

      {showEmails && (
        <div style={{ marginTop: '0.75rem' }}>
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
      <main>
        <div className="card">
          <h1>Discrepancy inbox</h1>
          <p>This inbox is for chief evaluators. Sign in with a chief evaluator or admin account to access it.</p>
          <Link to="/">Back to home</Link>
        </div>
      </main>
    )
  }

  const workshopName = workshop?.name ?? 'Workshop'
  const chiefEmail = identity?.email ?? ''

  return (
    <main>
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
              <span className="muted" style={{ marginLeft: '0.5rem' }}>{reconciled.length} reconciled</span>
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
        <div className="card">
          <button
            className="ghost"
            style={{ fontSize: '0.85rem', padding: '0.3rem 0.6rem', borderRadius: '8px', background: '#f3f4f6', border: '1px solid var(--line)', width: '100%', textAlign: 'left' }}
            onClick={() => setShowReconciled((v) => !v)}
          >
            {showReconciled ? 'Hide' : 'Show'} {reconciled.length} reconciled
          </button>
          {showReconciled && (
            <div style={{ marginTop: '0.75rem' }}>
              {reconciled.map((d) => {
                const id = discrepancyId(d.participant_id, d.ksa_code)
                const res = (resolutions ?? []).find((r) => r.id === id)
                return (
                  <div key={id} className="activity-item" style={{ display: 'block', cursor: 'default', opacity: 0.7 }}>
                    <span className="pill synced" style={{ marginRight: '0.4rem' }}>reconciled</span>
                    <strong>{d.participant_name}</strong>
                    <span className="muted small"> · {d.ksa_code} — {d.area} ({d.lo}/3 to {d.hi}/3)</span>
                    {res && (
                      <div className="muted small" style={{ marginTop: '0.2rem' }}>
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

      <div className="card row">
        <Link to="/reports">Reports</Link>
        <span className="spacer" />
        <Link to="/observations">Observations</Link>
        <span className="spacer" />
        <Link className="small muted" to="/">Home</Link>
      </div>
    </main>
  )
}
