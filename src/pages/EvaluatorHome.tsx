import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import { useAuth } from '../auth/AuthContext'
import { createDraft } from '../db/evaluations'
import { countIn, formatDay, groupActivitiesByDay, suggestActivity } from '../lib/schedule'
import type { DayGroup } from '../lib/schedule'
import type { Activity } from '../lib/types'

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
  const schedule = useMemo(
    () => groupActivitiesByDay(activities ?? [], suggestedId),
    [activities, suggestedId],
  )

  const start = async (activityId: string) => {
    const draft = await createDraft({
      evaluatorEmail: identity?.email ?? null,
      workshopId: workshop?.id ?? null,
      activityId,
    })
    navigate(`/capture/${draft.client_id}`)
  }

  const activityButton = (a: Activity) => (
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
  )

  /** A folded set of days. Closed by default: this is the part you rarely want. */
  const disclosure = (label: string, groups: DayGroup[]) => {
    const n = countIn(groups)
    if (n === 0) return null
    return (
      <details className="day-fold">
        <summary>
          {label} <span className="n-badge">{n}</span>
        </summary>
        {groups.map((g) => (
          <div key={g.day ?? 'undated'} className="day-fold__day">
            {g.day && <div className="day-heading day-heading--sub">{formatDay(g.day)}</div>}
            {g.activities.map(activityButton)}
          </div>
        ))}
      </details>
    )
  }

  if (!workshop) {
    return (
      <>
        <div className="banner warn">
          <Copy id="home.no-workshop.before" /> <Link to="/admin/data">{c('nav.data')}</Link>{' '}
          <Copy id="home.no-workshop.after" />
        </div>
      </>
    )
  }

  // Nothing in the schedule carries a date, so there is no "today" to lead with.
  // Show the flat list rather than an empty focus section with everything folded
  // out of sight: a half-authored scenario has to stay usable.
  const focusDay = schedule.focusDay

  return (
    <>
      <div className="card">
        <h1 data-dfb-node={workshop.id} data-dfb-field="name" data-dfb-source="ref" data-dfb-table="workshop">
          {workshop.name}
        </h1>
        <p className="muted small">{workshop.location}</p>
        <Copy id="home.pick-activity" as="p" className="small" />
      </div>

      {focusDay === null ? (
        (activities ?? []).map(activityButton)
      ) : (
        <>
          {disclosure('Earlier days', schedule.earlier)}

          <div className="day-heading">{formatDay(focusDay)}</div>
          {schedule.focus.map(activityButton)}

          {disclosure('Later days', schedule.later)}
          {schedule.unscheduled.length > 0 &&
            disclosure('Not yet scheduled', [{ day: null, activities: schedule.unscheduled }])}
        </>
      )}
    </>
  )
}
