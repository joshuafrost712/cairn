import { useMemo } from 'react'

import { useWorkshopEvidence } from '../hooks/useWorkshopEvidence'
import { buildAllReports } from '../reports/build'
import { annotateObservations } from '../reports/verification'
import { PageHeader } from '../layout/PageHeader'
import { EmptyState } from '../components/data/EmptyState'
import { DesignationChip } from '../components/data/DesignationChip'
import { Copy } from '../components/Copy'
import { c } from '../lib/content/chrome'

/**
 * What colleagues said about the people teaching (tl-30).
 *
 * A separate page from `/reports` rather than a filter on it, and the reason is
 * not tidiness. That page counts "N with evidence · M on the roster", offers the
 * finalize gate, and links into the participant-email pipeline — every one of
 * which is a statement about training a cohort. Instructor feedback is three
 * colleagues describing a peer, and the surface should not imply that somebody is
 * being certified by it.
 *
 * WHO SEES WHAT IS NOT DECIDED HERE. `observation_select` and `evaluation_select`
 * have already narrowed the rows to the ones this account may read: the feedback
 * they wrote, the feedback about them, and — for a chief admin or admin — all of
 * it. So this page renders whatever arrives and never filters by viewer. If it
 * shows nothing, that is the database's answer and not a missing branch.
 *
 * The evidence is deliberately shown in full rather than summarized to a number.
 * A representative designation is the right shape for a trainee rollup that feeds
 * a certification decision; for "how did I teach", the sentence a colleague wrote
 * is the whole value and the score is the index.
 */
export function InstructorFeedback() {
  const {
    instructorRoster,
    instructorObservations,
    instructorVerdicts,
    ksas: sortedKsas,
    workshopName,
  } = useWorkshopEvidence()

  const annotated = useMemo(
    () => annotateObservations(instructorObservations, instructorVerdicts),
    [instructorObservations, instructorVerdicts],
  )

  // `teams` is deliberately empty: a facilitator is not on a peer-review team, and
  // passing the workshop's teams in would print a team name under their heading
  // that came from whichever team row happened to match a null.
  const reports = useMemo(
    () => buildAllReports(instructorRoster, sortedKsas, annotated, []),
    [instructorRoster, sortedKsas, annotated],
  )

  const withEvidence = reports.filter((r) => r.totals.evidencedKsas > 0)

  // A rollup carries the question's CODE and its goal title, and neither reads as
  // a heading here: "CC-INS1" is an id and "Instructor Practice" is the same word
  // over all three sections. The short label ("Adult learning", "Teamwork",
  // "Collaborative leadership") is what a person is actually looking for.
  const labelByCode = useMemo(
    () => new Map(sortedKsas.map((k) => [k.code, k.short_label || k.code])),
    [sortedKsas],
  )

  if (instructorRoster.length === 0) {
    return (
      <>
        <PageHeader title={c('instructor-report.title')} meta={workshopName} />
        <EmptyState title={c('instructor-report.none-authored')}>
          <Copy id="instructor-report.none-authored-body" as="p" className="small" />
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={c('instructor-report.title')}
        meta={`${withEvidence.length} of ${instructorRoster.length} · ${workshopName}`}
      />
      <div className="banner info">
        <Copy id="instructor-report.confidentiality" />
      </div>

      {withEvidence.length === 0 && (
        <EmptyState title={c('instructor-report.no-evidence')}>
          <Copy id="instructor-report.no-evidence-body" as="p" className="small" />
        </EmptyState>
      )}

      {withEvidence.map((report) => (
        <div className="card" key={report.participant_id}>
          <h2 style={{ marginTop: 0 }}>{report.participant_name}</h2>
          {report.ksaRollups
            // Only the questions this workshop asks about instructors have any
            // rows; the teaching questions are in `sortedKsas` too and roll up
            // empty for every facilitator. Printing them would suggest Joshua had
            // been assessed on Psalms exegesis by his co-teachers.
            .filter((r) => r.contributing.length + r.toVerify.length > 0)
            .map((rollup) => (
              <div key={rollup.ksa_code} className="rollup">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong>{labelByCode.get(rollup.ksa_code) ?? rollup.ksa_code}</strong>
                  {rollup.representative != null && (
                    <DesignationChip value={rollup.representative} conflict={rollup.conflict} />
                  )}
                </div>
                {[...rollup.contributing, ...rollup.toVerify].map((o) => (
                  <blockquote key={o.id} className="small" style={{ margin: '8px 0 8px 12px' }}>
                    {o.text}
                    <div className="muted small">
                      {/* Who wrote it, because a colleague's assessment is not
                          anonymous feedback and pretending otherwise would change
                          what it means. The evaluator email is on the row already. */}
                      {o.evaluator_email ?? c('instructor-report.unknown-author')}
                    </div>
                  </blockquote>
                ))}
              </div>
            ))}
        </div>
      ))}
    </>
  )
}
