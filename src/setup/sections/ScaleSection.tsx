import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { db } from '../../db/local'
import { saveSetting } from '../../db/settings'
import { c } from '../../lib/content/chrome'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import { countsForThreshold } from '../counts'
import { useSetupSave } from '../useSetupSave'

/**
 * The grading scale and the verification bar.
 *
 * tl-09 owns the configurable 2-to-6-point scale; what lives here today is the
 * verification threshold, and it is here rather than on a general settings page for
 * a reason: it is the sharpest `invalidates_evidence` case the app currently has.
 * Raising it re-locks reports that were already ready, because the threshold is
 * applied at READ time rather than stamped onto the observation. Nothing is deleted,
 * nothing looks broken, and a participant's finished report quietly becomes
 * unfinished.
 *
 * So it saves on an explicit button and states the count first: how many
 * observations cross the verified line, and how many participants that touches.
 */
export function ScaleSection({ workshopId }: { workshopId: string }) {
  const settings = useLiveQuery(
    async () =>
      resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray()),
    [workshopId],
    SETTINGS_DEFAULTS,
  )
  const current = settings?.requiredConfirmations ?? SETTINGS_DEFAULTS.requiredConfirmations
  const ksas = useLiveQuery(() => db.ksas.orderBy('code').toArray(), [], [])

  return (
    <>
      <div className="card form-col">
        <h2>{c('setup.scale.verification-title')}</h2>
        {/* Keyed on the stored value, so a change another admin made and this device
            pulled resets the field by construction. An effect that copied the new
            value into local state would be the same behaviour with a cascading render
            and a lint suppression. */}
        <ThresholdEditor key={current} workshopId={workshopId} current={current} />
        <p className="small muted">
          {c('setup.scale.read-time')} <Link to="/reports">{c('setup.scale.reports-link')}</Link>{' '}
          {c('setup.scale.and')}{' '}
          <Link to="/admin/assignments">{c('setup.scale.assignments-link')}</Link>.
        </p>
        <p className="small muted">{c('setup.scale.workshop-not-device')}</p>
      </div>

      <div className="card">
        <h2>{c('setup.scale.scale-title')}</h2>
        <p className="small muted">{c('setup.scale.scale-pending')}</p>
        <p className="small muted">
          {c('setup.scale.descriptors-live-in', 'label', { count: (ksas ?? []).length })}{' '}
          <Link to="/admin/setup/goals">{c('setup.nav.goals')}</Link>.
        </p>
      </div>
    </>
  )
}

/**
 * The verification bar itself. Its own component so the field can be reset by a
 * remount rather than by an effect, and so the save that can re-lock a finished
 * report sits behind an explicit button with the count in front of it.
 */
function ThresholdEditor({
  workshopId,
  current,
}: {
  workshopId: string
  current: number
}) {
  const { request, busy } = useSetupSave()
  const { identity } = useAuth()
  const [draft, setDraft] = useState(current)

  const save = async () => {
    const counts = await countsForThreshold(workshopId, current, draft)
    await request({
      change: {
        entity: 'threshold',
        operation: 'update',
        entityId: null,
        label: c('setup.scale.threshold-label'),
        fields: [{ field: 'required_confirmations', before: current, after: draft }],
        counts,
      },
      commit: async () => {
        await saveSetting(workshopId, 'required_confirmations', draft, identity?.email ?? null)
      },
    })
  }

  return (
    <>
      <label htmlFor="reqconf" className="small muted">
        {c('setup.scale.verification-help')}
      </label>
      <div className="row">
        <input
          id="reqconf"
          type="number"
          min={1}
          max={5}
          value={draft}
          onChange={(e) => setDraft(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
          style={{ width: '5rem', margin: 0 }}
        />
        <span className="small muted">{c('setup.scale.verification-scale')}</span>
        <button disabled={busy || draft === current} onClick={() => void save()}>
          {c('setup.scale.save')}
        </button>
      </div>
    </>
  )
}
