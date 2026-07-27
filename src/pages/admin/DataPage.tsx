import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { primeFromSeed } from '../../db/reference'
import { exportAll, importAll } from '../../db/backup'
import { downloadText } from '../../lib/download'
import { loadDemoScenario } from '../../data/demoScenario'
import { PageHeader } from '../../layout/PageHeader'
import { ConfirmAction } from '../../components/data/ConfirmAction'

/**
 * Everything that can destroy or replace data, on one page, behind guards.
 *
 * These three actions used to sit as plain buttons among the roster fields.
 * Restore upserts across every table and the demo loader wipes and reseeds, so
 * a stray click on the wrong card during a live workshop was a real way to lose
 * an evening's evidence. They are gathered here so that the page itself is the
 * warning, and each one is armed by typing.
 */
export function DataPage() {
  const [busy, setBusy] = useState(false)
  const [restore, setRestore] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const counts = useLiveQuery(
    async () => ({
      captures: await db.evaluations.count(),
      observations: await db.observations.count(),
      verdicts: await db.verifications.count(),
      participants: await db.participants.count(),
    }),
    [],
    null,
  )

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const holdings = counts
    ? `${counts.captures} captures · ${counts.observations} observations · ${counts.verdicts} verdicts · ${counts.participants} participants`
    : 'counting…'

  return (
    <>
      <PageHeader
        title="Data"
        crumbs={[{ label: 'Configure' }, { label: 'Data' }]}
        meta={`On this device: ${holdings}`}
      />

      <div className="card">
        <h2>Back up</h2>
        <p className="small muted">
          Everything on this device (reference, captures, observations, verdicts) as one JSON file.
          Do this before any of the actions further down, and before a reinstall: the evidence lives
          in this browser's storage, and clearing site data takes it with it.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            withBusy(async () => {
              downloadText('cairn-backup.json', JSON.stringify(await exportAll(), null, 2))
              setMsg('Backup downloaded.')
            })
          }
        >
          Download backup
        </button>
      </div>

      <div className="card">
        <h2>Restore</h2>
        <p className="small muted">
          Merges (upserts) a backup into the current store. Rows with matching ids are overwritten;
          rows only present here are kept. It does not clear anything first, so restoring the wrong
          file leaves you with both sets mixed together.
        </p>
        <label htmlFor="restore" className="small muted">
          Paste a backup:
        </label>
        <textarea
          id="restore"
          className="mono"
          rows={4}
          value={restore}
          onChange={(e) => setRestore(e.target.value)}
          placeholder='{"schema":"cairn.backup/v1", ...}'
        />
        <ConfirmAction
          label="Restore from paste"
          confirmLabel="Overwrite matching rows"
          phrase="restore"
          className=""
          disabled={busy || !restore.trim()}
          warning={
            <>
              This writes across every table on this device. Download a backup first if you have not
              already.
            </>
          }
          onConfirm={() =>
            withBusy(async () => {
              try {
                const r = await importAll(restore)
                setRestore('')
                setMsg(`Restored ${r.rows} row(s) across ${r.tables} table(s).`)
              } catch (err) {
                setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
              }
            })
          }
        />
      </div>

      <div className="card">
        <h2>Sample and demo data</h2>
        <p className="small muted">
          The sample workshop seeds reference content only (workshop, schedule, questions, roster).
          The demo scenario additionally writes a full worked evening of captures, observations,
          verdicts, and a mentoring conversation, so the dashboards and reports have something real
          to show. Both are for setup and rehearsal, not for a live workshop.
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-3)' }}>
          <ConfirmAction
            label="Load sample workshop"
            confirmLabel="Overwrite the seeded reference rows"
            className=""
            disabled={busy}
            warning={
              <>
                Writes the seed workshop, schedule, questions and roster back over their current
                versions. Edits you made to a <em>seeded</em> participant or team (a renamed person,
                an added email) revert. Participants you added yourself are untouched, and no
                evidence is affected.
              </>
            }
            onConfirm={() =>
              withBusy(async () => {
                await primeFromSeed()
                setMsg('Sample workshop loaded.')
              })
            }
          />
          <ConfirmAction
            label="Load demo scenario"
            confirmLabel="Reset the demo evening"
            className=""
            disabled={busy}
            warning={
              <>
                Deletes and rewrites only the rows this loader created (everything prefixed{' '}
                <code>demo::</code>). Real captures on this device are left alone. If no roster is
                loaded yet it will seed the sample workshop first, with the effect described to the
                left.
              </>
            }
            onConfirm={() =>
              withBusy(async () => {
                const r = await loadDemoScenario()
                setMsg(
                  `Demo loaded: ${r.evaluations} captures · ${r.observations} observations · ${r.verdicts} verdicts · ${r.conversations} conversation(s). Re-run at any time to reset.`,
                )
              })
            }
          />
        </div>
      </div>

      {msg && <div className="banner">{msg}</div>}
    </>
  )
}
