import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
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

  const activeWorkshopId = useActiveWorkshopId()
  const workshop = useLiveQuery(
    async () => {
      if (activeWorkshopId) {
        const w = await db.workshops.get(activeWorkshopId)
        if (w) return w
      }
      return db.workshops.toCollection().first()
    },
    [activeWorkshopId],
  )
  const activities = useLiveQuery(
    () =>
      workshop
        ? db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order')
        : Promise.resolve([] as Activity[]),
    [workshop?.id],
    [] as Activity[],
  )

  // The badge counts that used to be computed here (the whole
  // annotateObservations -> buildAllReports -> findDiscrepancies pipeline, run on
  // every render just to print one number) now live in useNavCounts, which the
  // sidebar owns. This page is back to being about picking an activity.

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
      <>
        <div className="banner warn">
          <Copy id="home.no-workshop.before" /> <Link to="/admin">{c('nav.admin')}</Link>{' '}
          <Copy id="home.no-workshop.after" />
        </div>
      </>
    )
  }

  return (
    <>
      <div className="card">
        <h1 data-dfb-node={workshop.id} data-dfb-field="name" data-dfb-source="ref" data-dfb-table="workshop">
          {workshop.name}
        </h1>
        <p className="muted small">{workshop.location}</p>
        <Copy id="home.pick-activity" as="p" className="small" />
      </div>

      {(activities ?? []).map((a) => (
        <button
          key={a.id}
          className={`activity-item ${a.id === suggestedId ? 'suggested' : ''}`}
          onClick={() => start(a.id)}
        >
          <span>
            <strong data-dfb-node={a.id} data-dfb-field="title" data-dfb-source="ref" data-dfb-table="activity">
              {a.title}
            </strong>
            <br />
            <span className="muted small">
              {fmtTime(a.start_time)}
              {a.end_time ? `–${fmtTime(a.end_time)}` : ''} {a.genre_group ? `· ${a.genre_group}` : ''}
            </span>
          </span>
          {a.id === suggestedId && <Copy id="home.suggested-pill" className="pill" />}
        </button>
      ))}

    </>
  )
}
