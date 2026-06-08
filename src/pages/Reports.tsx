import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { buildAllReports, unattributedObservations, type ParticipantReport } from '../reports/build'
import { renderParticipantReportMarkdown } from '../reports/markdown'
import type { Ksa, ObservationRecord, Participant, Team } from '../lib/types'

// Reports: deterministic rollup of observations into per-participant 0–3 evidence
// reports (no AI — pure aggregation), with a Google-Docs-ready markdown export.
export function Reports() {
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const workshop = useLiveQuery(() => db.workshops.toCollection().first(), [])

  // Sort KSAs to a stable display order by code.
  const sortedKsas = useMemo(() => [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code)), [ksas])

  const reports = useMemo(
    () => buildAllReports(participants ?? [], sortedKsas, observations ?? [], teams ?? []),
    [participants, sortedKsas, observations, teams],
  )
  const unattributed = useMemo(() => unattributedObservations(observations ?? []), [observations])

  const withEvidence = reports.filter((r) => r.totals.evidencedKsas > 0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = reports.find((r) => r.participant_id === (selectedId ?? withEvidence[0]?.participant_id)) ?? null

  const generatedOn = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [msg, setMsg] = useState<string | null>(null)

  const copyMarkdown = async (report: ParticipantReport) => {
    const md = renderParticipantReportMarkdown(report, workshop?.name ?? 'Workshop', generatedOn)
    try {
      await navigator.clipboard.writeText(md)
      setMsg(`Copied ${report.participant_name}'s report markdown.`)
    } catch {
      setMsg('Clipboard blocked; select the text below to copy.')
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Reports</h1>
        <p className="small muted">
          Per-participant evidence rolled up from observations. Draft 0–3 designations; flagged items
          do not count toward a number until a human resolves them.
        </p>
      </div>

      {withEvidence.length === 0 && (
        <div className="banner">
          No observations to report yet. Route some captures from <Link to="/routing">Routing</Link>.
        </div>
      )}

      {withEvidence.length > 0 && (
        <div className="card">
          <h2>Participants</h2>
          {reports.map((r) => (
            <button
              key={r.participant_id}
              className={`activity-item ${r.participant_id === selected?.participant_id ? 'suggested' : ''}`}
              onClick={() => setSelectedId(r.participant_id)}
            >
              <span>
                <strong>{r.participant_name}</strong>
                <br />
                <span className="muted small">
                  {r.totals.evidencedKsas}/{r.totals.totalKsas} areas evidenced
                  {r.totals.needsReviewCount ? ` · ${r.totals.needsReviewCount} to review` : ''}
                </span>
              </span>
              {r.totals.needsReviewCount > 0 && <span className="pill queued">review</span>}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>{selected.participant_name}</h2>
            <span className="spacer" />
            <button className="primary" onClick={() => copyMarkdown(selected)}>Copy report markdown</button>
          </div>
          <p className="muted small">
            {selected.team_name ? `${selected.team_name} · ` : ''}
            {selected.totals.evidencedKsas}/{selected.totals.totalKsas} areas evidenced
          </p>

          {selected.ksaRollups
            .filter((r) => r.representative !== null)
            .map((r) => (
              <div key={r.ksa_code} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
                <div>
                  <strong>{r.ksa_code}</strong> · {r.area}{' '}
                  <span className="pill">{r.representative}/3</span>
                  {r.conflict && <span className="pill queued" style={{ marginLeft: '0.4rem' }}>conflicting</span>}
                  {r.toVerify.length > 0 && (
                    <span className="pill queued" style={{ marginLeft: '0.4rem' }}>{r.toVerify.length} to verify</span>
                  )}
                </div>
                {r.contributing.map((o) => (
                  <div key={o.id} className="small" style={{ marginTop: '0.3rem' }}>
                    <strong>{o.evidence_designation}/3</strong>
                    {o.origin === 'group' ? ' (group)' : ''}: {o.text}
                  </div>
                ))}
              </div>
            ))}

          {selected.ksaRollups.some((r) => r.representative === null) && (
            <p className="muted small" style={{ marginTop: '0.5rem' }}>
              No evidence yet:{' '}
              {selected.ksaRollups.filter((r) => r.representative === null).map((r) => r.ksa_code).join(', ')}.
            </p>
          )}

          {selected.totals.needsReviewCount > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <strong className="small">Flagged for review ({selected.totals.needsReviewCount})</strong>
              {selected.ksaRollups.flatMap((r) =>
                r.toVerify.map((o) => (
                  <div key={o.id} className="small muted" style={{ marginTop: '0.25rem' }}>
                    <strong>{r.ksa_code}</strong>: {o.text} ({o.confidence} confidence)
                  </div>
                )),
              )}
            </div>
          )}
        </div>
      )}

      {unattributed.length > 0 && (
        <div className="banner warn">
          {unattributed.length} observation(s) could not be attributed to a participant and are excluded from
          reports until resolved. See <Link to="/observations">Observations</Link>.
        </div>
      )}

      {msg && <div className="banner">{msg}</div>}

      <div className="card row">
        <Link to="/routing">Routing</Link>
        <span className="spacer" />
        <Link className="small muted" to="/">Home</Link>
      </div>
    </main>
  )
}
