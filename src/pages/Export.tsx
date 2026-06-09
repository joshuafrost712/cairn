import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { buildAllReports } from '../reports/build'
import { annotateObservations, participantGate, REQUIRED_CONFIRMATIONS, type Gate } from '../reports/verification'
import { buildCbcExport, cbcKsaCsv, cbcSubpointCsv } from '../reports/cbcExport'
import { downloadText } from '../lib/download'
import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict } from '../lib/types'

// CBC export: the interchange artifact for the (deferred) platform submission adapter.
// Only verified evidence drives designations; "only finalized" limits to reports whose
// gate is ready. JSON is canonical; the two CSVs are for pivoting / spreadsheet import.
export function Export() {
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])
  const workshop = useLiveQuery(() => db.workshops.toCollection().first(), [])

  const [onlyFinalized, setOnlyFinalized] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

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

  const generatedOn = useMemo(() => new Date().toISOString(), [])
  const cbc = useMemo(
    () =>
      buildCbcExport(reports, (id) => gates.get(id) ?? participantGate([]), {
        workshop: { id: workshop?.id ?? null, name: workshop?.name ?? null },
        generatedOn,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        onlyFinalized,
      }),
    [reports, gates, workshop, generatedOn, onlyFinalized],
  )

  const total = (participants ?? []).filter((p) => (gates.get(p.id)?.total ?? 0) > 0).length
  const finalized = [...gates.values()].filter((g) => g.status === 'ready').length

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setMsg(`Copied ${label}.`)
    } catch {
      setMsg('Clipboard blocked; use Download instead.')
    }
  }

  return (
    <main>
      <div className="card">
        <h1>CBC export</h1>
        <p className="small muted">
          The interchange artifact for CBC submission. Only verified evidence drives designations.
          The platform-specific adapter is deferred until its import format is known; this produces a
          stable JSON + CSV the adapter (or a person) can consume.
        </p>
        <p className="small">
          <strong>{cbc.participants.length}</strong> participant(s) in this export ·{' '}
          {finalized}/{total} reports finalized (gate ready).
        </p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={onlyFinalized} onChange={(e) => setOnlyFinalized(e.target.checked)} style={{ width: 'auto' }} />
          <span className="small">Only finalized reports (recommended for submission)</span>
        </label>
      </div>

      {cbc.participants.length === 0 ? (
        <div className="banner warn">
          Nothing to export yet{onlyFinalized ? ' — no reports are fully verified' : ''}. Verify evidence on{' '}
          <Link to="/observations">Observations</Link>, or uncheck "only finalized" to export drafts.
        </div>
      ) : (
        <div className="card">
          <h2>Download or copy</h2>
          <div className="row">
            <button className="primary" onClick={() => downloadText('cbc-export.json', JSON.stringify(cbc, null, 2))}>
              Download JSON
            </button>
            <button onClick={() => downloadText('cbc-by-ksa.csv', cbcKsaCsv(cbc), 'text/csv')}>CSV by KSA</button>
            <button onClick={() => downloadText('cbc-by-subpoint.csv', cbcSubpointCsv(cbc), 'text/csv')}>CSV by sub-point</button>
          </div>
          <div className="row" style={{ marginTop: '0.4rem' }}>
            <button className="ghost small" onClick={() => copy(JSON.stringify(cbc, null, 2), 'JSON')}>Copy JSON</button>
            <button className="ghost small" onClick={() => copy(cbcKsaCsv(cbc), 'KSA CSV')}>Copy KSA CSV</button>
            <button className="ghost small" onClick={() => copy(cbcSubpointCsv(cbc), 'sub-point CSV')}>Copy sub-point CSV</button>
          </div>

          {cbc.participants.map((p) => (
            <div key={p.participant_id} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
              <div>
                <strong>{p.participant_name}</strong>{' '}
                <span className={`pill ${p.finalized ? 'synced' : 'queued'}`}>{p.finalized ? 'finalized' : 'draft'}</span>
              </div>
              <div className="small muted" style={{ marginTop: '0.25rem' }}>
                {p.competencies
                  .filter((c) => c.designation !== null)
                  .map((c) => `${c.subpoint}: ${c.designation}/3`)
                  .join(' · ') || 'no verified designations'}
              </div>
            </div>
          ))}
        </div>
      )}

      {msg && <div className="banner">{msg}</div>}

      <div className="card row">
        <Link to="/reports">Reports</Link>
        <span className="spacer" />
        <Link className="small muted" to="/">Home</Link>
      </div>
    </main>
  )
}
