import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { buildAllReports, unattributedObservations, type ParticipantReport } from '../reports/build'
import { renderParticipantReportMarkdown } from '../reports/markdown'
import { annotateObservations, participantGate, type AnnotatedObservation, type Gate } from '../reports/verification'
import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict } from '../lib/types'

// Reports: per-participant 0–3 rollup with the multi-evaluator gate. A report can
// be finalized (copied for delivery) only once every observation behind it is
// verified; otherwise it stays locked with the blockers shown.
export function Reports() {
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])
  const workshop = useLiveQuery(() => db.workshops.toCollection().first(), [])

  const sortedKsas = useMemo(() => [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code)), [ksas])
  const annotated = useMemo(() => annotateObservations(observations ?? [], verdicts ?? []), [observations, verdicts])

  const reports = useMemo(
    () => buildAllReports(participants ?? [], sortedKsas, annotated, teams ?? []),
    [participants, sortedKsas, annotated, teams],
  )
  const gates = useMemo(() => {
    const m = new Map<string, Gate>()
    for (const p of participants ?? []) m.set(p.id, participantGate(annotated.filter((o) => o.participant_id === p.id)))
    return m
  }, [participants, annotated])
  const unattributed = useMemo(() => unattributedObservations(observations ?? []), [observations])

  const withEvidence = reports.filter((r) => r.totals.evidencedKsas > 0 || (gates.get(r.participant_id)?.total ?? 0) > 0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = reports.find((r) => r.participant_id === (selectedId ?? withEvidence[0]?.participant_id)) ?? null
  const selectedGate = selected ? gates.get(selected.participant_id) : undefined

  const generatedOn = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [msg, setMsg] = useState<string | null>(null)

  const copyMarkdown = async (report: ParticipantReport<AnnotatedObservation>, gate?: Gate) => {
    const md = renderParticipantReportMarkdown(report, workshop?.name ?? 'Workshop', generatedOn, gate)
    try {
      await navigator.clipboard.writeText(md)
      setMsg(`Copied ${report.participant_name}'s report markdown${gate?.status === 'ready' ? ' (verified).' : ' (draft — not yet verified).'}`)
    } catch {
      setMsg('Clipboard blocked; select the text below to copy.')
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Reports</h1>
        <p className="small muted">
          Per-participant evidence rolled up from observations. A report is cleared to finalize only
          when every observation behind it is verified by the required number of evaluators.
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
          {reports.map((r) => {
            const g = gates.get(r.participant_id)
            return (
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
                    {g && g.total > 0 ? ` · ${g.verified}/${g.total} verified` : ''}
                  </span>
                </span>
                {g && g.total > 0 && (
                  <span className={`pill ${g.status === 'ready' ? 'synced' : 'queued'}`}>
                    {g.status === 'ready' ? 'ready' : 'locked'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {selected && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>{selected.participant_name}</h2>
            <span className="spacer" />
            <button
              className={selectedGate?.status === 'ready' ? 'primary' : ''}
              onClick={() => copyMarkdown(selected, selectedGate)}
            >
              {selectedGate?.status === 'ready' ? 'Finalize: copy report' : 'Copy draft report'}
            </button>
          </div>
          <p className="muted small">
            {selected.team_name ? `${selected.team_name} · ` : ''}
            {selected.totals.evidencedKsas}/{selected.totals.totalKsas} areas evidenced
          </p>

          {selectedGate && selectedGate.total > 0 && (
            <div className={`banner ${selectedGate.status === 'ready' ? '' : 'warn'}`}>
              {selectedGate.status === 'ready' ? (
                <>All {selectedGate.total} observations verified by at least {selectedGate.required} evaluators. Cleared to finalize.</>
              ) : (
                <>
                  Locked: {selectedGate.verified}/{selectedGate.total} verified
                  {selectedGate.pending ? `, ${selectedGate.pending} pending` : ''}
                  {selectedGate.disputed ? `, ${selectedGate.disputed} disputed` : ''}. Verify the evidence on{' '}
                  <Link to="/observations">Observations</Link> (needs {selectedGate.required} confirmations each).
                </>
              )}
            </div>
          )}

          {selected.ksaRollups
            .filter((r) => r.representative !== null)
            .map((r) => (
              <div key={r.ksa_code} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
                <div>
                  <strong>{r.ksa_code}</strong> · {r.area} <span className="pill">{r.representative}/3</span>
                  {r.conflict && <span className="pill queued" style={{ marginLeft: '0.4rem' }}>conflicting</span>}
                </div>
                {r.contributing.map((o) => (
                  <div key={o.id} className="small" style={{ marginTop: '0.3rem' }}>
                    <strong>{o.effective_designation}/3</strong>
                    {o.origin === 'group' ? ' (group)' : ''} <span className="muted">[{o.vstatus}]</span>: {o.text}
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
