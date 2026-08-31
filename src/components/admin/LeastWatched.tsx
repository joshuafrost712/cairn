import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { coverageForWorkshop } from '../../db/coverage'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'

/**
 * "Who has nobody watched yet", on an evaluator's own home (tl-38 §5).
 *
 * It does NOT call `workshop_health`. An evaluator is not permitted to run that
 * RPC and should not be: it names every other evaluator, their unsubmitted drafts
 * and their silence. This card reads `db.coverage`, which `startCoverageSync`
 * already keeps on every device, so it needs no new permission and no new read.
 *
 * THE TWO NUMBERS WILL DISAGREE, AND THE CARD SAYS SO. The briefing counts routed
 * observations plus pending mentions, from the server. This counts submitted
 * captures naming a participant, from a device cache. Both are right about
 * different questions, and `least-watched.intro` is what stops somebody
 * reconciling them and concluding one is broken.
 *
 * Names and counts only. No designation, no observation text, no evaluator email.
 */
export function LeastWatched({ workshopId }: { workshopId: string | null }) {
  const rows = useLiveQuery(
    async () => {
      if (!workshopId) return null
      const [coverage, participants] = await Promise.all([
        coverageForWorkshop(workshopId),
        db.participants.where('workshop_id').equals(workshopId).toArray(),
      ])
      return participants
        .filter((p) => p.category !== 'instructor')
        .map((p) => ({ id: p.id, name: p.name, count: coverage.get(p.id)?.count ?? 0 }))
        .sort((a, b) => a.count - b.count || a.name.localeCompare(b.name))
        .slice(0, 5)
    },
    [workshopId],
    null,
  )

  if (!rows || rows.length === 0) return null

  return (
    <div className="card">
      <h2>
        <Copy id="least-watched.title" />
      </h2>
      <p className="muted small">
        <Copy id="least-watched.intro" />
      </p>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {row.name} <span className="muted small">{c('least-watched.count', 'label', { count: row.count })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
