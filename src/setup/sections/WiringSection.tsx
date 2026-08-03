import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { ksasForActivity } from '../../db/reference'
import { setActivityKsas } from '../../db/referenceWrite'
import { c } from '../../lib/content/chrome'
import type { Activity, Ksa } from '../../lib/types'
import { countsForWiring } from '../counts'
import { useSetupSave } from '../useSetupSave'

/**
 * Which questions appear on which event, and in what order.
 *
 * This is the section where the classifier earns its keep. Rewiring an event nobody
 * has captured yet only changes what evaluators will be asked; rewiring one that has
 * already been captured changes which answers its report rollup reads, while every
 * screen still looks correct. Same gesture, different cost, and only the counts can
 * tell them apart — which is why every change here gathers them first.
 */
export function WiringSection({ workshop }: { workshop: { id: string } }) {
  const activities = useLiveQuery(
    () => db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order'),
    [workshop.id],
    [] as Activity[],
  )
  const ksas = useLiveQuery(() => db.ksas.orderBy('code').toArray(), [], [] as Ksa[])

  return (
    <>
      <div className="card">
        <h2>{c('setup.wiring.title')}</h2>
        <p className="small muted">{c('setup.wiring.help')}</p>
        {(activities ?? []).length === 0 && (
          <p className="small muted">{c('setup.wiring.no-events')}</p>
        )}
        {(activities ?? []).map((a) => (
          <WiringEditor key={a.id} activity={a} allKsas={ksas ?? []} workshopId={workshop.id} />
        ))}
      </div>
      <PreviewCard activities={activities ?? []} />
    </>
  )
}

function WiringEditor({
  activity,
  allKsas,
  workshopId,
}: {
  activity: Activity
  allKsas: Ksa[]
  workshopId: string
}) {
  const { request, busy } = useSetupSave()
  const links = useLiveQuery(
    () => db.activityKsas.where('activity_id').equals(activity.id).sortBy('sort_order'),
    [activity.id],
    [],
  )
  const selectedIds = (links ?? []).map((l) => l.ksa_id)
  const selected = selectedIds
    .map((id) => allKsas.find((k) => k.id === id))
    .filter((k): k is Ksa => Boolean(k))
  const available = allKsas.filter((k) => !selectedIds.includes(k.id))

  const rewire = async (next: string[]) => {
    const counts = await countsForWiring(activity.id, workshopId)
    await request({
      change: {
        entity: 'wiring',
        operation: 'update',
        entityId: activity.id,
        label: activity.title,
        // The wiring itself is the field. Recorded as a compact before/after so the
        // audit log says which questions moved, not merely that "wiring changed".
        fields: [{ field: 'questions', before: selectedIds, after: next }],
        counts,
      },
      commit: () => setActivityKsas(activity.id, next),
    })
  }

  const move = (i: number, dir: -1 | 1) => {
    const arr = [...selectedIds]
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    void rewire(arr)
  }

  return (
    <div
      className="activity-item"
      style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}
    >
      <div className="small">
        <strong>{activity.title}</strong>
      </div>
      {selected.length === 0 && <div className="small muted">{c('setup.wiring.none-wired')}</div>}
      {selected.map((k, i) => (
        <div key={k.id} className="row" style={{ marginTop: '0.2rem' }}>
          <span className="small" style={{ flex: 1 }}>
            {k.code} — {k.short_label}
          </span>
          <button className="ghost small" onClick={() => move(i, -1)} disabled={busy || i === 0}>
            ↑
          </button>
          <button
            className="ghost small"
            onClick={() => move(i, 1)}
            disabled={busy || i === selected.length - 1}
          >
            ↓
          </button>
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => void rewire(selectedIds.filter((x) => x !== k.id))}
          >
            remove
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <div className="row" style={{ marginTop: '0.3rem', flexWrap: 'wrap', gap: '0.3rem' }}>
          {available.map((k) => (
            <button
              key={k.id}
              className="ghost small"
              disabled={busy}
              onClick={() => void rewire([...selectedIds, k.id])}
            >
              + {k.code}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Exactly what an evaluator sees on the capture screen for the chosen event. */
function PreviewCard({ activities }: { activities: Activity[] }) {
  const [activityId, setActivityId] = useState<string>('')
  const chosen = activityId || activities[0]?.id || ''
  const ksas = useLiveQuery(
    () => (chosen ? ksasForActivity(chosen) : Promise.resolve([] as Ksa[])),
    [chosen],
    [] as Ksa[],
  )
  return (
    <div className="card">
      <h2>{c('setup.wiring.preview-title')}</h2>
      <p className="small muted">{c('setup.wiring.preview-help')}</p>
      <select value={chosen} onChange={(e) => setActivityId(e.target.value)}>
        {activities.map((a) => (
          <option key={a.id} value={a.id}>
            {a.title}
          </option>
        ))}
      </select>
      {(ksas ?? []).length === 0 ? (
        <div className="small muted" style={{ marginTop: '0.5rem' }}>
          {c('setup.wiring.none-wired')}
        </div>
      ) : (
        (ksas ?? []).map((k) => (
          <div key={k.id} className="card" style={{ marginTop: '0.5rem' }}>
            <strong>{k.short_label}</strong>
            <p className="small">{k.evaluator_facing_prompt}</p>
            {(k.guiding_questions ?? []).length > 0 && (
              <ul className="small muted">
                {(k.guiding_questions ?? []).map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            )}
            <textarea rows={2} disabled placeholder="(evaluator types their observation here)" />
          </div>
        ))
      )}
    </div>
  )
}
