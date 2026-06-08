import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { annotateObservations, participantGate, type AnnotatedObservation } from '../reports/verification'
import { VerifyControls } from '../components/VerifyControls'
import { VerdictSync } from '../components/VerdictSync'
import type { ObservationRecord, VerificationVerdict } from '../lib/types'

// Observations + verification gate: each routed observation is shown with its
// per-evaluator verdicts and a confirm/adjust/reject control. A participant's
// evidence must be fully verified before their report can be finalized.
export function Observations() {
  const { identity } = useAuth()
  const observations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])

  const annotated = useMemo(
    () => annotateObservations(observations ?? [], verdicts ?? []),
    [observations, verdicts],
  )

  const byParticipant = new Map<string, AnnotatedObservation[]>()
  for (const o of annotated) {
    const key = o.participant_name || '(unattributed)'
    const list = byParticipant.get(key) ?? []
    list.push(o)
    byParticipant.set(key, list)
  }

  const email = identity?.email ?? null

  return (
    <main>
      <div className="card">
        <h1>Observations &amp; verification</h1>
        <p className="small muted">
          Per-individual evidence routed from captures. Each observation needs confirmation by the
          required number of evaluators before it counts toward a finalized report. Numbers are draft
          0–3 designations.
        </p>
        {!email && <p className="banner warn">Sign in to record verdicts.</p>}
      </div>

      {email && <VerdictSync evaluatorEmail={email} />}

      {annotated.length === 0 && (
        <div className="banner">
          Nothing yet. Route some captures from <Link to="/routing">Routing</Link>.
        </div>
      )}

      {[...byParticipant.entries()].map(([name, list]) => {
        const gate = participantGate(list)
        return (
          <div className="card" key={name}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{name}</h2>
              <span className="spacer" />
              <span className={`pill ${gate.status === 'ready' ? 'synced' : 'queued'}`}>
                {gate.status === 'ready' ? 'ready to finalize' : `${gate.verified}/${gate.total} verified`}
              </span>
            </div>
            {list
              .slice()
              .sort((a, b) => a.ksa_code.localeCompare(b.ksa_code))
              .map((o) => (
                <div key={o.id} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
                  <div>
                    <strong>{o.ksa_code}</strong> · designation <strong>{o.evidence_designation}</strong>{' '}
                    <span className="muted small">
                      ({o.sentiment_flag}, {o.confidence}, {o.origin})
                    </span>
                    {o.needs_review && <span className="pill" style={{ marginLeft: '0.5rem' }}>routing flagged</span>}
                  </div>
                  <div className="small" style={{ marginTop: '0.25rem' }}>{o.text}</div>
                  {o.source_excerpt && (
                    <div className="muted small" style={{ marginTop: '0.25rem', fontStyle: 'italic' }}>
                      “{o.source_excerpt}”
                    </div>
                  )}
                  {email && <VerifyControls obs={o} evaluatorEmail={email} />}
                </div>
              ))}
          </div>
        )
      })}

      <div className="card row">
        <Link to="/routing">Back to routing</Link>
        <span className="spacer" />
        <Link to="/reports">Reports</Link>
        <span className="spacer" />
        <Link className="small muted" to="/">Home</Link>
      </div>
    </main>
  )
}
