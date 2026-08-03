import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { commitImport, listImportBatches, undoImport, type UndoResult } from '../../db/rosterImport'
import { c } from '../../lib/content/chrome'
import { useAuth } from '../../auth/AuthContext'
import { countsForRosterImport, countsForRosterUndo } from '../../setup/counts'
import { useSetupSave } from '../../setup/useSetupSave'
import { parseDelimited } from '../../roster/parseDelimited'
import {
  columnLabel,
  ignoredColumns,
  readHeaders,
  ROSTER_FIELDS,
  type ColumnMapping,
  type HeaderReading,
  type RosterField,
} from '../../roster/mapColumns'
import { planImport, type ImportPlan, type PlannedRow } from '../../roster/planImport'
import type { Grid } from '../../roster/parseDelimited'
import type { Participant, RosterImportBatch, Team } from '../../lib/types'

/**
 * Roster import (tl-10): the spreadsheet you already keep, instead of typing
 * twenty-eight names into a table.
 *
 * Rendered inside the Setup hub's Participants section rather than as a ninth
 * section of its own, which is a deviation from the spec's file inventory and a
 * deliberate one. Importing is something you do TO the roster, and putting it
 * behind its own tab would have added a step to the hub's section list, the
 * first-run sequence, and the completeness cards, where it would permanently read
 * "complete" because there is nothing about an import that can be unset. It sits
 * where the roster is, collapsed until asked for.
 *
 * THE ORDER IS THE SPEC. Choose a file, confirm what each column is, read a verdict
 * for every row, then commit. Nothing is written before the last of those, and the
 * thing committed is the plan on screen rather than a re-derivation of it.
 */
export function RosterImport({ workshopId }: { workshopId: string }) {
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()
  const fileInput = useRef<HTMLInputElement | null>(null)

  const [open, setOpen] = useState(false)
  const [filename, setFilename] = useState('')
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [reading, setReading] = useState<HeaderReading | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Map<number, boolean>>(new Map())
  const [outcome, setOutcome] = useState<string | null>(null)

  const participants = useLiveQuery(
    () => db.participants.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Participant[],
  )
  const teams = useLiveQuery(
    () => db.teams.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Team[],
  )
  const batches = useLiveQuery(
    () => listImportBatches(workshopId),
    [workshopId],
    [] as RosterImportBatch[],
  )

  /**
   * The plan, recomputed on every mapping change. Cheap (a few hundred rows of pure
   * array work) and worth doing eagerly: changing a dropdown and watching the
   * verdicts change is how an administrator finds out they mapped the wrong column,
   * which is the mistake a preview exists to catch.
   */
  const plan: ImportPlan | null = useMemo(() => {
    if (!reading || !mapping) return null
    const base = planImport({
      dataRows: reading.dataRows,
      mapping,
      participants: participants ?? [],
      teams: teams ?? [],
      firstDataLine: (reading.headerRow ?? -1) + 2,
    })
    if (overrides.size === 0) return base
    const rows = base.rows.map((row) =>
      overrides.has(row.line) ? { ...row, selected: overrides.get(row.line) as boolean } : row,
    )
    return { ...base, rows }
  }, [reading, mapping, participants, teams, overrides])

  const selectedRows = plan?.rows.filter((r) => r.selected) ?? []

  const reset = () => {
    setReading(null)
    setMapping(null)
    setOverrides(new Map())
    setFilename('')
    setError(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const onFile = async (file: File) => {
    setError(null)
    setOutcome(null)
    setOverrides(new Map())
    setFilename(file.name)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Sniffed rather than trusted from the extension: a .xlsx saved as .csv is a
      // real thing people send, and "PK" is the zip magic every xlsx starts with.
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
      let parsed: Grid
      if (isZip) {
        // Dynamic, so the zip reader and the sheet scanner are their own chunk and
        // the 95% of sessions that never import a spreadsheet never download them.
        const { canReadSpreadsheets, parseSpreadsheet } = await import('../../roster/parseSpreadsheet')
        if (!canReadSpreadsheets()) {
          setError(c('roster.import.no-xlsx'))
          setReading(null)
          return
        }
        parsed = await parseSpreadsheet(bytes)
      } else {
        parsed = parseDelimited(new TextDecoder('utf-8').decode(bytes))
      }
      const read = readHeaders(parsed)
      setReading(read)
      setMapping(read.mapping)
      if (read.headers.length === 0) setError(c('roster.import.no-rows'))
    } catch (err) {
      setReading(null)
      setError(c('roster.import.parse-error', 'label', { reason: String(err) }))
    }
  }

  const commit = async () => {
    if (!plan) return
    const counts = await countsForRosterImport(plan, workshopId)
    await request({
      change: {
        entity: 'roster_import',
        operation: 'create',
        entityId: null,
        label: filename,
        counts,
      },
      commit: async () => {
        const result = await commitImport({
          workshopId,
          plan,
          filename,
          actorEmail: identity?.email ?? null,
        })
        setOutcome(
          c('roster.import.committed', 'label', {
            created: result.created,
            updated: result.updated,
            unchanged: result.unchanged,
            teams: result.teamsCreated,
          }),
        )
        reset()
      },
    })
  }

  const undo = async (batch: RosterImportBatch) => {
    const counts = await countsForRosterUndo(batch)
    await request({
      change: {
        entity: 'roster_import',
        operation: 'delete',
        entityId: batch.id,
        label: batch.filename,
        counts,
      },
      commit: async () => {
        const result: UndoResult = await undoImport(batch.id, identity?.email ?? null)
        setOutcome(describeUndo(result))
      },
    })
  }

  return (
    <div className="card form-col">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{c('roster.import.title')}</h2>
        <button className="btn--sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {c(open ? 'roster.import.hide' : 'roster.import.show')}
        </button>
      </div>
      <p className="small muted">{c('roster.import.help')}</p>

      {outcome && <div className="banner">{outcome}</div>}

      {open && (
        <>
          <div className="row">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx"
              aria-label={c('roster.import.choose-file')}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onFile(file)
              }}
            />
            <button className="btn--sm" onClick={downloadTemplate}>
              {c('roster.import.template')}
            </button>
          </div>
          <p className="small muted">{c('roster.import.template-note')}</p>

          {error && <div className="banner warn">{error}</div>}

          {plan && mapping && reading && (
            <>
              <h3>{c('roster.import.mapping-title')}</h3>
              <p className="small muted">{c('roster.import.mapping-help')}</p>
              <div className="row row--top">
                {ROSTER_FIELDS.map((field) => (
                  <span key={field}>
                    <label htmlFor={`map-${field}`} className="small muted">
                      {c(`roster.import.field.${field}`)}
                    </label>
                    <select
                      id={`map-${field}`}
                      className="cell-select"
                      value={mapping[field] ?? ''}
                      onChange={(e) =>
                        setMapping(applyMapping(mapping, field, e.target.value === '' ? null : Number(e.target.value)))
                      }
                    >
                      <option value="">{c('roster.import.unmapped')}</option>
                      {reading.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header || columnLabel(index)}
                        </option>
                      ))}
                    </select>
                  </span>
                ))}
              </div>
              {ignoredColumns(reading.rawHeaders, mapping).length > 0 && (
                <p className="small muted">
                  {c('roster.import.ignored', 'label', {
                    columns: ignoredColumns(reading.rawHeaders, mapping).join(', '),
                  })}
                </p>
              )}

              <h3>{c('roster.import.preview-title')}</h3>
              <p className="small">
                {c('roster.import.summary', 'label', {
                  create: plan.summary.create,
                  update: plan.summary.update,
                  unchanged: plan.summary.unchanged,
                  duplicate: plan.summary.duplicate,
                  error: plan.summary.error,
                })}
              </p>
              <p className="small muted">{c('roster.import.blank-note')}</p>

              <div className="dt-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th />
                      <th>{c('roster.import.col.row')}</th>
                      <th>{c('roster.import.col.verdict')}</th>
                      <th>{c('roster.import.col.person')}</th>
                      <th>{c('roster.import.col.detail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.map((row) => (
                      <PreviewRow
                        key={row.line}
                        row={row}
                        onToggle={(next) =>
                          setOverrides(new Map(overrides).set(row.line, next))
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row">
                <button disabled={busy || selectedRows.length === 0} onClick={() => void commit()}>
                  {c('roster.import.commit', 'label', { rows: selectedRows.length })}
                </button>
                <button className="ghost" disabled={busy} onClick={reset}>
                  {c('roster.import.cancel')}
                </button>
              </div>
            </>
          )}
        </>
      )}

      <h3>{c('roster.import.batches-title')}</h3>
      {(batches ?? []).length === 0 ? (
        <p className="small muted">{c('roster.import.batches-empty')}</p>
      ) : (
        (batches ?? []).map((batch) => (
          <p className="small" key={batch.id}>
            <strong>{batch.filename}</strong> · {batch.at.slice(0, 16).replace('T', ' ')} ·{' '}
            {c('roster.import.batch-detail', 'label', {
              created: batch.created_participants.length,
              updated: batch.updated_participants.length,
              rows: batch.row_count,
            })}{' '}
            {batch.undone_at ? (
              <span className="pill local">{c('roster.import.undone-pill')}</span>
            ) : (
              <button className="btn--sm danger-quiet" disabled={busy} onClick={() => void undo(batch)}>
                {c('roster.import.undo')}
              </button>
            )}
          </p>
        ))
      )}
    </div>
  )
}

const VERDICT_PILL: Record<PlannedRow['verdict'], string> = {
  create: 'ok',
  update: 'queued',
  unchanged: 'local',
  duplicate: 'local',
  error: 'error',
}

function PreviewRow({ row, onToggle }: { row: PlannedRow; onToggle: (next: boolean) => void }) {
  const committable = row.verdict === 'create' || row.verdict === 'update' || row.verdict === 'unchanged'
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={row.selected}
          disabled={!committable}
          aria-label={`Include row ${row.line}`}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </td>
      <td className="num">{row.line}</td>
      <td>
        <span className={`pill ${VERDICT_PILL[row.verdict]}`}>
          {c(`roster.import.verdict.${row.verdict}`)}
        </span>
      </td>
      <td>
        <strong>{row.label}</strong>
        {row.values.registered_email && <div className="small muted">{row.values.registered_email}</div>}
      </td>
      <td className="small">
        {row.changes.map((change) => (
          <div key={change.field}>
            {c(`roster.import.change.${change.field}`, 'label', {
              before: change.beforeLabel ?? change.before ?? c('roster.import.blank'),
              after: change.afterLabel ?? change.after ?? c('roster.import.blank'),
            })}
          </div>
        ))}
        {[...row.errors, ...row.warnings].map((issue) => (
          <div key={issue} className={row.errors.includes(issue) ? 'danger-text' : 'muted'}>
            {c(`roster.import.issue.${issue}`, 'label', { team: row.newTeamName ?? '' })}
          </div>
        ))}
      </td>
    </tr>
  )
}

function applyMapping(mapping: ColumnMapping, field: RosterField, column: number | null): ColumnMapping {
  const next: ColumnMapping = { ...mapping, [field]: column }
  if (column === null) return next
  // One column, one field. Claiming a column already used elsewhere releases it
  // there rather than importing the same text twice under two meanings.
  for (const other of ROSTER_FIELDS) {
    if (other !== field && next[other] === column) next[other] = null
  }
  return next
}

function describeUndo(result: UndoResult): string {
  if (result.error) return c(`roster.import.undo-error.${result.error}`)
  const base = c('roster.import.undone', 'label', {
    deleted: result.deleted,
    reverted: result.reverted,
    teams: result.teamsDeleted,
  })
  if (result.refused.length === 0) return base
  return `${base} ${c('roster.import.undo-refused', 'label', {
    names: result.refused.map((r) => `${r.name} (${r.observations})`).join(', '),
  })}`
}

/**
 * A file that imports cleanly, offered rather than described.
 *
 * Built in the browser rather than served as an asset: it is four words and a blank
 * line, and a static file in `public/` would be one more thing that can drift from
 * the header wordings mapColumns actually recognizes.
 */
function downloadTemplate() {
  const csv = 'Name,Email,Team,Language\nAmos Situmorang,amos@example.org,Team A,Indonesian\n'
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'roster-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}
