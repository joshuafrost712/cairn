import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { useScopedWorkshopId } from '../layout/roles'
import { isSupabaseConfigured } from '../lib/supabase'
import { pullPendingCaptures } from '../db/sync'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import { RepoVerdictSync } from '../components/RepoVerdictSync'
import {
  getRoutingRepo,
  getRoutingToken,
  setRoutingToken,
  clearRoutingToken,
  canPushPull,
} from '../routing/config'
import {
  listPendingCaptures,
  pullObservationsFromRepo,
  importObservationsText,
} from '../routing/operations'
import { runAiJob, type AiOutcome } from '../ai/providers'
import { drainRelayResults } from '../relay/collect'
import { aiEnabled, aiUnavailableReason } from '../ai/aiEnabled'
import { resolveAiConfig } from '../lib/aiConfig'

// Routing screen: send submitted captures to the routing repo, route them with
// Claude (Max — no metered API), and bring the per-individual observations back.
// Works token-free via copy/paste, or automated when a GitHub token is set.
//
// ADMINISTRATOR-ONLY since tl-03, at /admin/routing behind RequireRole. It is the
// one screen in the app that names a repository or holds a credential, and the
// evaluator's need for it went away when tl-04 gave observations and verdicts a
// real transport. Nothing here may be linked from an evaluator-facing surface.
export function Routing() {
  const { identity } = useAuth()
  const email = identity?.email ?? null
  const repo = getRoutingRepo()
  const automated = canPushPull()
  const workshopId = useScopedWorkshopId()

  // tl-13: the mode is the workshop's `ai_config`, not a device localStorage key.
  // `getRoutingMode()` was tl-03's provisional stand-in and said so in its own
  // comment; nothing had ever persisted a non-default value through it, so there is
  // nothing to migrate and the accessor is gone rather than left as a second answer
  // to the same question.
  const configRows = useLiveQuery(() => db.aiConfigs.toArray(), [], [])
  const config = resolveAiConfig(workshopId ?? '', configRows ?? [])
  const routingOn = aiEnabled('observation_routing', config)
  const routingOffReason = aiUnavailableReason('observation_routing', config)

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
  const [queueMsg, setQueueMsg] = useState<string | null>(null)

  // Pull the workshop's captures as soon as this screen opens, so the queue is
  // the workshop's rather than this device's. Deliberately not in startSyncLoop:
  // an evaluator's phone has no routing surface and no reason to hold other
  // people's captures, and doing it there would fill their own list with them.
  useEffect(() => {
    if (!workshopId) return
    let cancelled = false
    void (async () => {
      const r = await pullPendingCaptures(workshopId)
      if (cancelled) return
      setQueueMsg(
        c('routing.queue.result', 'label', {
          pulled: r.pulled,
          adopted: r.adopted,
          markedRouted: r.markedRouted,
        }),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [workshopId])

  /**
   * Hand this workshop's pending captures to whoever routes them.
   *
   * One call site for both transports, because the decision (is routing on? which
   * mode? trace it) is identical and only the `intent` differs. Two copies of this
   * would be two places to forget the toggle.
   */
  const handOff = (intent: 'copy' | 'push' | 'run'): Promise<AiOutcome> =>
    runAiJob(
      { fn: 'observation_routing', workshopId: workshopId as string, actorEmail: email, intent },
      { config },
    )

  /** A non-hand-off outcome as a sentence. Never a raw error object. */
  const describeOutcome = (outcome: AiOutcome): string =>
    outcome.kind === 'refused' ? c(outcome.reason ?? 'setup.ai.fn.disabled') : (outcome.reason ?? '')

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
    <>
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

      {/* The mode is stated here and CHOSEN in Setup → AI (tl-13). Two places to
          change one thing is how the two disagree, so this card reports and links. */}
      <div className="card">
        <Copy id="routing.mode.title" as="h2" />
        <Copy id={`routing.mode.${config.mode}`} as="p" className="small muted" />
        <p className="small muted">
          {c('routing.mode.configured-in')} <Link to="/admin/setup/ai">{c('routing.mode.setup-link')}</Link>.
        </p>
        {routingOffReason && (
          <p className="small">
            <span className="pill queued">{c('setup.ai.fn.off')}</span> {c(routingOffReason)}{' '}
            {c('routing.mode.off-consequence')}
          </p>
        )}
      </div>

      <div className="card">
        <Copy id="routing.queue.title" as="h2" />
        <Copy id="routing.queue.intro" as="p" className="small muted" />
        {!isSupabaseConfigured && <Copy id="routing.queue.offline" as="p" className="banner warn" />}
        <button
          className="ghost small"
          disabled={busy || !workshopId || !isSupabaseConfigured}
          onClick={() =>
            run(async () => {
              if (!workshopId) return ''
              const r = await pullPendingCaptures(workshopId)
              return c('routing.queue.result', 'label', {
                pulled: r.pulled,
                adopted: r.adopted,
                markedRouted: r.markedRouted,
              })
            })
          }
        >
          {c('routing.queue.refresh')}
        </button>
        {queueMsg && <p className="small muted">{queueMsg}</p>}
      </div>

      {!repo && (
        <div className="banner warn">
          No routing repo set. Define <code>VITE_ROUTING_REPO</code> (e.g. <code>you/cairn-routing</code>)
          to enable the automated path. The copy/paste path below works without it.
        </div>
      )}

      {/* tl-21: the workshop's own machine. Only in the mode that has one — the other
          three refuse an unattended run with a reason, and a button that always refused
          would be a worse way to learn that. */}
      {config.mode === 'local-agent' && workshopId && (
        <LocalAgentCard workshopId={workshopId} routingOn={routingOn} handOff={handOff} />
      )}

      {/* tl-23: routing on the server, on the deployment's own key. Same rule as the
          card above: the button exists only in the mode that can honour it. */}
      {config.mode === 'hosted-api' && workshopId && (
        <HostedApiCard routingOn={routingOn} handOff={handOff} />
      )}

      <div className="card">
        <h2>Manual (no setup needed)</h2>
        <p className="small muted">
          Copy the pending captures, paste them to Claude with the repo's <code>ROUTING.md</code>,
          then paste Claude's JSON reply back here.
        </p>
        <button
          className="primary"
          disabled={busy || !routingOn || !workshopId}
          onClick={() =>
            run(async () => {
              if (!workshopId) return ''
              // Through the provider (tl-13), not straight to buildExportBundle: the
              // toggle has to gate the CALL rather than the button, and this hand-off
              // is the call. It is also the point at which the trace records that
              // captures left for a human to route.
              const outcome = await handOff('copy')
              if (outcome.kind === 'operator_action') {
                setBundle(outcome.prompt ?? '')
                const count = (outcome.value as { count?: number } | undefined)?.count ?? 0
                if (count > 0 && outcome.prompt && navigator.clipboard) {
                  try {
                    await navigator.clipboard.writeText(outcome.prompt)
                    return `Copied ${count} capture${count === 1 ? '' : 's'} to the clipboard.`
                  } catch {
                    /* clipboard blocked; the textarea below still has it */
                  }
                }
                return count > 0
                  ? `Prepared ${count} capture${count === 1 ? '' : 's'} below.`
                  : 'Nothing pending.'
              }
              return describeOutcome(outcome)
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
              return `Imported ${r.stored} observation${r.stored === 1 ? '' : 's'} from ${r.files} capture${r.files === 1 ? '' : 's'}${r.rejected ? ` (${r.rejected} rejected)` : ''}. Shared ${r.shared} with the other devices.`
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
            disabled={busy || !automated || !routingOn || !workshopId}
            onClick={() => run(async () => {
              if (!workshopId) return ''
              const outcome = await handOff('push')
              if (outcome.kind === 'operator_action') {
                const pushed = (outcome.value as { pushed?: number } | undefined)?.pushed ?? 0
                return `Pushed ${pushed} capture${pushed === 1 ? '' : 's'} to inbox/.`
              }
              return describeOutcome(outcome)
            })}
          >
            Push pending → repo
          </button>
          <span className="spacer" />
          <button
            disabled={busy || !automated}
            onClick={() => run(async () => {
              const r = await pullObservationsFromRepo()
              return `Pulled ${r.files} file${r.files === 1 ? '' : 's'}, ${r.observations} observation${r.observations === 1 ? '' : 's'}${r.rejected ? ` (${r.rejected} rejected)` : ''}. Shared ${r.shared} with the other devices.`
            })}
          >
            Pull observations ← repo
          </button>
        </div>
      </div>

      {email && <RepoVerdictSync evaluatorEmail={email} />}

      {msg && <div className="banner">{msg}</div>}

    </>
  )
}

/**
 * Route this workshop's captures on the machine in the room (tl-21).
 *
 * One button and no terminal: what it replaces is an administrator opening a Claude
 * session, working through `ROUTING.md` by hand, and pasting the answer back — per batch,
 * during a workshop day, by the one person who is also supposed to be watching
 * participants.
 *
 * THE DRAIN ON MOUNT IS NOT A REFRESH BUTTON'S JOB. If the tab reloaded while a batch was
 * running, the relay finished it and is holding the result; without this the administrator
 * sees nothing and routes the same captures again, spending a second batch of the
 * subscription's tokens on work that is already done.
 */
/**
 * Route this workshop's captures on the server, on the deployment's own key (tl-23).
 *
 * One button. The provider fans the pending captures out to the Edge Function one
 * capture per call and imports the answers through the ordinary boundary, so what
 * this card reports is the same partial-honesty rule the spec asks for: "routed 18
 * of 20" rather than a success that hid two failures or a failure that hid
 * eighteen successes. Failed captures stay pending, so the retry is this button.
 */
function HostedApiCard({
  routingOn,
  handOff,
}: {
  routingOn: boolean
  handOff: (intent: 'copy' | 'push' | 'run') => Promise<AiOutcome>
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const describe = (outcome: AiOutcome): string => {
    if (outcome.kind === 'result') {
      const v = outcome.value as {
        captures?: number
        routed?: number
        failed?: number
        stored?: number
        rejected?: number
        shared?: number
      }
      return c('routing.hosted.result', 'label', {
        captures: v.captures ?? 0,
        routed: v.routed ?? 0,
        failed: v.failed ?? 0,
        stored: v.stored ?? 0,
        rejected: v.rejected ?? 0,
        shared: v.shared ?? 0,
      })
    }
    if (outcome.kind === 'operator_action') return c(outcome.instructionsId ?? 'setup.ai.op.fallback-prompt')
    if (outcome.kind === 'refused') return c(outcome.reason ?? 'setup.ai.fn.disabled')
    return outcome.reason ?? c('setup.ai.fn.disabled')
  }

  return (
    <div className="card form-col">
      <Copy id="routing.hosted.title" as="h2" />
      <Copy id="routing.hosted.intro" as="p" className="small muted" />
      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
        <button
          className="primary"
          disabled={busy || !routingOn}
          onClick={() =>
            void (async () => {
              setBusy(true)
              setStatus(c('routing.hosted.working'))
              try {
                setStatus(describe(await handOff('run')))
              } catch (err) {
                setStatus(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            })()
          }
        >
          {c('routing.hosted.run')}
        </button>
      </div>
      {status && <p className="small">{status}</p>}
    </div>
  )
}

function LocalAgentCard({
  workshopId,
  routingOn,
  handOff,
}: {
  workshopId: string
  routingOn: boolean
  handOff: (intent: 'copy' | 'push' | 'run') => Promise<AiOutcome>
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [jobFile, setJobFile] = useState('')

  // Collect anything the machine finished while this screen was closed.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const drained = await drainRelayResults(workshopId)
      if (cancelled) return
      if (drained.stored || drained.failed || drained.discarded) {
        setStatus(
          c('routing.local.drained', 'label', {
            stored: drained.stored,
            files: drained.files,
            failed: drained.failed,
            discarded: drained.discarded,
          }),
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workshopId])

  const describe = (outcome: AiOutcome): string => {
    if (outcome.kind === 'result') {
      const v = outcome.value as { stored?: number; files?: number; rejected?: number; captures?: number }
      return c('routing.local.result', 'label', {
        stored: v.stored ?? 0,
        captures: v.captures ?? 0,
        rejected: v.rejected ?? 0,
        tokens_in: outcome.tokensIn ?? 0,
        tokens_out: outcome.tokensOut ?? 0,
      })
    }
    if (outcome.kind === 'operator_action') return c(outcome.instructionsId ?? 'setup.ai.op.fallback-prompt')
    if (outcome.kind === 'refused') return c(outcome.reason ?? 'setup.ai.fn.disabled')
    return outcome.reason ?? c('setup.ai.fn.disabled')
  }

  const act = async (intent: 'copy' | 'run') => {
    setBusy(true)
    setStatus(c(intent === 'run' ? 'routing.local.working' : 'routing.local.preparing'))
    try {
      const outcome = await handOff(intent)
      if (intent === 'copy' && outcome.kind === 'operator_action' && outcome.prompt) {
        setJobFile(outcome.prompt)
      }
      setStatus(describe(outcome))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form-col">
      <Copy id="routing.local.title" as="h2" />
      <Copy id="routing.local.intro" as="p" className="small muted" />
      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
        <button className="primary" disabled={busy || !routingOn} onClick={() => void act('run')}>
          {c('routing.local.run')}
        </button>
        <button className="ghost small" disabled={busy || !routingOn} onClick={() => void act('copy')}>
          {c('routing.local.prepare-file')}
        </button>
        <button
          className="ghost small"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true)
              const drained = await drainRelayResults(workshopId)
              setBusy(false)
              setStatus(
                c('routing.local.drained', 'label', {
                  stored: drained.stored,
                  files: drained.files,
                  failed: drained.failed,
                  discarded: drained.discarded,
                }),
              )
            })()
          }
        >
          {c('routing.local.collect')}
        </button>
      </div>
      {status && <p className="small">{status}</p>}
      {jobFile && (
        <>
          <Copy id="routing.local.file-help" as="p" className="small muted" />
          <textarea
            className="mono"
            readOnly
            value={jobFile}
            rows={6}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
    </div>
  )
}
