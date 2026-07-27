import { Link } from 'react-router-dom'
import type { LeniencyDelta } from '../../reports/analytics'
import { MIN_PAIRED_CELLS } from '../../reports/analytics'
import { DataTable } from '../data/DataTable'
import type { Column } from '../data/DataTable'
import { EmptyState } from '../data/EmptyState'
import type { LeniencyCell } from '../../reports/analytics'

/**
 * The receipts behind a delta.
 *
 * This table is the whole point of the evaluator view: it turns "Ruth is
 * strict" into a list of specific shared judgements you can go and read. A
 * number without these rows would be a scoreboard for scoring people.
 */
export function LeniencyTable({ leniency }: { leniency: LeniencyDelta }) {
  if (leniency.cells.length === 0) {
    return (
      <EmptyState title="No shared judgements yet">
        A comparison needs at least one participant and question that this evaluator and someone
        else both scored.
      </EmptyState>
    )
  }

  const columns: Column<LeniencyCell>[] = [
    {
      key: 'participant',
      header: 'participant',
      sticky: true,
      sortValue: (c) => c.participant_name,
      render: (c) => (
        <Link to={`/admin/participants/${c.participant_id}`}>{c.participant_name}</Link>
      ),
    },
    {
      key: 'ksa',
      header: 'question',
      sortValue: (c) => c.ksa_code,
      render: (c) => c.ksa_code,
    },
    {
      key: 'mine',
      header: 'them',
      numeric: true,
      sortValue: (c) => c.mine,
      render: (c) => c.mine.toFixed(1),
    },
    {
      key: 'others',
      header: 'peers',
      numeric: true,
      sortValue: (c) => c.others,
      render: (c) => c.others.toFixed(1),
    },
    {
      key: 'peers',
      header: <span title="How many other evaluators contributed to the peer figure">n peers</span>,
      numeric: true,
      sortValue: (c) => c.peers,
      render: (c) => c.peers,
    },
    {
      key: 'delta',
      header: 'difference',
      numeric: true,
      sortValue: (c) => Math.abs(c.mine - c.others),
      render: (c) => {
        const d = c.mine - c.others
        return (
          <span style={Math.abs(d) >= 2 ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>
            {d > 0 ? '+' : ''}
            {d.toFixed(1)}
            {Math.abs(d) >= 2 && (
              <span title="A spread of 2 or more is an open discrepancy"> ⚑</span>
            )}
          </span>
        )
      },
    },
  ]

  return (
    <DataTable
      rows={leniency.cells}
      columns={columns}
      rowKey={(c) => `${c.participant_id}::${c.ksa_code}`}
      defaultSort="delta"
      defaultDir="desc"
      caption={
        <>
          Shared judgements ({leniency.pairedCells}){' '}
          <span className="muted">
            · each row is a participant and question this evaluator and at least one colleague both
            scored
            {leniency.pairedCells < MIN_PAIRED_CELLS
              ? `. Below ${MIN_PAIRED_CELLS} the aggregate is withheld, but the individual rows still stand.`
              : ''}
          </span>
        </>
      }
    />
  )
}
