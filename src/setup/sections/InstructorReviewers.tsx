import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { db } from '../../db/local'
import { setInstructorReviewPair } from '../../db/instructors'
import { instructorReviewPk, instructors, normalizeEmail } from '../../lib/instructors'
import { useWorkshopRole } from '../../layout/roles'
import { c } from '../../lib/content/chrome'
import { Copy } from '../../components/Copy'
import type { InstructorReviewPair, Participant, Workshop, WorkshopPerson } from '../../lib/types'

/**
 * Who may give each instructor feedback (tl-30).
 *
 * A grid rather than a per-person form, because the thing an administrator needs
 * to check is a SHAPE: is anybody reviewing themselves, is anybody being reviewed
 * by nobody, and is the one deliberate asymmetry still there. A list of five
 * forms hides all three questions behind five clicks.
 *
 * Chief admin only, matching `set_instructor_review_pair`. A plain admin sees the
 * grid read-only rather than not at all: knowing who reviews whom is part of
 * running the course, and hiding it would just move the question to Joshua.
 *
 * ROWS ARE ADDRESSES, NOT ACCOUNTS. Three of the five reviewers had no account
 * when the pairs were written, so the row list is the union of the workshop's
 * known people and every address already holding a pair. An address with no
 * account is shown with a note rather than hidden: it is a grant that is real and
 * will start working the moment they sign in, and an admin who could not see it
 * would grant it a second time.
 */
export function InstructorReviewers({ workshop }: { workshop: Workshop }) {
  const workshopId = workshop.id
  const role = useWorkshopRole()
  const canEdit = role === 'chief_admin'
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const roster = useLiveQuery(
    () => db.participants.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Participant[],
  )
  const pairs = useLiveQuery(
    () => db.instructorReviewPairs.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as InstructorReviewPair[],
  )
  const people = useLiveQuery(
    () => db.workshopPeople.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as WorkshopPerson[],
  )

  const teaching = instructors(roster).sort((a, b) => a.name.localeCompare(b.name))
  if (teaching.length === 0) return null

  const known = new Map<string, string>()
  for (const p of people) known.set(normalizeEmail(p.email), p.name)
  const rows = [...new Set([...known.keys(), ...pairs.map((r) => normalizeEmail(r.reviewer_email))])]
    .filter(Boolean)
    .sort()

  const held = new Set(pairs.map((r) => instructorReviewPk(workshopId, r.reviewer_email, r.instructor_participant_id)))

  const toggle = async (email: string, instructor: Participant, on: boolean) => {
    const key = `${email}::${instructor.id}`
    setBusy(key)
    setMsg(null)
    const result = await setInstructorReviewPair(workshopId, email, instructor.id, on)
    setBusy(null)
    setMsg(
      result.ok
        ? c(on ? 'instructor-grid.granted' : 'instructor-grid.revoked')
            .replace('{who}', known.get(email) ?? email)
            .replace('{instructor}', instructor.name)
        : result.message,
    )
  }

  return (
    <section className="card">
      <Copy id="instructor-grid.heading" as="h2" style={{ marginTop: 0 }} />
      <Copy id="instructor-grid.help" as="p" className="muted small" />
      {!canEdit && <Copy id="instructor-grid.read-only" as="p" className="muted small" />}
      {msg && <div className="banner info">{msg}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{c('instructor-grid.reviewer')}</th>
              {teaching.map((i) => (
                <th key={i.id} scope="col">
                  {i.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((email) => {
              const name = known.get(email)
              return (
                <tr key={email}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 'normal' }}>
                    {name ?? email}
                    {!name && (
                      <>
                        <br />
                        <Copy id="instructor-grid.no-account" className="muted small" />
                      </>
                    )}
                  </th>
                  {teaching.map((i) => {
                    // The subject's own cell. Rendered as a dash rather than as an
                    // unchecked box: an empty checkbox invites a click that the
                    // trigger would refuse, and the refusal would read as a bug
                    // rather than as the rule it is.
                    //
                    // Matched on the roster address only. The server also catches
                    // the case where the reviewer's ACCOUNT links to the same
                    // person as the instructor row, which this cannot see because
                    // `WorkshopPerson` carries no `person_id`. That is the right
                    // division: the grid is a convenience, the trigger is the rule.
                    const isSelf = normalizeEmail(i.registered_email) === email
                    const key = `${email}::${i.id}`
                    const on = held.has(instructorReviewPk(workshopId, email, i.id))
                    return (
                      <td key={i.id} style={{ textAlign: 'center' }}>
                        {isSelf ? (
                          <span className="muted" aria-label={c('instructor-grid.self')}>
                            &ndash;
                          </span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!canEdit || busy === key}
                            aria-label={`${name ?? email} reviews ${i.name}`}
                            onChange={(e) => void toggle(email, i, e.target.checked)}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
