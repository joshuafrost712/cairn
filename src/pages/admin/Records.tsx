import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { RecordsBrowser } from '../../components/RecordsBrowser'

/**
 * The correction surface: browse one participant's whole record and fix it.
 *
 * Selection lives in `?participant=` so other pages can route straight here.
 * The workbench needs that: "this line's evidence is wrong" has to land on the
 * right person's record in one click, not on a picker.
 *
 * Kept distinct from /admin/participants, which is the read-only analytic view
 * of the same person. Two pages sounds redundant until you notice that one of
 * them can change a designation, and that separation is why the dashboard can
 * never be the thing that silently edited a score.
 */
export function Records() {
  const [params, setParams] = useSearchParams()
  const participantId = params.get('participant') ?? ''

  const select = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('participant', id)
    else next.delete('participant')
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="Participant records"
        crumbs={[{ label: 'Configure' }, { label: 'Records' }]}
      />

      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          The full evidence record for any participant, with admin corrections to observations and
          a way to append data after the fact (a late-session performance, say). Disputes that came
          from evaluators disagreeing belong on <Link to="/observations">Observations</Link> and the{' '}
          <Link to="/inbox">Discrepancy inbox</Link> instead, where the verdict trail is kept.
        </p>
        {participantId && (
          <p className="small muted">
            Read-only view of the same person:{' '}
            <Link to={`/admin/participants/${participantId}`}>their dashboard page</Link>.
          </p>
        )}
        <RecordsBrowser participantId={participantId} onSelectParticipant={select} />
      </div>
    </>
  )
}
