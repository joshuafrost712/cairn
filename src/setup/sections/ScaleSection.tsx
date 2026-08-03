import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { db } from '../../db/local'
import { saveSetting } from '../../db/settings'
import { saveWorkshopScale } from '../../db/scale'
import { c } from '../../lib/content/chrome'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import {
  buildScale,
  diffScales,
  MAX_SCALE_POINTS,
  MIN_SCALE_POINTS,
  normalizeScalePoints,
  validateScalePoints,
  type ScalePoint,
} from '../../lib/scale'
import { designationFill, designationInk } from '../../components/viz/viz'
import { countsForScale, countsForThreshold } from '../counts'
import { useSetupSave } from '../useSetupSave'

/**
 * The grading scale and the verification bar.
 *
 * Two editors, both saving through `useSetupSave()` so the change dialog cannot
 * be skipped, and both here because they are the two settings that decide what a
 * recorded number MEANS rather than what happens next.
 *
 * THE SCALE IS EDITED AS A WHOLE AND SAVED AS ONE ACT. There is no per-point
 * save, and that is the design rather than an omission: "two to six points, at
 * least one of which is not a trigger" is a property of the set, so a per-point
 * save would either have to refuse a legal end state because an intermediate one
 * was illegal, or let an illegal state exist for as long as the admin took to
 * type. The whole scale goes to `set_workshop_scale()` in one transaction.
 *
 * REMOVING A POINT UNDER EVIDENCE IS REFUSED UNTIL IT IS MAPPED. The mapping is
 * an explicit choice per removed value, made before the dialog opens, and the
 * observations it moves are marked `remapped_from` so no report ever shows an
 * administrator's translation as though it were an evaluator's judgement.
 */
export function ScaleSection({ workshopId }: { workshopId: string }) {
  const settings = useLiveQuery(
    async () =>
      resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray()),
    [workshopId],
    SETTINGS_DEFAULTS,
  )
  const current = settings?.requiredConfirmations ?? SETTINGS_DEFAULTS.requiredConfirmations
  const ksas = useLiveQuery(
    () => db.ksas.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [],
  )
  const points = useLiveQuery(
    () => db.scalePoints.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as ScalePoint[],
  )
  const scale = buildScale(workshopId, points ?? [])

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

      {/* Remounts when the stored scale changes, for the reason the threshold
          editor does: the draft is a copy, and a pull that moved the original
          should discard the copy rather than merge into it silently. */}
      <ScaleEditor
        key={scale.points.map((p) => `${p.value}:${p.label}:${p.is_low_trigger}`).join('|')}
        workshopId={workshopId}
        stored={scale.points}
        questionCount={(ksas ?? []).length}
      />
    </>
  )
}

interface Draft {
  value: number
  label: string
  description: string | null
  is_low_trigger: boolean
}

function ScaleEditor({
  workshopId,
  stored,
  questionCount,
}: {
  workshopId: string
  stored: ScalePoint[]
  questionCount: number
}) {
  const { request, busy } = useSetupSave()
  const [draft, setDraft] = useState<Draft[]>(() =>
    stored.map((p) => ({
      value: p.value,
      label: p.label,
      description: p.description,
      is_low_trigger: p.is_low_trigger,
    })),
  )
  /** Which surviving value each removed value's observations move to. */
  const [remap, setRemap] = useState<Record<number, number>>({})
  const [error, setError] = useState<string | null>(null)

  /** Observations per designation on this device, so the admin sees the cost. */
  const onEachPoint = useLiveQuery(
    async () => {
      const obs = await db.observations.where('workshop_id').equals(workshopId).toArray()
      const counts = new Map<number, number>()
      for (const o of obs) counts.set(o.evidence_designation, (counts.get(o.evidence_designation) ?? 0) + 1)
      return counts
    },
    [workshopId],
    new Map<number, number>(),
  )

  const problem = validateScalePoints(draft)
  const diff = useMemo(
    () => diffScales(stored, normalizeScalePoints(workshopId, draft)),
    [stored, draft, workshopId],
  )
  const strandedValues = diff.removed.filter((v) => (onEachPoint?.get(v) ?? 0) > 0)
  const unmapped = strandedValues.filter((v) => remap[v] === undefined)
  const dirty =
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.reworded.length > 0 ||
    diff.retriggered.length > 0

  const setPoint = (value: number, patch: Partial<Draft>) =>
    setDraft((d) => d.map((p) => (p.value === value ? { ...p, ...patch } : p)))

  const addAbove = () =>
    setDraft((d) => [
      ...d,
      {
        value: Math.max(...d.map((p) => p.value)) + 1,
        label: '',
        description: null,
        is_low_trigger: false,
      },
    ])

  const addBelow = () =>
    setDraft((d) => [
      {
        value: Math.min(...d.map((p) => p.value)) - 1,
        label: '',
        description: null,
        is_low_trigger: false,
      },
      ...d,
    ])

  const removePoint = (value: number) => {
    setDraft((d) => d.filter((p) => p.value !== value))
    setRemap((m) => {
      const next = { ...m }
      delete next[value]
      return next
    })
  }

  const save = async () => {
    setError(null)
    const counts = await countsForScale(workshopId, stored, normalizeScalePoints(workshopId, draft))
    await request({
      change: {
        entity: 'scale',
        operation: 'update',
        entityId: null,
        label: c('setup.scale.scale-label'),
        // The classifier reads `counts`, not these fields — a scale edit cannot
        // be classified from field names, because adding, renaming and deleting
        // a point all look like a change to the same thing.
        fields: [{ field: 'points', before: stored.length, after: draft.length }],
        counts,
      },
      commit: async () => {
        const result = await saveWorkshopScale(workshopId, draft, remap)
        if (!result.ok) {
          setError(result.problem ?? 'setup.scale.error.refused')
          throw new Error(result.problem ?? 'the scale was refused')
        }
      },
    })
  }

  const ordered = [...draft].sort((a, b) => a.value - b.value)
  const surviving = ordered.map((p) => p.value)

  return (
    <div className="card form-col">
      <h2>{c('setup.scale.scale-title')}</h2>
      <p className="small muted">{c('setup.scale.scale-intro')}</p>

      {/*
        The scale editor is six columns of inline inputs, so it does not fit a phone
        and must scroll inside itself rather than widening the page. tl-09 built it as
        a bare `.dt` in a card, which the two-viewport audit caught on merge at 730px
        on a 390px viewport: tl-20's harness does not exist on tl-09's branch, so this
        section was the one dense table nobody had measured. `.dt-wrap` is the same
        container DataTable and the roster importer already use, and it brings the
        there-is-more-that-way gradient with it.
      */}
      <div className="dt-wrap">
        <table className="dt scale-table">
          <thead>
            <tr>
              <th scope="col">{c('setup.scale.col-value')}</th>
              <th scope="col">{c('setup.scale.col-label')}</th>
              <th scope="col">{c('setup.scale.col-description')}</th>
              <th scope="col">{c('setup.scale.col-trigger')}</th>
              <th scope="col">{c('setup.scale.col-recorded')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {ordered.map((p, i) => (
              <tr key={p.value}>
                <th scope="row">
                  <span
                    className="chip-d"
                    data-d={p.value}
                    data-trigger={p.is_low_trigger || undefined}
                    style={
                      {
                        '--fill': designationFill(
                          p.value,
                          buildScale(workshopId, normalizeScalePoints(workshopId, ordered)),
                        ),
                        '--ink-on': designationInk(
                          p.value,
                          buildScale(workshopId, normalizeScalePoints(workshopId, ordered)),
                        ),
                      } as React.CSSProperties
                    }
                  >
                    {p.value}
                  </span>
                </th>
                <td>
                  <input
                    aria-label={c('setup.scale.col-label')}
                    value={p.label}
                    onChange={(e) => setPoint(p.value, { label: e.target.value })}
                    style={{ margin: 0, width: '100%' }}
                  />
                </td>
                <td>
                  <input
                    aria-label={c('setup.scale.col-description')}
                    value={p.description ?? ''}
                    onChange={(e) => setPoint(p.value, { description: e.target.value })}
                    style={{ margin: 0, width: '100%' }}
                  />
                </td>
                <td>
                  <label className="small">
                    <input
                      type="checkbox"
                      checked={p.is_low_trigger}
                      onChange={(e) => setPoint(p.value, { is_low_trigger: e.target.checked })}
                    />{' '}
                    {c('setup.scale.trigger-yes')}
                  </label>
                </td>
                <td className="small muted">{onEachPoint?.get(p.value) ?? 0}</td>
                <td>
                  {/* Only the ends may go. Removing from the middle would leave a
                      gap the ramp can render and a reader cannot explain. */}
                  {ordered.length > MIN_SCALE_POINTS && (i === 0 || i === ordered.length - 1) && (
                    <button className="ghost small" onClick={() => removePoint(p.value)}>
                      {c('setup.scale.remove-point')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ gap: '0.5rem' }}>
        <button
          className="ghost small"
          disabled={ordered.length >= MAX_SCALE_POINTS}
          onClick={addBelow}
        >
          {c('setup.scale.add-below')}
        </button>
        <button
          className="ghost small"
          disabled={ordered.length >= MAX_SCALE_POINTS}
          onClick={addAbove}
        >
          {c('setup.scale.add-above')}
        </button>
      </div>

      {strandedValues.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <h3>{c('setup.scale.remap-title')}</h3>
          <p className="small">
            {c('setup.scale.remap-intro', 'label', {
              points: strandedValues.join(', '),
            })}
          </p>
          {strandedValues.map((v) => (
            <div className="row" key={v} style={{ gap: '0.5rem', alignItems: 'center' }}>
              <span className="small">
                {c('setup.scale.remap-row', 'label', {
                  value: v,
                  observations: onEachPoint?.get(v) ?? 0,
                })}
              </span>
              <select
                aria-label={c('setup.scale.remap-row', 'label', {
                  value: v,
                  observations: onEachPoint?.get(v) ?? 0,
                })}
                value={remap[v] ?? ''}
                onChange={(e) =>
                  setRemap((m) => ({ ...m, [v]: Number(e.target.value) }))
                }
                style={{ margin: 0 }}
              >
                <option value="">{c('setup.scale.remap-choose')}</option>
                {surviving.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <p className="small muted">{c('setup.scale.remap-marked')}</p>
        </div>
      )}

      {problem && <p className="small" style={{ color: 'var(--danger)' }}>{c(problem)}</p>}
      {error && <p className="small" style={{ color: 'var(--danger)' }}>{c(error)}</p>}

      <div className="row">
        <button
          className="primary"
          disabled={busy || !dirty || problem !== null || unmapped.length > 0}
          onClick={() => void save()}
        >
          {c('setup.scale.save-scale')}
        </button>
        {unmapped.length > 0 && (
          <span className="small muted">
            {c('setup.scale.needs-remap-hint', 'label', { points: unmapped.join(', ') })}
          </span>
        )}
      </div>

      <p className="small muted">
        {c('setup.scale.descriptors-live-in', 'label', { count: questionCount })}{' '}
        <Link to="/admin/setup/goals">{c('setup.nav.goals')}</Link>.
      </p>
    </div>
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
