import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import type { ObservationRecord } from '../lib/types'

// Read-only view of the per-individual observations imported from routing.
// Grouped by participant; flags the ones Claude marked needs_review.
export function Observations() {
  const observations = useLiveQuery(
    () => db.observations.toArray(),
    [],
    [] as ObservationRecord[],
  )

  const byParticipant = new Map<string, ObservationRecord[]>()
  for (const o of observations ?? []) {
    const key = o.participant_name || '(unattributed)'
    const list = byParticipant.get(key) ?? []
    list.push(o)
    byParticipant.set(key, list)
  }

  return (
    <main>
      <div className="card">
        <h1>Observations</h1>
        <p className="small muted">
          Per-individual evidence routed from captures. Numbers are draft 0–3 designations;
          items flagged for review need a human check before they count.
        </p>
      </div>

      {(observations?.length ?? 0) === 0 && (
        <div className="banner">
          Nothing yet. Route some captures from <Link to="/routing">Routing</Link>.
        </div>
      )}

      {[...byParticipant.entries()].map(([name, list]) => (
        <div className="card" key={name}>
          <h2>{name}</h2>
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
                  {o.needs_review && <span className="pill" style={{ marginLeft: '0.5rem' }}>needs review</span>}
                </div>
                <div className="small" style={{ marginTop: '0.25rem' }}>{o.text}</div>
                {o.source_excerpt && (
                  <div className="muted small" style={{ marginTop: '0.25rem', fontStyle: 'italic' }}>
                    “{o.source_excerpt}”
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}

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
