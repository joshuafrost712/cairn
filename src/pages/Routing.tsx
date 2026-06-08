import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import {
  getRoutingRepo,
  getRoutingToken,
  setRoutingToken,
  clearRoutingToken,
  canPushPull,
} from '../routing/config'
import {
  listPendingCaptures,
  pushPendingCaptures,
  pullObservations,
  buildExportBundle,
  importObservationsText,
} from '../routing/operations'

// Routing screen: send submitted captures to the routing repo, route them with
// Claude (Max — no metered API), and bring the per-individual observations back.
// Works token-free via copy/paste, or automated when a GitHub token is set.
export function Routing() {
  const repo = getRoutingRepo()
  const automated = canPushPull()

  const pending = useLiveQuery(async () => (await listPendingCaptures()).length, [], 0)
  const observationCount = useLiveQuery(() => db.observations.count(), [], 0)
  const needsReview = useLiveQuery(
    async () => (await db.observations.toArray()).filter((o) => o.needs_review).length,
    [],
    0,
  )

  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [bundle, setBundle] = useState('')
  const [paste, setPaste] = useState('')

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setMsg(null)
    try {
      setMsg(await fn())
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Routing</h1>
        <p className="small muted">
          Captures are routed into per-individual observations by Claude on a GitHub repo
          (your Claude Max subscription, on phone or desktop). No metered API, no per-use cost.
        </p>
        <p className="small">
          <strong>{pending}</strong> capture{pending === 1 ? '' : 's'} pending routing ·{' '}
          <strong>{observationCount}</strong> observation{observationCount === 1 ? '' : 's'} imported
          {needsReview ? ` (${needsReview} need review)` : ''}.
        </p>
      </div>

      {!repo && (
        <div className="banner warn">
          No routing repo set. Define <code>VITE_ROUTING_REPO</code> (e.g. <code>you/cairn-routing</code>)
          to enable the automated path. The copy/paste path below works without it.
        </div>
      )}

      <div className="card">
        <h2>Manual (no setup needed)</h2>
        <p className="small muted">
          Copy the pending captures, paste them to Claude with the repo's <code>ROUTING.md</code>,
          then paste Claude's JSON reply back here.
        </p>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { json, count } = await buildExportBundle()
              setBundle(json)
              if (count > 0 && navigator.clipboard) {
                try {
                  await navigator.clipboard.writeText(json)
                  return `Copied ${count} capture${count === 1 ? '' : 's'} to the clipboard.`
                } catch {
                  /* clipboard blocked; the textarea below still has it */
                }
              }
              return count > 0 ? `Prepared ${count} capture${count === 1 ? '' : 's'} below.` : 'Nothing pending.'
            })
          }
        >
          Copy pending captures
        </button>
        {bundle && (
          <textarea className="mono" readOnly value={bundle} rows={6} onFocus={(e) => e.currentTarget.select()} />
        )}
        <label className="small muted" htmlFor="paste">Paste Claude's routed observations (JSON):</label>
        <textarea
          id="paste"
          className="mono"
          value={paste}
          rows={6}
          placeholder='{"schema":"cairn.observations-bundle/v1","results":[ ... ]}'
          onChange={(e) => setPaste(e.target.value)}
        />
        <button
          disabled={busy || !paste.trim()}
          onClick={() =>
            run(async () => {
              const r = await importObservationsText(paste)
              setPaste('')
              return `Imported ${r.stored} observation${r.stored === 1 ? '' : 's'} from ${r.files} capture${r.files === 1 ? '' : 's'}${r.rejected ? ` (${r.rejected} rejected)` : ''}.`
            })
          }
        >
          Import observations
        </button>
      </div>

      <div className="card">
        <h2>Automated (GitHub token)</h2>
        <p className="small muted">
          Optional. A fine-grained token scoped to {repo ? <code>{repo}</code> : 'the routing repo'} (Contents:
          read &amp; write), stored on this device only. Then push/pull happen in one tap.
        </p>
        {getRoutingToken() ? (
          <p className="small">
            Token set. <button className="ghost small" disabled={busy} onClick={() => { clearRoutingToken(); setMsg('Token cleared.') }}>Clear token</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              placeholder="github_pat_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ flex: 1 }}
            />
            <button disabled={!token.trim()} onClick={() => { setRoutingToken(token); setToken(''); setMsg('Token saved on this device.') }}>
              Save
            </button>
          </div>
        )}
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button
            disabled={busy || !automated}
            onClick={() => run(async () => {
              const r = await pushPendingCaptures()
              return `Pushed ${r.pushed} capture${r.pushed === 1 ? '' : 's'} to inbox/.`
            })}
          >
            Push pending → repo
          </button>
          <span className="spacer" />
          <button
            disabled={busy || !automated}
            onClick={() => run(async () => {
              const r = await pullObservations()
              return `Pulled ${r.files} file${r.files === 1 ? '' : 's'}, ${r.observations} observation${r.observations === 1 ? '' : 's'}${r.rejected ? ` (${r.rejected} rejected)` : ''}.`
            })}
          >
            Pull observations ← repo
          </button>
        </div>
      </div>

      {msg && <div className="banner">{msg}</div>}

      <div className="card row">
        <Link to="/observations">View observations</Link>
        <span className="spacer" />
        <Link className="small muted" to="/">Home</Link>
      </div>
    </main>
  )
}
