import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { createDraft } from '../db/evaluations'
import type { Activity } from '../lib/types'

/** Pick the activity nearest to now: prefer the one currently running, else the
 *  most recently finished, else the next upcoming. Returns its id or null. */
function suggestActivity(activities: Activity[], now: number): string | null {
  if (activities.length === 0) return null
  const withTimes = activities.filter((a) => a.start_time)
  // currently running
  const running = withTimes.find((a) => {
    const s = a.start_time ? Date.parse(a.start_time) : NaN
    const e = a.end_time ? Date.parse(a.end_time) : NaN
    return !Number.isNaN(s) && now >= s && (Number.isNaN(e) || now <= e)
  })
  if (running) return running.id
  // most recently finished
  const finished = withTimes
    .filter((a) => a.end_time && Date.parse(a.end_time) <= now)
    .sort((x, y) => Date.parse(y.end_time!) - Date.parse(x.end_time!))
  if (finished[0]) return finished[0].id
  // next upcoming
  const upcoming = withTimes
    .filter((a) => a.start_time && Date.parse(a.start_time) > now)
    .sort((x, y) => Date.parse(x.start_time!) - Date.parse(y.start_time!))
  return upcoming[0]?.id ?? activities[0].id
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function EvaluatorHome() {
  const { identity } = useAuth()
  const navigate = useNavigate()

  const workshop = useLiveQuery(() => db.workshops.toCollection().first(), [])
  const activities = useLiveQuery(
    () =>
      workshop
        ? db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order')
        : Promise.resolve([] as Activity[]),
    [workshop?.id],
    [] as Activity[],
  )

  // The suggestion legitimately depends on the current wall-clock time.
  // eslint-disable-next-line react-hooks/purity
  const suggestedId = useMemo(() => suggestActivity(activities ?? [], Date.now()), [activities])

  const start = async (activityId: string) => {
    const draft = await createDraft({
      evaluatorEmail: identity?.email ?? null,
      workshopId: workshop?.id ?? null,
      activityId,
    })
    navigate(`/capture/${draft.client_id}`)
  }

  if (!workshop) {
    return (
      <main>
        <div className="banner warn">
          No workshop loaded on this device yet. Open <Link to="/admin">Admin</Link> to load one.
        </div>
      </main>
    )
  }

  return (
    <main>
      <div className="card">
        <h1>{workshop.name}</h1>
        <p className="muted small">{workshop.location}</p>
        <p className="small">Pick the activity you're evaluating. The suggested one is based on the time now.</p>
      </div>

      {(activities ?? []).map((a) => (
        <button
          key={a.id}
          className={`activity-item ${a.id === suggestedId ? 'suggested' : ''}`}
          onClick={() => start(a.id)}
        >
          <span>
            <strong>{a.title}</strong>
            <br />
            <span className="muted small">
              {fmtTime(a.start_time)}
              {a.end_time ? `–${fmtTime(a.end_time)}` : ''} {a.genre_group ? `· ${a.genre_group}` : ''}
            </span>
          </span>
          {a.id === suggestedId && <span className="pill">suggested</span>}
        </button>
      ))}

      <div className="card row">
        <Link to="/evaluations">View my evaluations</Link>
        <span className="spacer" />
        <Link to="/routing">Routing</Link>
        <span className="spacer" />
        <Link to="/reports">Reports</Link>
        <span className="spacer" />
        <Link className="small muted" to="/admin">Admin</Link>
      </div>
    </main>
  )
}
