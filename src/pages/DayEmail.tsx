import { useMemo, useState } from 'react'

import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ADMIN_ROLES, useHasWorkshopRole } from '../layout/roles'
import { useWorkshopEvidence } from '../hooks/useWorkshopEvidence'
import { buildAllReports } from '../reports/build'
import { renderDayEmailMarkdown } from '../reports/dayEmail'
import { annotateObservations, participantGate, type Gate } from '../reports/verification'

// End-of-day email: one summary across every participant evaluated today, rolled up
// from the same pipeline the Reports page uses (annotate → buildAllReports →
// participantGate). Its job is to make the multi-evaluator merge visible — where two
// of us agreed on a participant and where we conflicted — and hand back email-ready
// text. No backend send: copy it (full content) or open the mail app prefilled.
//
// SCOPED TO THE ACTIVE WORKSHOP (tl-29). This page read all five tables with a bare
// `toArray()` and took `db.workshops.toCollection().first()` as the workshop, so on a
// device holding both the Crash Course and Psalms it generated ONE document under
// Psalms' name carrying the Crash Course's four people, permanently and regardless of
// which workshop was selected. It also printed each designation against the active
// workshop's scale labels while drawing the designations from everywhere, which is a
// score labelled by a scale that did not produce it. `useWorkshopEvidence` resolves
// all of it in one place.
export function DayEmail() {
  const { identity } = useAuth()
  const isAdmin = useHasWorkshopRole(ADMIN_ROLES)
  const {
    participants,
    teams,
    ksas: sortedKsas,
    observations,
    verdicts,
    workshopName,
    scale,
  } = useWorkshopEvidence()

  const annotated = useMemo(() => annotateObservations(observations, verdicts), [observations, verdicts])
  const reports = useMemo(
    () => buildAllReports(participants, sortedKsas, annotated, teams),
    [participants, sortedKsas, annotated, teams],
  )
  const gates = useMemo(() => {
    const m = new Map<string, Gate>()
    for (const p of participants) m.set(p.id, participantGate(annotated.filter((o) => o.participant_id === p.id)))
    return m
  }, [participants, annotated])

  const dateLabel = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const [to, setTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const markdown = useMemo(
    () =>
      renderDayEmailMarkdown(reports, gates, workshopName, dateLabel, {
        fromName: identity?.name,
        scale,
      }),
    [reports, gates, workshopName, dateLabel, identity, scale],
  )

  const subject = `End-of-day evaluation summary — ${workshopName} (${dateLabel})`
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
    <>
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
          No observations to summarize yet.{' '}
          {isAdmin && (
            <>
              <Link to="/admin/routing">Process the pending captures</Link> first.
            </>
          )}
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

    </>
  )
}
