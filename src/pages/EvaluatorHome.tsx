import { useMemo, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useDisplayWorkshopId } from '../hooks/useWorkshopEvidence'
import { resolveDisplayWorkshop } from '../reports/scope'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import { useAuth } from '../auth/AuthContext'
import { createDraft } from '../db/evaluations'
import { reviewPairsFor } from '../db/instructors'
import { isInstructorActivity } from '../lib/instructors'
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

  // One shared answer to "which workshop am I showing" (tl-29): the membership-validated
  // selection, else the device's own, else the only workshop here, else nothing.
  const activeWorkshopId = useDisplayWorkshopId()
  const workshop = useLiveQuery(
    async () => resolveDisplayWorkshop(await db.workshops.toArray(), activeWorkshopId),
    [activeWorkshopId],
  )
  const allActivities = useLiveQuery(
    () =>
      workshop
        ? db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order')
        : Promise.resolve([] as Activity[]),
    [workshop?.id],
    [] as Activity[],
  )
  // tl-30. The pairs this account holds here. Empty for everybody except the five
  // reviewers, which is what keeps the Instructor feedback event off every other
  // home screen. RLS has already filtered the rows; this only decides rendering.
  const reviewPairs = useLiveQuery(
    () => (workshop ? reviewPairsFor(workshop.id, identity?.email) : Promise.resolve([])),
    [workshop?.id, identity?.email],
    [],
  )

  // The teaching schedule and the instructor event are two lists, not one sorted
  // list, because they answer different questions. The schedule is "what is
  // happening now"; the instructor event is undated on purpose (Joshua chose one
  // review per instructor per event, not session by session), so it has no place
  // in a day fold and would sit at the bottom of "Not yet scheduled" looking like
  // an authoring mistake.
  const activities = useMemo(
    () => (allActivities ?? []).filter((a) => !isInstructorActivity(a)),
    [allActivities],
  )
  const instructorEvents = useMemo(
    () =>
      reviewPairs.length === 0 ? [] : (allActivities ?? []).filter((a) => isInstructorActivity(a)),
    [allActivities, reviewPairs.length],
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

  /**
   * `index` is the stagger position, and it arrives for free: every call site is a
   * `.map(activityButton)`, which already hands the callback (item, index).
   *
   * Capped at 8 (motion.css multiplies it by 40ms). Uncapped, a thirty-activity day
   * would take 1.2 seconds to finish appearing, and the person waiting is standing
   * in a workshop room with a session already under way. The counter restarts per
   * day group on purpose: each fold is a list in its own right.
   */
  const activityButton = (a: Activity, index = 0) => (
    <button
      key={a.id}
      className={`activity-item ${a.id === suggestedId ? 'suggested' : ''}`}
      style={{ '--i': Math.min(index, 8) } as CSSProperties}
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

  // A reviewer-only account (Angie holds `participant`, not `evaluator`) reads no
  // trainee activity at all, so the teaching list is genuinely empty for her and
  // the "pick an activity" line would be a lie. Her whole app is the one button.
  const reviewerOnly = activities.length === 0 && instructorEvents.length > 0

  return (
    <>
      <div className="card">
        <h1 data-dfb-node={workshop.id} data-dfb-field="name" data-dfb-source="ref" data-dfb-table="workshop">
          {workshop.name}
        </h1>
        <p className="muted small">{workshop.location}</p>
        <Copy id={reviewerOnly ? 'home.reviewer-only' : 'home.pick-activity'} as="p" className="small" />
      </div>

      {instructorEvents.length > 0 && (
        <div className="card instructor-block">
          <Copy id="home.instructor-heading" as="h2" style={{ marginTop: 0 }} />
          <Copy id="home.instructor-help" as="p" className="muted small" />
          {instructorEvents.map((a) => (
            <button key={a.id} className="activity-item" onClick={() => start(a.id)}>
              <span>
                <strong>{a.title}</strong>
                <br />
                <Copy id="home.instructor-count" tokens={{ n: reviewPairs.length }} className="muted small" />
              </span>
            </button>
          ))}
        </div>
      )}

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
