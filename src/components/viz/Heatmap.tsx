import type { HeatCell, HeatmapMatrix } from '../../reports/analytics'
import { useScale } from '../../hooks/useScale'
import { isLowTrigger, maxValue, type Scale } from '../../lib/scale'
import { designationFill, designationInk, isDeemphasized, levelWord } from './viz'

function cellTitle(name: string, ksa: string, c: HeatCell, scale: Scale): string {
  const bits = [name, ksa]
  bits.push(
    c.value === null
      ? 'no evidence yet'
      : `${c.value}/${maxValue(scale)} ${levelWord(scale, c.value)}`,
  )
  if (c.contributing > 0) bits.push(`${c.contributing} observation${c.contributing === 1 ? '' : 's'}`)
  if (c.toVerify > 0) bits.push(`${c.toVerify} awaiting review`)
  if (c.conflict) bits.push('evaluators conflicted')
  return bits.join(' · ')
}

/**
 * Participant x KSA, one cell per representative designation.
 *
 * At workshop scale (28 people, 7 KSAs) the whole matrix fits on one screen, and
 * the eye finds an empty column (a KSA nobody has evidence for) and a pale row
 * (someone in trouble) in about a second. No table or bar chart does that.
 *
 * Two rules make it honest rather than decorative. EMPTY IS NOT ZERO: a null
 * cell is grey with a middle dot, never a 0-coloured fill, because "we have not
 * watched this yet" and "they cannot do this" are opposite findings. And the
 * NUMERAL IS ALWAYS IN THE CELL, which is what makes `plain` a faithful twin
 * rather than a degraded fallback.
 */
export function Heatmap({
  matrix,
  onCell,
  onRow,
  onCol,
  emphasizeRisk = false,
  plain = false,
  caption,
}: {
  matrix: HeatmapMatrix
  onCell?: (participantId: string, ksaCode: string) => void
  onRow?: (participantId: string) => void
  onCol?: (ksaCode: string) => void
  emphasizeRisk?: boolean
  /** strip the fills; same numbers, no colour encoding */
  plain?: boolean
  caption?: string
}) {
  const scale = useScale()
  if (matrix.rows.length === 0) {
    return <div className="empty">No participants to show yet.</div>
  }

  return (
    <div className="heat-wrap">
      <table className={`heat${plain ? ' heat--plain' : ''}`}>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            <th scope="col" />
            {matrix.cols.map((col) => (
              <th key={col.ksa_code} scope="col" title={`${col.short_label} — ${col.goal_title}`}>
                {onCol ? (
                  <button
                    className="ghost btn--sm"
                    style={{ border: 0, padding: 2 }}
                    onClick={() => onCol(col.ksa_code)}
                  >
                    {col.ksa_code}
                  </button>
                ) : (
                  col.ksa_code
                )}
              </th>
            ))}
            <th scope="col" className="heat__margin">
              mean
            </th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row, ri) => (
            <tr key={row.participant_id}>
              <th scope="row" title={row.team_name ?? undefined}>
                {onRow ? (
                  <button onClick={() => onRow(row.participant_id)}>{row.name}</button>
                ) : (
                  row.name
                )}
              </th>
              {matrix.cells[ri].map((cell, ci) => (
                <td key={cell.ksa_code}>
                  <button
                    className="heat__cell"
                    data-d={cell.value === null ? 'none' : cell.value}
                    data-conflict={cell.conflict || undefined}
                    data-trigger={
                      (cell.value !== null && isLowTrigger(scale, cell.value)) || undefined
                    }
                    data-deemph={isDeemphasized(cell.value, scale, emphasizeRisk) || undefined}
                    /* Not set in `plain` mode: an inline style beats any
                       selector, so leaving it on would make `.heat--plain`
                       silently stop stripping the fills — the plain view is the
                       colour-free twin and would have become a copy. */
                    style={
                      plain || cell.value === null
                        ? undefined
                        : ({
                            '--fill': designationFill(cell.value, scale),
                            '--ink-on': designationInk(cell.value, scale),
                          } as React.CSSProperties)
                    }
                    title={cellTitle(row.name, matrix.cols[ci].short_label, cell, scale)}
                    onClick={() => onCell?.(row.participant_id, cell.ksa_code)}
                  >
                    {cell.value === null ? '·' : cell.value}
                  </button>
                </td>
              ))}
              <td className="heat__margin">
                {row.rowStats.reportableMean?.toFixed(1) ??
                  (row.rowStats.n > 0 ? `(${row.rowStats.mean?.toFixed(1)})` : '—')}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="heat__margin">
              mean
            </th>
            {matrix.cols.map((col) => (
              <td key={col.ksa_code} className="heat__margin">
                {col.colStats.reportableMean?.toFixed(1) ??
                  (col.colStats.n > 0 ? `(${col.colStats.mean?.toFixed(1)})` : '—')}
              </td>
            ))}
            <td />
          </tr>
          <tr>
            <th scope="row" className="heat__margin">
              n
            </th>
            {matrix.cols.map((col) => (
              <td
                key={col.ksa_code}
                className={`heat__margin${col.colStats.lowN && col.colStats.n > 0 ? ' n-badge--low' : ''}`}
              >
                {col.colStats.n}
                {col.colStats.lowN && col.colStats.n > 0 ? '⚠' : ''}
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
      <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
        A mean in brackets is computed from fewer than three values and is shown for
        completeness only; it is not a cohort finding.
      </p>
    </div>
  )
}
