import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { db } from '../../db/local'
import { hostedAiEnabled, saveAiConfig } from '../../db/aiConfig'
import { isSupabaseConfigured } from '../../lib/supabase'
import { c } from '../../lib/content/chrome'
import { ScenarioDraftPanel } from '../../components/ScenarioDraftPanel'
import {
  AI_FUNCTION_BUILT,
  AI_FUNCTIONS,
  AI_MODES,
  modeUnavailableReason,
  resolveAiConfig,
  type AiConfig,
  type AiFunction,
  type AiMode,
} from '../../lib/aiConfig'
import { aiEnabled } from '../../ai/aiEnabled'
import { countsForAiConfig } from '../counts'
import { useSetupSave } from '../useSetupSave'
import type { AiCallLogEntry } from '../../lib/types'

/**
 * Setup → AI: which provider does this workshop's model work, and for what (tl-13).
 *
 * Three things on this screen and one thing deliberately not on it.
 *
 * THE MODE is a choice between three honest descriptions rather than a dropdown of
 * brand names, because the difference that matters to somebody making this decision
 * is where their evidence goes and who has to be present for the work to happen. Each
 * option states its own limitation; an unavailable option states WHY it is
 * unavailable rather than being hidden, so an administrator learns that somebody owns
 * that decision instead of concluding the app cannot do it.
 *
 * THE TOGGLES gate calls, not buttons. The switch here writes `ai_config`, the
 * provider entry point refuses on it, and `ai_call_permitted()` in Postgres refuses
 * on it again for anything that reaches a server — because a switch enforced only in
 * a browser is a preference, not a permission.
 *
 * THE TRACE is on this screen and not on a separate page, because the person who
 * turned something on is the person who needs to see whether it is working.
 *
 * NOT HERE: cost estimates. tl-14 owns the model registry and the estimator, and a
 * plausible-looking number invented in the meantime would be exactly the fabricated
 * figure the program's success criteria forbid.
 */
export function AiSection({ workshopId }: { workshopId: string }) {
  const rows = useLiveQuery(() => db.aiConfigs.toArray(), [], [])
  const config = resolveAiConfig(workshopId, rows ?? [])

  return (
    <>
      <div className="card form-col">
        <h2>{c('setup.ai.title')}</h2>
        <p className="small muted">{c('setup.ai.help')}</p>
        <ModePicker workshopId={workshopId} config={config} />
      </div>

      <FunctionToggles workshopId={workshopId} config={config} />

      {/* The draft-fill offer, which is one of the functions above rather than a
          separate feature. It reads the same config and says so when it is off. */}
      <ScenarioDraftPanel workshopId={workshopId} />

      <TraceCard workshopId={workshopId} />
    </>
  )
}

function ModePicker({ workshopId, config }: { workshopId: string; config: AiConfig }) {
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()
  const deployment = {
    supabaseConfigured: isSupabaseConfigured,
    hostedAiEnabled: hostedAiEnabled(),
  }

  const choose = async (mode: AiMode) => {
    if (mode === config.mode) return
    const counts = await countsForAiConfig(workshopId)
    await request({
      change: {
        entity: 'ai_config',
        operation: 'update',
        entityId: null,
        label: c('setup.ai.mode-label'),
        fields: [{ field: 'mode', before: config.mode, after: mode }],
        counts,
      },
      commit: async () => {
        await saveAiConfig(workshopId, { mode }, identity?.email ?? null)
      },
    })
  }

  return (
    <div className="form-col">
      <h3>{c('setup.ai.mode-title')}</h3>
      {AI_MODES.map((mode) => {
        const unavailable = modeUnavailableReason(mode, deployment)
        const selected = config.mode === mode
        return (
          <div className="banner" key={mode} data-selected={selected ? 'yes' : 'no'}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{c(`setup.ai.mode.${mode}`)}</strong>
              {selected ? (
                <span className="pill ok">{c('setup.ai.mode-current')}</span>
              ) : (
                <button
                  className="ghost small"
                  disabled={busy || unavailable !== null}
                  onClick={() => void choose(mode)}
                >
                  {c('setup.ai.mode-select')}
                </button>
              )}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {c(`setup.ai.mode.${mode}-detail`)}
            </p>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {c(`setup.ai.mode.${mode}-limit`)}
            </p>
            {unavailable && (
              <p className="small" style={{ marginBottom: 0 }}>
                <span className="pill local">{c('setup.ai.mode-unavailable')}</span> {c(unavailable)}
              </p>
            )}
          </div>
        )
      })}
      <p className="small muted">
        {c('setup.ai.routing-help')} <Link to="/admin/routing">{c('setup.ai.routing-link')}</Link>.
      </p>
      <p className="small muted">{c('setup.ai.estimates-pending')}</p>
    </div>
  )
}

function FunctionToggles({ workshopId, config }: { workshopId: string; config: AiConfig }) {
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()

  const toggle = async (fn: AiFunction, next: boolean) => {
    const counts = await countsForAiConfig(workshopId)
    // `before` is the value actually resolved from the store, not `!next`. They agree
    // almost always, and the exception is the case that matters: a second click while
    // the first save is in flight would describe a change that is not happening, and
    // this dialog's whole value is that what it says is true.
    const before = aiEnabled(fn, config)
    if (before === next) return
    await request({
      change: {
        entity: 'ai_config',
        operation: 'update',
        entityId: null,
        label: c(`setup.ai.fn.${fn}`),
        fields: [{ field: fn, before, after: next }],
        counts,
      },
      commit: async () => {
        await saveAiConfig(
          workshopId,
          {
            functions: {
              ...config.functions,
              [fn]: { ...config.functions[fn], enabled: next },
            },
          },
          identity?.email ?? null,
        )
      },
    })
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.ai.functions-title')}</h2>
      <p className="small muted">{c('setup.ai.functions-help')}</p>
      {/*
        A STACKED LIST, NOT A TABLE, and the reason is a screenshot. The first draft
        was a three-column `.dt` inside a `.dt-wrap`, which passes tl-20's audit —
        it scrolls inside itself and carries the there-is-more-that-way gradient —
        and on a 390px phone showed the function names with the state pill and the
        switch pushed off the right edge. That is the tl-09 scale-editor lesson in a
        milder key: "no body overflow" is not the same as "usable", and a table whose
        two narrow columns ARE the controls has nothing to gain from being a table.
        Stacked rows put the switch next to the thing it switches at both widths.
      */}
      <ul className="plain-list">
        {AI_FUNCTIONS.map((fn) => {
          const built = AI_FUNCTION_BUILT[fn]
          const on = aiEnabled(fn, config)
          return (
            <li key={fn} className="ai-fn">
              <div className="ai-fn__text">
                <div className="row" style={{ gap: 'var(--s-1)', alignItems: 'baseline' }}>
                  <strong>{c(`setup.ai.fn.${fn}`)}</strong>
                  {!built ? (
                    <span className="pill local">{c('setup.ai.fn.not-built')}</span>
                  ) : on ? (
                    <span className="pill ok">{c('setup.ai.fn.on')}</span>
                  ) : (
                    <span className="pill queued">{c('setup.ai.fn.off')}</span>
                  )}
                </div>
                <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                  {c(`setup.ai.fn.${fn}-help`)}
                </p>
              </div>
              {/* A function with no call path gets no switch. A toggle that governs
                  nothing is worse than an absent one: it reports a state the app
                  cannot honour. */}
              {built && (
                <button className="ghost small" disabled={busy} onClick={() => void toggle(fn, !on)}>
                  {on ? c('setup.ai.fn.turn-off') : c('setup.ai.fn.turn-on')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="small muted">{c('setup.ai.functions-footnote')}</p>
    </div>
  )
}

/**
 * The trace, as this device holds it.
 *
 * Local rather than a query against the backend, for the same reason the setup log
 * card is: an administrator offline still needs to see what their own device did, and
 * a card that could only render online would be blank exactly when somebody is
 * debugging a connection. Rows that have not reached the backend say so.
 */
function TraceCard({ workshopId }: { workshopId: string }) {
  const entries = useLiveQuery(
    async () => {
      const rows = await db.aiCallLog.where('workshop_id').equals(workshopId).toArray()
      return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
    },
    [workshopId],
    [] as AiCallLogEntry[],
  )
  return (
    <div className="card">
      <h2>{c('setup.ai.trace-title')}</h2>
      <p className="small muted">{c('setup.ai.trace-help')}</p>
      {(entries ?? []).length === 0 ? (
        <p className="small muted">{c('setup.ai.trace-empty')}</p>
      ) : (
        (entries ?? []).map((e) => (
          <p className="small" key={e.id}>
            <span className={`pill ${e.outcome === 'error' ? 'error' : e.outcome === 'result' ? 'ok' : 'local'}`}>
              {c(`setup.ai.outcome.${e.outcome.replace('_', '-')}`)}
            </span>{' '}
            <strong>{c(`setup.ai.fn.${e.fn}`)}</strong> · {e.mode}
            {e.model ? ` · ${e.model}` : ''}
            {e.latency_ms != null ? ` · ${e.latency_ms}ms` : ''} ·{' '}
            {e.at.slice(0, 16).replace('T', ' ')}
            {e.sync_status !== 'synced' && (
              <>
                {' '}
                <span className="pill queued">{c('setup.ai.trace-local')}</span>
              </>
            )}
            {e.detail ? <span className="muted"> · {e.detail.slice(0, 120)}</span> : null}
          </p>
        ))
      )}
    </div>
  )
}
