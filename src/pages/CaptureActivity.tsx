import { useParams, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import { EVALUATING_ROLES, useHasWorkshopRole } from '../layout/roles'
import { isInstructorActivity } from '../lib/instructors'
import { resolvedRow } from '../lib/capture'
import { CaptureForm } from './CaptureForm'

/**
 * Resolves which capture this is, then hands it to the form.
 *
 * The split exists because of the defect it closes. `useLiveQuery` keeps its
 * previous result across a dependency change, so /capture/A to /capture/B without
 * a remount gives at least one committed render where the route says B and the row
 * is still A's. The old single component seeded its answers from whichever row was
 * in hand and wrote them back keyed on the route's id, which is how one CIT's words
 * could be filed under another's. Now the form is mounted keyed on the row's own
 * client_id: a different capture is a different mount, so there is nothing to
 * carry over, and `resolvedRow` holds the screen until the two ids agree.
 *
 * Both guards below are refusals about the capture rather than about the row, so
 * they belong here and not in the form.
 */
export function CaptureActivity() {
  const { clientId = '' } = useParams()
  const canEvaluateTrainees = useHasWorkshopRole(EVALUATING_ROLES)

  // `?? null` so absent and not-yet-loaded are distinguishable. Without it the
  // not-found banner below flashed on the first paint of every capture, since
  // useLiveQuery returns undefined until the get resolves.
  const queriedRecord = useLiveQuery(
    async () => (await db.evaluations.get(clientId)) ?? null,
    [clientId],
  )
  const record = resolvedRow(clientId, queriedRecord, (r) => r.client_id)
  const activityId = record.status === 'ready' ? record.row.activity_id : null

  const queriedActivity = useLiveQuery(
    async () => (activityId ? ((await db.activities.get(activityId)) ?? null) : null),
    [activityId],
  )
  // The activity needs the same identity check for the same reason: the frame
  // after `record` flips from A to B, this query is still holding A's activity.
  const activityRow = resolvedRow(activityId, queriedActivity, (a) => a.id)

  if (record.status === 'loading') return null
  if (record.status === 'absent') {
    return (
      <div className="banner warn">
        <Copy id="capture.not-found.before" /> <Link to="/">{c('capture.not-found.link')}</Link>
      </div>
    )
  }

  // Review fix, 2026-08-18: the guard waits for the activity. `instructorReview`
  // would be false on the first paint of every capture otherwise — and the
  // refusal below would flash on the screen of the one person it is written
  // about, on the only screen she has. A capture with no activity at all
  // resolves to 'absent' and falls through here, which is the case the refusal
  // is actually for.
  if (activityRow.status === 'loading') return null
  const activity = activityRow.status === 'ready' ? activityRow.row : null

  // tl-30. The route gate cannot make this call: whether a capture is allowed
  // depends on the ACTIVITY behind this record, which the router does not know.
  // A reviewer-only member (Angie holds `participant`) may reach /capture for
  // their instructor review and nothing else, and typing another capture's URL
  // must not put a trainee grid in front of them.
  //
  // Not a security boundary. `evaluation_insert` refuses the write either way;
  // this is here so the refusal happens before the dictation rather than after.
  const instructorReview = isInstructorActivity(activity)
  if (!instructorReview && !canEvaluateTrainees) {
    return (
      <div className="banner warn">
        <Copy id="capture.not-yours" /> <Link to="/">{c('capture.not-found.link')}</Link>
      </div>
    )
  }

  return (
    <CaptureForm
      key={record.row.client_id}
      record={record.row}
      activity={activity}
      instructorReview={instructorReview}
    />
  )
}
