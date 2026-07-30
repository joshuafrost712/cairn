import { useState } from 'react'
import { canPushPull, getRoutingRepo } from '../routing/config'
import { syncAll, buildMyVerdictBundle, importVerdictsText } from '../routing/verdicts'

// Verdict sync over the routing repo — the NO-BACKEND FALLBACK.
//
// This was the evaluator's verdict-sharing mechanism until tl-04 gave the app a
// real transport. It stays because a deployment with no Supabase configured is
// still supported, and it is now reachable only from /admin/routing: an
// evaluator's phone should never hold a token with write access to a private
// repo, which is what the previous arrangement required of every one of them.
//
// Do not wire this to an evaluator-facing surface.
export function RepoVerdictSync({ evaluatorEmail }: { evaluatorEmail: string }) {
  const repo = getRoutingRepo()
  const automated = canPushPull()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [bundle, setBundle] = useState('')
  const [paste, setPaste] = useState('')
  const [open, setOpen] = useState(false)

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
    <div className="card">
      <div className="row">
        <strong>Verdict sync over the repo (fallback)</strong>
        <span className="spacer" />
        <button className="ghost small" onClick={() => setOpen((o) => !o)}>{open ? 'hide' : 'manual'}</button>
      </div>
      <p className="small muted">
        For a deployment with no backend configured. Where Supabase is configured, verdicts and
        observations already sync on their own and nothing here is needed. You are{' '}
        <strong>{evaluatorEmail}</strong>.
      </p>

      {automated ? (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await syncAll(evaluatorEmail)
              return `Synced: pushed ${r.pushed} of my verdict(s), merged ${r.merged} from ${r.evaluators} other evaluator(s)${r.observations ? `, ${r.observations} observation(s) pulled` : ''}.`
            })
          }
        >
          Sync through the repo
        </button>
      ) : (
        <p className="small muted">
          No GitHub token set{repo ? '' : ' (and no routing repo configured)'}. Use the manual copy/paste below,
          or set a token above for one-tap sync.
        </p>
      )}

      {(open || !automated) && (
        <div style={{ marginTop: '0.5rem' }}>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const { json, count } = await buildMyVerdictBundle(evaluatorEmail)
                setBundle(json)
                if (navigator.clipboard) {
                  try {
                    await navigator.clipboard.writeText(json)
                    return `Copied ${count} of my verdict(s) to the clipboard. Send to the other evaluators.`
                  } catch {
                    /* fall through to textarea */
                  }
                }
                return `Prepared ${count} of my verdict(s) below.`
              })
            }
          >
            Copy my verdicts
          </button>
          {bundle && <textarea className="mono" readOnly value={bundle} rows={4} onFocus={(e) => e.currentTarget.select()} />}
          <label className="small muted" htmlFor="vpaste">Paste another evaluator's verdicts (JSON):</label>
          <textarea
            id="vpaste"
            className="mono"
            value={paste}
            rows={4}
            placeholder='{"schema":"cairn.verdicts/v1","evaluator_email":"...","verdicts":[ ... ]}'
            onChange={(e) => setPaste(e.target.value)}
          />
          <button
            disabled={busy || !paste.trim()}
            onClick={() =>
              run(async () => {
                const r = await importVerdictsText(paste, evaluatorEmail)
                setPaste('')
                return `Merged ${r.merged} verdict(s) from ${r.evaluators} evaluator(s).`
              })
            }
          >
            Merge their verdicts
          </button>
        </div>
      )}

      {msg && <div className="banner">{msg}</div>}
    </div>
  )
}
