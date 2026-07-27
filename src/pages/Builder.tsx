import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import {
  createWorkshop,
  deleteActivity,
  deleteKsa,
  deleteWorkshop,
  duplicateWorkshop,
  newId,
  setActivityKsas,
  upsertActivity,
  upsertKsa,
} from '../db/referenceWrite'
import { isSupabaseConfigured } from '../lib/supabase'
import { useActiveWorkshopId, setActiveWorkshopId } from '../lib/activeWorkshop'
import { KSA_AREAS, type Activity, type Ksa, type Workshop } from '../lib/types'
import { ScenarioDraftPanel } from '../components/ScenarioDraftPanel'

// --- datetime helpers: the DB stores timestamptz (ISO); inputs use datetime-local ---
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Scenario Builder. Lets a facilitator author an evaluation scenario end to end
 * without editing code: pick/create a scenario (workshop), define the events
 * (activities), define the questions (KSAs) and what goes in each box (the 0-3
 * evidence descriptors + guiding prompts), and wire which questions appear on
 * which event. All writes go through referenceWrite so they persist to the backend
 * and survive reference reloads. An AI draft-fill panel (upload a document) seeds a
 * scenario the author then edits here.
 */
export function Builder() {
  const activeId = useActiveWorkshopId()
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const workshop = useMemo(
    () => (workshops ?? []).find((w) => w.id === activeId) ?? (workshops ?? [])[0] ?? null,
    [workshops, activeId],
  )
  const activities = useLiveQuery(
    () =>
      workshop
        ? db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order')
        : Promise.resolve([] as Activity[]),
    [workshop?.id],
    [] as Activity[],
  )
  const ksas = useLiveQuery(() => db.ksas.orderBy('code').toArray(), [], [] as Ksa[])

  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const addEvent = () =>
    withBusy(async () => {
      if (!workshop) return
      const maxSort = (activities ?? []).reduce((m, a) => Math.max(m, a.sort_order), -1)
      await upsertActivity({
        id: newId(),
        workshop_id: workshop.id,
        title: 'New event',
        day: workshop.start_date,
        start_time: null,
        end_time: null,
        sort_order: maxSort + 1,
        genre_group: null,
      })
    })

  const addQuestion = () =>
    withBusy(async () => {
      const n = (ksas ?? []).length + 1
      await upsertKsa({
        id: newId(),
        code: `Q${n}`,
        area: KSA_AREAS[0],
        short_label: 'New question',
        description: '',
        evaluator_facing_prompt: '',
        ai_facing_rubric: null,
        evidence_levels: { '0': '', '1': '', '2': '', '3': '' },
        cbc_subpoint_refs: [],
        guiding_questions: [],
      })
    })

  return (
    <>
      <div className="card">
        <h1>Scenario Builder</h1>
        <p className="small muted">
          Author the events, the questions, and what goes in each box, then wire them together.{' '}
          The people who take part are on <Link to="/admin/roster">Roster</Link>.
        </p>
        <p className="small muted">
          Backend: {isSupabaseConfigured ? 'Supabase — changes sync + are shared' : 'local-only (this device)'}
        </p>
      </div>

      <ScenarioSelector
        workshops={workshops ?? []}
        active={workshop}
        busy={busy}
        onSelect={(id) => setActiveWorkshopId(id)}
        onCreate={(name) =>
          withBusy(async () => {
            const w = await createWorkshop(name)
            setActiveWorkshopId(w.id)
            setMsg(`Created scenario "${w.name}".`)
          })
        }
        onDuplicate={(name) =>
          withBusy(async () => {
            if (!workshop) return
            const w = await duplicateWorkshop(workshop.id, name)
            setActiveWorkshopId(w.id)
            setMsg(`Duplicated into "${w.name}".`)
          })
        }
        onDelete={() =>
          withBusy(async () => {
            if (!workshop) return
            await deleteWorkshop(workshop.id)
            setActiveWorkshopId(null)
            setMsg('Scenario deleted.')
          })
        }
      />
      {msg && <p className="small muted">{msg}</p>}

      {!workshop ? (
        <div className="banner warn">No scenario yet. Create one above, or open Admin to load the sample.</div>
      ) : (
        <>
          <ScenarioDraftPanel workshopId={workshop.id} />

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>Events ({(activities ?? []).length})</h2>
              <button disabled={busy} onClick={addEvent}>Add event</button>
            </div>
            <p className="small muted">The sessions an evaluator picks from. Order sets how they appear.</p>
            {(activities ?? []).map((a) => (
              <ActivityEditor key={a.id} activity={a} busy={busy} />
            ))}
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>Questions ({(ksas ?? []).length})</h2>
              <button disabled={busy} onClick={addQuestion}>Add question</button>
            </div>
            <p className="small muted">
              Shared across all scenarios (a question's code is global). Editing one changes it everywhere it's wired.
            </p>
            {(ksas ?? []).map((k) => (
              <KsaEditor key={k.id} ksa={k} busy={busy} />
            ))}
          </div>

          <div className="card">
            <h2>Wiring</h2>
            <p className="small muted">For each event, choose which questions appear and in what order.</p>
            {(activities ?? []).map((a) => (
              <WiringEditor key={a.id} activity={a} allKsas={ksas ?? []} />
            ))}
          </div>

          <PreviewCard activities={activities ?? []} />
        </>
      )}
    </>
  )
}

function ScenarioSelector({
  workshops,
  active,
  busy,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
}: {
  workshops: Workshop[]
  active: Workshop | null
  busy: boolean
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onDuplicate: (name: string) => void
  onDelete: () => void
}) {
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="card">
      <h2>Scenario</h2>
      <div className="row">
        <select
          value={active?.id ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          disabled={busy || workshops.length === 0}
          style={{ flex: 1 }}
        >
          {workshops.length === 0 && <option value="">(none)</option>}
          {workshops.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        {active && (
          <button className="ghost" disabled={busy} onClick={() => onDuplicate(`${active.name} (copy)`)}>
            Duplicate
          </button>
        )}
      </div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <input
          placeholder="New scenario name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          disabled={busy || !newName.trim()}
          onClick={() => {
            onCreate(newName.trim())
            setNewName('')
          }}
        >
          Create
        </button>
      </div>
      {active && (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          {!confirmDelete ? (
            <button className="ghost small" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete this scenario
            </button>
          ) : (
            <>
              <span className="small">Delete "{active.name}" and all its events, wiring, and roster?</span>
              <button
                className="small"
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(false)
                  onDelete()
                }}
              >
                Yes, delete
              </button>
              <button className="ghost small" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ActivityEditor({ activity, busy }: { activity: Activity; busy: boolean }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = (patch: Partial<Activity>) => upsertActivity({ ...activity, ...patch })
  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}>
      <div className="row">
        <input
          defaultValue={activity.title}
          onBlur={(e) => save({ title: e.target.value })}
          style={{ flex: 1 }}
          aria-label="Event title"
        />
        {!confirmDelete ? (
          <button className="ghost small" disabled={busy} onClick={() => setConfirmDelete(true)}>delete</button>
        ) : (
          <>
            <button className="small" disabled={busy} onClick={() => deleteActivity(activity.id)}>confirm</button>
            <button className="ghost small" onClick={() => setConfirmDelete(false)}>cancel</button>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: '0.3rem', flexWrap: 'wrap' }}>
        <span>
          <label className="small muted">Day</label>
          <input type="date" defaultValue={activity.day ?? ''} onBlur={(e) => save({ day: e.target.value || null })} />
        </span>
        <span>
          <label className="small muted">Start</label>
          <input
            type="datetime-local"
            defaultValue={toLocalInput(activity.start_time)}
            onBlur={(e) => save({ start_time: fromLocalInput(e.target.value) })}
          />
        </span>
        <span>
          <label className="small muted">End</label>
          <input
            type="datetime-local"
            defaultValue={toLocalInput(activity.end_time)}
            onBlur={(e) => save({ end_time: fromLocalInput(e.target.value) })}
          />
        </span>
      </div>
      <div className="row" style={{ marginTop: '0.3rem' }}>
        <span>
          <label className="small muted">Genre / group</label>
          <input defaultValue={activity.genre_group ?? ''} onBlur={(e) => save({ genre_group: e.target.value || null })} />
        </span>
        <span>
          <label className="small muted">Order</label>
          <input
            type="number"
            defaultValue={activity.sort_order}
            onBlur={(e) => save({ sort_order: Number(e.target.value) || 0 })}
            style={{ width: '5rem' }}
          />
        </span>
      </div>
    </div>
  )
}

function KsaEditor({ ksa, busy }: { ksa: Ksa; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Ksa>(ksa)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const levels = draft.evidence_levels ?? {}
  const setLevel = (n: '0' | '1' | '2' | '3', v: string) =>
    setDraft({ ...draft, evidence_levels: { ...levels, [n]: v } })
  const guiding = draft.guiding_questions ?? []
  const setGuiding = (arr: string[]) => setDraft({ ...draft, guiding_questions: arr })

  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="ghost small" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} <strong>{draft.code}</strong> — {draft.short_label || '(no label)'}
        </button>
        {!confirmDelete ? (
          <button className="ghost small" disabled={busy} onClick={() => setConfirmDelete(true)}>delete</button>
        ) : (
          <>
            <button className="small" disabled={busy} onClick={() => deleteKsa(ksa.id)}>confirm</button>
            <button className="ghost small" onClick={() => setConfirmDelete(false)}>cancel</button>
          </>
        )}
      </div>

      {open && (
        <div style={{ marginTop: '0.4rem' }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span>
              <label className="small muted">Code (unique)</label>
              <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
            </span>
            <span style={{ flex: 1 }}>
              <label className="small muted">Area</label>
              <input
                list="ksa-areas"
                value={draft.area}
                onChange={(e) => setDraft({ ...draft, area: e.target.value })}
                style={{ width: '100%' }}
              />
              <datalist id="ksa-areas">
                {KSA_AREAS.map((a) => <option key={a} value={a} />)}
              </datalist>
            </span>
          </div>
          <label className="small muted">Short label (card heading)</label>
          <input value={draft.short_label} onChange={(e) => setDraft({ ...draft, short_label: e.target.value })} />
          <label className="small muted">Description</label>
          <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <label className="small muted">Evaluator-facing prompt (shown while capturing)</label>
          <textarea
            rows={2}
            value={draft.evaluator_facing_prompt}
            onChange={(e) => setDraft({ ...draft, evaluator_facing_prompt: e.target.value })}
          />

          <label className="small muted">Evidence levels — what earns each 0–3</label>
          {(['0', '1', '2', '3'] as const).map((n) => (
            <div key={n} className="row" style={{ alignItems: 'flex-start' }}>
              <strong style={{ width: '1.5rem', paddingTop: '0.5rem' }}>{n}</strong>
              <textarea
                rows={2}
                value={levels[n] ?? ''}
                onChange={(e) => setLevel(n, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ))}

          <label className="small muted">Guiding questions (look/listen for)</label>
          {guiding.map((g, i) => (
            <div key={i} className="row">
              <input
                value={g}
                onChange={(e) => setGuiding(guiding.map((x, j) => (j === i ? e.target.value : x)))}
                style={{ flex: 1 }}
              />
              <button className="ghost small" onClick={() => setGuiding(guiding.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setGuiding([...guiding, ''])}>+ add guiding question</button>

          <label className="small muted" style={{ marginTop: '0.4rem' }}>AI-facing rubric (optional)</label>
          <textarea
            rows={2}
            value={draft.ai_facing_rubric ?? ''}
            onChange={(e) => setDraft({ ...draft, ai_facing_rubric: e.target.value || null })}
          />
          <label className="small muted">CBC sub-point refs (comma-separated)</label>
          <input
            value={(draft.cbc_subpoint_refs ?? []).join(', ')}
            onChange={(e) =>
              setDraft({
                ...draft,
                cbc_subpoint_refs: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              })
            }
          />

          <div className="row" style={{ marginTop: '0.5rem' }}>
            <button
              disabled={busy || !draft.code.trim()}
              onClick={() =>
                upsertKsa({
                  ...draft,
                  guiding_questions: (draft.guiding_questions ?? []).filter((g) => g.trim()),
                })
              }
            >
              Save question
            </button>
            <button className="ghost small" onClick={() => setDraft(ksa)}>Reset</button>
          </div>
        </div>
      )}
    </div>
  )
}

function WiringEditor({ activity, allKsas }: { activity: Activity; allKsas: Ksa[] }) {
  const links = useLiveQuery(
    () => db.activityKsas.where('activity_id').equals(activity.id).sortBy('sort_order'),
    [activity.id],
    [],
  )
  const selectedIds = (links ?? []).map((l) => l.ksa_id)
  const selected = selectedIds.map((id) => allKsas.find((k) => k.id === id)).filter((k): k is Ksa => Boolean(k))
  const available = allKsas.filter((k) => !selectedIds.includes(k.id))

  const move = (i: number, dir: -1 | 1) => {
    const arr = [...selectedIds]
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    void setActivityKsas(activity.id, arr)
  }

  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}>
      <div className="small"><strong>{activity.title}</strong></div>
      {selected.length === 0 && <div className="small muted">No questions wired yet.</div>}
      {selected.map((k, i) => (
        <div key={k.id} className="row" style={{ marginTop: '0.2rem' }}>
          <span className="small" style={{ flex: 1 }}>{k.code} — {k.short_label}</span>
          <button className="ghost small" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
          <button className="ghost small" onClick={() => move(i, 1)} disabled={i === selected.length - 1}>↓</button>
          <button
            className="ghost small"
            onClick={() => void setActivityKsas(activity.id, selectedIds.filter((x) => x !== k.id))}
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
              onClick={() => void setActivityKsas(activity.id, [...selectedIds, k.id])}
            >
              + {k.code}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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
      <h2>Preview</h2>
      <p className="small muted">Exactly what an evaluator sees on the capture screen for the chosen event.</p>
      <select value={chosen} onChange={(e) => setActivityId(e.target.value)}>
        {activities.map((a) => (
          <option key={a.id} value={a.id}>{a.title}</option>
        ))}
      </select>
      {(ksas ?? []).length === 0 ? (
        <div className="small muted" style={{ marginTop: '0.5rem' }}>No questions wired to this event.</div>
      ) : (
        (ksas ?? []).map((k) => (
          <div key={k.id} className="card" style={{ marginTop: '0.5rem' }}>
            <strong>{k.short_label}</strong>
            <p className="small">{k.evaluator_facing_prompt}</p>
            {(k.guiding_questions ?? []).length > 0 && (
              <ul className="small muted">
                {(k.guiding_questions ?? []).map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            )}
            <textarea rows={2} disabled placeholder="(evaluator types their observation here)" />
          </div>
        ))
      )}
    </div>
  )
}
