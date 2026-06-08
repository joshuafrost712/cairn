import { useState } from 'react'
import { canPushPull, getRoutingRepo } from '../routing/config'
import { syncAll, buildMyVerdictBundle, importVerdictsText } from '../routing/verdicts'

// Cross-device verdict sync. The multi-evaluator gate only reaches its threshold
// when each evaluator's verdicts (recorded on their own device) are shared. With a
// GitHub token, "Sync now" pulls the latest observations, pushes this device's
// verdicts, and pulls everyone else's. Without one, copy/paste does the same by hand.
export function VerdictSync({ evaluatorEmail }: { evaluatorEmail: string }) {
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
        <strong>Sync verdicts across evaluators</strong>
        <span className="spacer" />
        <button className="ghost small" onClick={() => setOpen((o) => !o)}>{open ? 'hide' : 'manual'}</button>
      </div>
      <p className="small muted">
        Each evaluator confirms on their own device; sync shares verdicts so the gate can reach its
        threshold. You are <strong>{evaluatorEmail}</strong>.
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
          Sync now
        </button>
      ) : (
        <p className="small muted">
          No GitHub token set{repo ? '' : ' (and no routing repo configured)'}. Use the manual copy/paste below,
          or set a token on the Routing screen for one-tap sync.
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
