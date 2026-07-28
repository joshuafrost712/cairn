import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { generateEventDigests, generateParticipantEmails } from '../db/drafts'
import { describeSync, syncDrafts } from '../db/draftSync'
import { useScopedWorkshopId } from '../layout/roles'
import { isSupabaseConfigured } from '../lib/supabase'
import { PageHeader } from '../layout/PageHeader'
import { DataTable } from '../components/data/DataTable'
import type { Column } from '../components/data/DataTable'
import { EmptyState } from '../components/data/EmptyState'
import type { DraftDoc } from '../drafts/types'

/**
 * The queue: everything waiting to be reviewed, approved, and sent.
 *
 * Generation is explicit rather than automatic. An email that regenerated on its
 * own while you were reading it would move the text under your cursor, and the
 * merge machinery exists precisely because regeneration is a thing you choose to
 * do after the data changes.
 */
export function Outgoing() {
  const { identity } = useAuth()
  const navigate = useNavigate()
  const workshopId = useScopedWorkshopId()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10))
  const [facilitators, setFacilitators] = useState('')

  const drafts = useLiveQuery(() => db.docDrafts.toArray(), [], [] as DraftDoc[])
  const activeDrafts = (drafts ?? []).filter((d) => d.status !== 'superseded')

  const run = async (fn: () => Promise<DraftDoc[]>, label: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const made = await fn()
      setMsg(`${made.length} ${label} ready.`)
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<DraftDoc>[] = [
    {
      key: 'title',
      header: 'document',
      sticky: true,
      sortValue: (d) => d.title,
      render: (d) => (
        <>
          <strong>{d.title}</strong>
          <div className="small muted">{d.subject}</div>
        </>
      ),
    },
    {
      key: 'kind',
      header: 'kind',
      sortValue: (d) => d.kind,
      render: (d) => (d.kind === 'participant_email' ? 'participant email' : 'event digest'),
    },
    {
      key: 'to',
      header: 'to',
      render: (d) =>
        d.recipients.length === 0 ? (
          <span className="muted">nobody</span>
        ) : d.recipients.some((r) => !r.email.trim()) ? (
          <span className="pill error" title="Add it on the roster">
            no address
          </span>
        ) : d.fanout === 'single' ? (
          <span title={d.recipients.map((r) => r.email).join(', ')}>
            {d.recipients.length} facilitators, one email
          </span>
        ) : (
          d.recipients[0].email
        ),
    },
    {
      key: 'state',
      header: 'state',
      sortValue: (d) => d.status,
      render: (d) => (
        <>
          <span className="queue-status">{d.status}</span>
          {d.revision > 1 && <span className="small muted"> · rev {d.revision}</span>}
        </>
      ),
    },
    {
      key: 'attention',
      header: 'needs a look',
      numeric: true,
      sortValue: (d) => d.flags.length + d.orphans.length,
      render: (d) => {
        const n = d.flags.length + d.orphans.length
        return n === 0 ? <span className="muted">—</span> : <span className="pill queued">{n}</span>
      },
    },
    {
      key: 'edits',
      header: 'your edits',
      numeric: true,
      sortValue: (d) => d.overrides.length,
      render: (d) => (d.overrides.length === 0 ? <span className="muted">—</span> : d.overrides.length),
    },
  ]

  return (
    <>
      <PageHeader
        title="Outgoing"
        crumbs={[{ label: 'Workbench' }, { label: 'Outgoing' }]}
        meta={`${activeDrafts.length} document(s)`}
      />

      <div className="card form-col">
        <h2>Generate</h2>
        <p className="small muted">
          Builds tonight's documents from the evidence as it stands right now. Running it again
          later refreshes them: your edits are kept, and anything whose evidence moved underneath
          is flagged rather than quietly rewritten.
        </p>
        <label htmlFor="day">Day</label>
        <input id="day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />

        <label htmlFor="facils" className="small muted">
          Facilitator emails for the event digest, comma separated. The digest goes to the whole
          team as one email.
        </label>
        <input
          id="facils"
          value={facilitators}
          placeholder="ruth@sil.org, david@sil.org"
          onChange={(e) => setFacilitators(e.target.value)}
        />

        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  generateParticipantEmails({
                    now: new Date().toISOString(),
                    dateLabel: day,
                    fromName: identity?.email ?? undefined,
                  }),
                'participant email(s)',
              )
            }
          >
            Participant emails
          </button>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  generateEventDigests({
                    now: new Date().toISOString(),
                    dateLabel: day,
                    fromName: identity?.email ?? undefined,
                    facilitators: facilitators
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map((email) => ({ email })),
                  }),
                'event digest(s)',
              )
            }
          >
            Event digests
          </button>
        </div>
        {msg && <p className="small muted">{msg}</p>}
      </div>

      <div className="card form-col">
        <h2>Share with the other devices</h2>
        <p className="small muted">
          {isSupabaseConfigured
            ? 'Sends this device’s documents up and brings back what anyone else approved or sent, so “has that gone out yet” has one answer rather than one per laptop. A document that has already been sent is never pulled back to an earlier state, whichever device was offline longer.'
            : 'Local-only mode: documents stay on this device. Configure Supabase to share send state across devices.'}
        </p>
        <div className="row">
          <button
            className="ghost"
            disabled={busy || !isSupabaseConfigured || !workshopId}
            onClick={async () => {
              setBusy(true)
              setSyncMsg(null)
              try {
                setSyncMsg(describeSync(await syncDrafts(workshopId)))
              } finally {
                setBusy(false)
              }
            }}
          >
            Sync documents
          </button>
          {syncMsg && <span className="small muted">{syncMsg}</span>}
        </div>
      </div>

      <div className="card">
        <h2>Queue</h2>
        <DataTable
          rows={activeDrafts}
          columns={columns}
          rowKey={(d) => d.id}
          defaultSort="attention"
          defaultDir="desc"
          onRowClick={(d) => navigate(`/outgoing/${encodeURIComponent(d.id)}`)}
          empty={
            <EmptyState title="Nothing queued">
              Generate tonight's documents above, or check that observations have been routed on{' '}
              <Link to="/routing">Routing</Link>.
            </EmptyState>
          }
        />
      </div>
    </>
  )
}
