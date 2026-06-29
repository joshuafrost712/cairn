import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { buildAllReports } from '../reports/build'
import { renderDayEmailMarkdown } from '../reports/dayEmail'
import { annotateObservations, participantGate, type Gate } from '../reports/verification'
import type { Ksa, ObservationRecord, Participant, Team, VerificationVerdict } from '../lib/types'

// End-of-day email: one summary across every participant evaluated today, rolled up
// from the same pipeline the Reports page uses (annotate → buildAllReports →
// participantGate). Its job is to make the multi-evaluator merge visible — where two
// of us agreed on a participant and where we conflicted — and hand back email-ready
// text. No backend send: copy it (full content) or open the mail app prefilled.
export function DayEmail() {
  const { identity } = useAuth()
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

  const dateLabel = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const [to, setTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const markdown = useMemo(
    () =>
      renderDayEmailMarkdown(reports, gates, workshop?.name ?? 'Workshop', dateLabel, {
        fromName: identity?.name,
      }),
    [reports, gates, workshop, dateLabel, identity],
  )

  const subject = `End-of-day evaluation summary — ${workshop?.name ?? 'Workshop'} (${dateLabel})`
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(markdown)}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setMsg('Copied the full summary to the clipboard. Paste it into your email.')
    } catch {
      setMsg('Clipboard blocked; select the text below to copy.')
    }
  }

  const evaluatedCount = reports.filter(
    (r) => r.totals.evidencedKsas > 0 || (gates.get(r.participant_id)?.total ?? 0) > 0,
  ).length

  return (
    <main>
      <div className="card">
        <h1>End-of-day email</h1>
        <p className="small muted">
          One summary across every participant evaluated today. Where more than one evaluator scored the
          same participant, it shows whether you agreed or conflicted, using the same rollup as Reports.
        </p>
        <p className="small">
          <strong>{evaluatedCount}</strong> participant{evaluatedCount === 1 ? '' : 's'} with evidence today.
        </p>
      </div>

      {evaluatedCount === 0 && (
        <div className="banner">
          No observations to summarize yet. Route some captures from <Link to="/routing">Routing</Link> first.
        </div>
      )}

      <div className="card">
        <div className="row">
          <button className="primary" onClick={copy}>Copy email</button>
          <span className="spacer" />
          <input
            type="email"
            placeholder="send to (optional)"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={() => { window.location.href = mailto }}>Open in mail app</button>
        </div>
        <p className="small muted" style={{ marginTop: '0.5rem' }}>
          Long emails can exceed what the mail app accepts in a link, so the full text is always copied to
          your clipboard; paste it into the message if the mail app opens short.
        </p>
      </div>

      <div className="card">
        <textarea
          className="mono"
          readOnly
          value={markdown}
          rows={20}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>

      {msg && <div className="banner">{msg}</div>}

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
