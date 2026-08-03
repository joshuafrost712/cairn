import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { ksasForActivity } from '../../db/reference'
import { setActivityKsas, setWiringOverride } from '../../db/referenceWrite'
import { c } from '../../lib/content/chrome'
import {
  hasOverride,
  normalizeGuidingOverride,
  normalizeOverride,
  type ActivityKsaResolved,
} from '../../lib/goals'
import type { Activity, ActivityKsa, Ksa } from '../../lib/types'
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
  // Scoped to the workshop (tl-08). It used to be the whole `ksas` table, which was
  // the same list in a one-workshop deployment and would have offered another
  // organization's questions the moment there were two.
  const ksas = useLiveQuery(
    () => db.ksas.where('workshop_id').equals(workshop.id).toArray(),
    [workshop.id],
    [] as Ksa[],
  )

  return (
    <>
      <div className="card">
        <h2>{c('setup.wiring.title')}</h2>
        <p className="small muted">{c('setup.wiring.help')}</p>
        {(activities ?? []).length === 0 && (
          <p className="small muted">{c('setup.wiring.no-events')}</p>
        )}
        {(activities ?? []).map((a) => (
          <WiringEditor
            key={a.id}
            activity={a}
            allKsas={[...(ksas ?? [])].sort((x, y) =>
              x.code.localeCompare(y.code, undefined, { numeric: true }),
            )}
            workshopId={workshop.id}
          />
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
        <WiredQuestion
          key={k.id}
          ksa={k}
          link={(links ?? []).find((l) => l.ksa_id === k.id)}
          activity={activity}
          workshopId={workshopId}
          first={i === 0}
          last={i === selected.length - 1}
          busy={busy}
          onMove={(dir) => move(i, dir)}
          onRemove={() => void rewire(selectedIds.filter((x) => x !== k.id))}
        />
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

/**
 * One wired question, with its per-event wording behind a disclosure (tl-08).
 *
 * Collapsed by default and labelled as an override when it holds one, because the
 * default case — the question's own prompt, everywhere it is asked — is the case an
 * administrator hits ninety times out of a hundred, and it has to stay as quick as
 * it was before this field existed. Joshua's feedback asks for "the KSA prompts for
 * each event"; the answer is a field you can ignore, not a field you must fill.
 */
function WiredQuestion({
  ksa,
  link,
  activity,
  workshopId,
  first,
  last,
  busy,
  onMove,
  onRemove,
}: {
  ksa: Ksa
  link: (ActivityKsa & { pk: string }) | undefined
  activity: Activity
  workshopId: string
  first: boolean
  last: boolean
  busy: boolean
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const { request, busy: saving } = useSetupSave()
  const [open, setOpen] = useState(false)
  const stored = link?.prompt_override ?? null
  const storedGuiding = link?.guiding_questions_override ?? null
  const [prompt, setPrompt] = useState(stored ?? '')
  const [guiding, setGuiding] = useState<string[] | null>(storedGuiding)
  const overridden = link ? hasOverride(link) : false

  const dirty =
    normalizeOverride(prompt) !== stored ||
    JSON.stringify(guiding == null ? null : normalizeGuidingOverride(guiding)) !==
      JSON.stringify(storedGuiding)

  const save = async () => {
    const nextPrompt = normalizeOverride(prompt)
    const nextGuiding = guiding == null ? null : normalizeGuidingOverride(guiding)
    const counts = await countsForWiring(activity.id, workshopId)
    await request({
      change: {
        entity: 'wiring',
        operation: 'update',
        entityId: `${activity.id}::${ksa.id}`,
        label: `${activity.title} · ${ksa.code}`,
        // Only the override fields, so the classifier can tell a rewording from a
        // rewire. A change carrying `questions` is the latter and costs more.
        fields: [
          { field: 'prompt_override', before: stored, after: nextPrompt },
          { field: 'guiding_questions_override', before: storedGuiding, after: nextGuiding },
        ],
        counts,
      },
      commit: () =>
        setWiringOverride(activity.id, ksa.id, {
          prompt_override: nextPrompt,
          guiding_questions_override: nextGuiding,
        }),
    })
  }

  const clear = async () => {
    setPrompt('')
    setGuiding(null)
    const counts = await countsForWiring(activity.id, workshopId)
    await request({
      change: {
        entity: 'wiring',
        operation: 'update',
        entityId: `${activity.id}::${ksa.id}`,
        label: `${activity.title} · ${ksa.code}`,
        fields: [
          { field: 'prompt_override', before: stored, after: null },
          { field: 'guiding_questions_override', before: storedGuiding, after: null },
        ],
        counts,
      },
      commit: () =>
        setWiringOverride(activity.id, ksa.id, {
          prompt_override: null,
          guiding_questions_override: null,
        }),
    })
  }

  const lines = guiding ?? ksa.guiding_questions ?? []

  return (
    <div style={{ marginTop: '0.2rem' }}>
      <div className="row">
        <span className="small" style={{ flex: 1 }}>
          {ksa.code} — {ksa.short_label}
          {overridden && (
            <>
              {' '}
              <span className="pill queued">{c('setup.wiring.overridden')}</span>
            </>
          )}
        </span>
        <button className="ghost small" onClick={() => setOpen((o) => !o)} disabled={!link}>
          {open ? '▾' : '▸'} {c('setup.wiring.wording')}
        </button>
        <button className="ghost small" onClick={() => onMove(-1)} disabled={busy || first}>
          ↑
        </button>
        <button className="ghost small" onClick={() => onMove(1)} disabled={busy || last}>
          ↓
        </button>
        <button className="ghost small" disabled={busy} onClick={onRemove}>
          {c('setup.wiring.remove')}
        </button>
      </div>
      {open && link && (
        <div className="card" style={{ marginTop: '0.3rem' }}>
          <p className="small muted">{c('setup.wiring.override-help')}</p>
          <label className="small muted">{c('setup.wiring.override-prompt')}</label>
          <textarea
            rows={2}
            value={prompt}
            placeholder={ksa.evaluator_facing_prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p className="small muted">{c('setup.wiring.override-blank')}</p>

          <label className="small muted">{c('setup.wiring.override-guiding')}</label>
          {lines.map((g, i) => (
            <div key={i} className="row">
              <input
                value={g}
                onChange={(e) =>
                  setGuiding(lines.map((x, j) => (j === i ? e.target.value : x)))
                }
                style={{ flex: 1 }}
              />
              <button
                className="ghost small"
                onClick={() => setGuiding(lines.filter((_, j) => j !== i))}
              >
                {c('setup.questions.guiding-remove')}
              </button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setGuiding([...lines, ''])}>
            {c('setup.questions.guiding-add')}
          </button>
          {storedGuiding == null && guiding == null && (
            <p className="small muted">{c('setup.wiring.override-guiding-inherited')}</p>
          )}

          <div className="row" style={{ marginTop: '0.4rem' }}>
            <button disabled={saving || !dirty} onClick={() => void save()}>
              {c('setup.wiring.override-save')}
            </button>
            <button className="ghost small" disabled={saving || !overridden} onClick={() => void clear()}>
              {c('setup.wiring.override-clear')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Exactly what an evaluator sees on the capture screen for the chosen event. */
function PreviewCard({ activities }: { activities: Activity[] }) {
  const [activityId, setActivityId] = useState<string>('')
  const chosen = activityId || activities[0]?.id || ''
  // The same resolution the capture screen uses, not a second one: this preview is
  // only worth having if it shows what an evaluator will actually be asked, per-event
  // override included.
  const ksas = useLiveQuery(
    () => (chosen ? ksasForActivity(chosen) : Promise.resolve([] as ActivityKsaResolved[])),
    [chosen],
    [] as ActivityKsaResolved[],
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
            {k.overridden && (
              <>
                {' '}
                <span className="pill queued">{c('setup.wiring.overridden')}</span>
              </>
            )}
            <p className="small muted">{k.goal_title}</p>
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
