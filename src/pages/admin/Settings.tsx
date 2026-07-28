import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { loadReferenceData } from '../../db/reference'
import { getSettings, saveSetting } from '../../db/settings'
import { ASSIGNABLE_ROLES } from '../../db/directory'
import { isSupabaseConfigured } from '../../lib/supabase'
import { useAuth } from '../../auth/AuthContext'
import { useScopedWorkshopId } from '../../layout/roles'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import { fairShare, quotaFor } from '../../lib/assignment'
import { PageHeader } from '../../layout/PageHeader'
import { ProposalPanel } from '../../devfeedback/ProposalPanel'
import type { Activity, AssignmentKind, Ksa, WorkshopPerson } from '../../lib/types'

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
  const { identity } = useAuth()
  const workshopId = useScopedWorkshopId()
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])

  // Live off Dexie rather than local state, so a value another admin changed and
  // this device pulled repaints here instead of showing the number this device
  // last typed. That divergence is the exact bug moving these off localStorage
  // was meant to fix.
  const settings = useLiveQuery(
    async () =>
      workshopId
        ? resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray())
        : SETTINGS_DEFAULTS,
    [workshopId],
    SETTINGS_DEFAULTS,
  )
  const people = useLiveQuery(
    () =>
      workshopId
        ? db.workshopPeople.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as WorkshopPerson[]),
    [workshopId],
    [] as WorkshopPerson[],
  )
  const participantCount = useLiveQuery(
    () => (workshopId ? db.participants.where('workshop_id').equals(workshopId).count() : Promise.resolve(0)),
    [workshopId],
    0,
  )

  const evaluators = (people ?? [])
    .filter((p) => ASSIGNABLE_ROLES.includes(p.role))
    .sort((a, b) => a.name.localeCompare(b.name))
  const share = fairShare(participantCount ?? 0, evaluators.length, settings.requiredConfirmations)

  const write = async (key: Parameters<typeof saveSetting>[1], value: unknown) => {
    if (!workshopId) return
    await saveSetting(workshopId, key, value, identity?.email ?? null)
  }

  /** One evaluator's quota override, or removed when the field is cleared. */
  const setOverride = async (kind: AssignmentKind, email: string, raw: string) => {
    if (!workshopId) return
    const current = await getSettings(workshopId)
    const map = {
      ...(kind === 'review' ? current.reviewQuotaOverrides : current.observationQuotaOverrides),
    }
    const n = Number(raw)
    // An empty or nonsensical field REMOVES the override rather than storing a
    // zero. A quota of zero would silently exclude the person from every future
    // auto-assignment, which is not what clearing a box means.
    if (!raw.trim() || !Number.isFinite(n) || n < 1) delete map[email]
    else map[email] = Math.floor(n)
    await write(
      kind === 'review' ? 'review_quota_overrides' : 'observation_quota_overrides',
      map,
    )
  }

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

      <div className="grid grid--split">
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
              value={settings.requiredConfirmations}
              disabled={!workshopId}
              onChange={(e) => {
                const n = Math.max(1, Math.min(5, Number(e.target.value) || 1))
                void write('required_confirmations', n)
              }}
              style={{ width: '5rem', margin: 0 }}
            />
            <span className="small muted">1 = solo review · 2 = dual review (default)</span>
          </div>
          <p className="small muted">
            Raising this mid-workshop re-locks reports that were already ready, because the
            threshold is applied at read time rather than stamped on the observation. That is
            deliberate, but it means a change here is visible immediately on{' '}
            <Link to="/reports">Reports</Link>, and on{' '}
            <Link to="/admin/assignments">Assignments</Link>, where it is also the number of
            assignees each participant needs.
          </p>
          <p className="small muted">
            This setting belongs to the workshop, not to this device: it reaches every phone on the
            next sync. It used to be stored per device, which meant an administrator could raise the
            bar and be the only person whose app knew.
          </p>
        </div>

        <div className="card form-col">
          <h2>Review workload</h2>
          <p className="small muted">
            How many participants an evaluator is expected to carry. Leave a field blank to use the
            even split of the cohort, which is currently{' '}
            <strong>{share === null ? 'unknown (no evaluators yet)' : share}</strong> each across{' '}
            {evaluators.length} evaluator{evaluators.length === 1 ? '' : 's'}.
          </p>

          <label htmlFor="revdef" className="small muted">
            Default review quota
          </label>
          <div className="row">
            <input
              id="revdef"
              type="number"
              min={1}
              value={settings.reviewQuotaDefault ?? ''}
              placeholder={share === null ? 'even split' : String(share)}
              disabled={!workshopId}
              onChange={(e) => {
                const n = Number(e.target.value)
                void write('review_quota_default', Number.isFinite(n) && n >= 1 ? Math.floor(n) : null)
              }}
              style={{ width: '5rem', margin: 0 }}
            />
            <label htmlFor="obsdef" className="small muted" style={{ margin: 0 }}>
              Default observation quota
            </label>
            <input
              id="obsdef"
              type="number"
              min={1}
              value={settings.observationQuotaDefault ?? ''}
              placeholder={share === null ? 'even split' : String(share)}
              disabled={!workshopId}
              onChange={(e) => {
                const n = Number(e.target.value)
                void write(
                  'observation_quota_default',
                  Number.isFinite(n) && n >= 1 ? Math.floor(n) : null,
                )
              }}
              style={{ width: '5rem', margin: 0 }}
            />
          </div>

          <h3 style={{ marginTop: 'var(--s-4)' }}>Per evaluator</h3>
          {evaluators.length === 0 ? (
            <p className="small muted">
              Nobody has been added to this workshop yet, so there is nobody to set a limit for.
              People are added to a workshop in the backend: the app can read the roster but has no
              permission to change it.
            </p>
          ) : (
            evaluators.map((e) => (
              <div className="row" key={e.email} style={{ padding: 'var(--s-1) 0' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{e.name}</strong>
                  <span className="small muted"> · {e.role.replace(/_/g, ' ')}</span>
                </span>
                <input
                  type="number"
                  min={1}
                  aria-label={`Review quota for ${e.name}`}
                  value={settings.reviewQuotaOverrides[e.email] ?? ''}
                  placeholder={String(
                    quotaFor(e.email, 'review', settings, share) ?? '—',
                  )}
                  onChange={(ev) => void setOverride('review', e.email, ev.target.value)}
                  style={{ width: '4.5rem', margin: 0 }}
                />
                <input
                  type="number"
                  min={1}
                  aria-label={`Observation quota for ${e.name}`}
                  value={settings.observationQuotaOverrides[e.email] ?? ''}
                  placeholder={String(
                    quotaFor(e.email, 'observation', settings, share) ?? '—',
                  )}
                  onChange={(ev) => void setOverride('observation', e.email, ev.target.value)}
                  style={{ width: '4.5rem', margin: 0 }}
                />
              </div>
            ))
          )}
          <p className="small muted">
            Two boxes per person: review, then observation. Clearing a box drops the override and
            returns them to the default.
          </p>
        </div>
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
