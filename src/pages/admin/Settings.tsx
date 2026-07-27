import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { loadReferenceData } from '../../db/reference'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getRequiredConfirmations, setRequiredConfirmations } from '../../reports/verification'
import { PageHeader } from '../../layout/PageHeader'
import { ProposalPanel } from '../../devfeedback/ProposalPanel'
import type { Activity, Ksa } from '../../lib/types'

/**
 * Backend status, the verification threshold, and a read-only look at the
 * authored content.
 *
 * Everything here is a setting or a fact, nothing here destroys data. That is
 * the line between this page and /admin/data, and it is worth keeping: this is
 * a page you can hand to someone and say "have a look", which the other is not.
 */
export function Settings() {
  const [busy, setBusy] = useState(false)
  const [required, setRequired] = useState(() => getRequiredConfirmations())
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])

  const sortedKsas = [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code))

  return (
    <>
      <PageHeader title="Settings" crumbs={[{ label: 'Configure' }, { label: 'Settings' }]} />

      <div className="card form-col">
        <h2>Backend</h2>
        <p className="muted small">
          {isSupabaseConfigured ? 'Supabase configured' : 'Local-only (no Supabase)'}
        </p>
        <div className="row">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await loadReferenceData()
              } finally {
                setBusy(false)
              }
            }}
          >
            {isSupabaseConfigured ? 'Reload from backend' : 'Reload reference'}
          </button>
        </div>
        {isSupabaseConfigured && (
          <p className="small muted">
            Reloading from the backend overwrites local reference edits. With Supabase on, manage
            the roster in the backend rather than here.
          </p>
        )}
      </div>

      <div className="card form-col">
        <h2>Verification</h2>
        <label htmlFor="reqconf" className="small muted">
          Evaluators who must confirm each observation before it counts toward a finalized report.
        </label>
        <div className="row">
          <input
            id="reqconf"
            type="number"
            min={1}
            max={5}
            value={required}
            onChange={(e) => {
              const n = Math.max(1, Math.min(5, Number(e.target.value) || 1))
              setRequired(n)
              setRequiredConfirmations(n)
            }}
            style={{ width: '5rem', margin: 0 }}
          />
          <span className="small muted">1 = solo review · 2 = dual review (default)</span>
        </div>
        <p className="small muted">
          Raising this mid-workshop re-locks reports that were already ready, because the threshold
          is applied at read time rather than stamped on the observation. That is deliberate, but it
          means a change here is visible immediately on <Link to="/reports">Reports</Link>.
        </p>
      </div>

      <div className="card">
        <h2>Schedule &amp; questions</h2>
        <p className="small muted">
          {(activities ?? []).length} activities · {sortedKsas.length} questions. Events, questions,
          the 0–3 evidence descriptors, and which questions appear on which event are authored in
          the <Link to="/builder">Scenario Builder</Link>, including drafting a whole scenario from
          an uploaded document. They are read-only here.
        </p>
        {sortedKsas.map((k) => (
          <p className="small" key={k.id}>
            <strong>{k.code}</strong> ({k.area}) · {k.short_label}
          </p>
        ))}
      </div>

      <ProposalPanel />
    </>
  )
}
