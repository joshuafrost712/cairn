import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  /** Right-aligned with tabular numerals. */
  numeric?: boolean
  /** Omit to make the column unsortable. Return a comparable primitive. */
  sortValue?: (row: T) => string | number | null
  render: (row: T) => ReactNode
  /** Pin to the left edge while the table scrolls horizontally. */
  sticky?: boolean
  width?: string | number
}

/**
 * The dashboard's one table.
 *
 * The repo had no <table> at all before this; every list was a stack of cards,
 * which stops working the moment you want to compare a column across 28 rows.
 * Sorting is local state because these tables are page-sized, not paginated:
 * lifting it into the URL would mean threading a sort key through every caller
 * for a preference nobody links to.
 *
 * `defaultSort` should be the honest default for the data, which for anything
 * on a 0-3 scale means the at-risk count rather than the mean.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  defaultSort,
  defaultDir = 'desc',
  onRowClick,
  selectedKey,
  expandedKey,
  renderDetail,
  empty,
  footer,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  caption?: ReactNode
  defaultSort?: string
  defaultDir?: 'asc' | 'desc'
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  /** The one row currently expanded, if any. Pairs with `renderDetail`. */
  expandedKey?: string | null
  /**
   * Extra panel rendered in a full-width row directly beneath the expanded row.
   *
   * This is for editing a row in place. Putting the panel in the table rather
   * than above it matters on a 28-person roster: a form that opens at the top of
   * the card is off-screen for anyone you scrolled down to reach, so you would be
   * editing a name you can no longer see.
   */
  renderDetail?: (row: T) => ReactNode
  empty?: ReactNode
  footer?: ReactNode
}) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSort ?? null)
  const [dir, setDir] = useState<'asc' | 'desc'>(defaultDir)

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    return [...rows].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      // Nulls sort last in both directions: "no data" is not a low score.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [rows, columns, sortKey, dir])

  const toggle = (key: string) => {
    if (sortKey === key) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setDir('desc')
    }
  }

  if (rows.length === 0 && empty) {
    return <div className="dt-wrap">{empty}</div>
  }

  return (
    <div className="dt-wrap">
      <table className="dt">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sortKey === c.key
              return (
                <th
                  key={c.key}
                  className={[c.numeric ? 'num' : '', c.sticky ? 'sticky-col' : '', c.sortValue ? 'sortable' : '']
                    .filter(Boolean)
                    .join(' ')}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={c.sortValue ? () => toggle(c.key) : undefined}
                >
                  {c.header}
                  {c.sortValue && (
                    <span className="sort-caret" aria-hidden="true">
                      {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
                    </span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row)
            const expanded = expandedKey != null && expandedKey === key
            return (
              <Fragment key={key}>
                <tr
                  className={[
                    onRowClick ? 'clickable' : '',
                    selectedKey === key || expanded ? 'selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[c.numeric ? 'num' : '', c.sticky ? 'sticky-col' : '']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {expanded && renderDetail && (
                  <tr className="dt-detail">
                    <td colSpan={columns.length}>{renderDetail(row)}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
