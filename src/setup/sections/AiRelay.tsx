import { useState } from 'react'
import { c } from '../../lib/content/chrome'
import { SUBSCRIPTION_POSTURE_REVIEWED, SUBSCRIPTION_POSTURE_SOURCE } from '../../ai/models'
import { diagnoseRelay, type RelayDiagnosis } from '../../relay/client'
import {
  DEFAULT_RELAY_URL,
  clearRelayToken,
  getRelayToken,
  getRelayUrl,
  getStoredRelayUrl,
  setRelayToken,
  setRelayUrl,
} from '../../relay/config'
import type { AiConfig } from '../../lib/aiConfig'

/**
 * Setup → AI → the machine that does the work (tl-21).
 *
 * FOUR FAILURES, TOLD APART. The Test button must never say "cannot connect", because
 * these have four different fixes and an administrator cannot guess which one they have:
 * the service is not running (or the browser refused the request), the service is running
 * and the token is wrong, the service is running and there is no worker on the machine,
 * and everything is fine but the subscription's limit has been reached. Each state names
 * its own fix, and the not-reachable copy names Safari and a possible browser prompt
 * explicitly, because Chrome's local-network behaviour is mid-rollout and a version that
 * starts asking would otherwise present as an unexplained failure at a workshop.
 *
 * NO SETUP DIALOG AND NO CHANGE LOG, deliberately, and the same reasoning tl-12's profile
 * editor used: `useSetupSave` classifies and records edits to the WORKSHOP's
 * configuration, and an address and a token are properties of this laptop. Nothing here
 * reaches another device or another person's screen, so there is no consequence for a
 * dialog to describe.
 *
 * ALWAYS RENDERED, not only when the mode is selected, so a machine can be tested BEFORE
 * a workshop switches to it. The header says which mode it serves.
 */
export function AiRelay({ config }: { config: AiConfig }) {
  const [urlText, setUrlText] = useState(getStoredRelayUrl() ?? '')
  const [tokenText, setTokenText] = useState('')
  const [hasToken, setHasToken] = useState(Boolean(getRelayToken()))
  const [urlError, setUrlError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [diagnosis, setDiagnosis] = useState<RelayDiagnosis | null>(null)

  const active = config.mode === 'local-agent'

  const saveUrl = () => {
    const checked = setRelayUrl(urlText || DEFAULT_RELAY_URL)
    if (!checked.ok) {
      setUrlError(c(checked.reasonId ?? 'setup.ai.relay.url-unreadable'))
      return
    }
    setUrlError(null)
    setUrlText(checked.value ?? '')
    setSaved(c('setup.ai.relay.saved'))
    setDiagnosis(null)
  }

  const saveToken = () => {
    if (!tokenText.trim()) return
    setRelayToken(tokenText)
    setTokenText('')
    setHasToken(true)
    setSaved(c('setup.ai.relay.saved'))
    setDiagnosis(null)
  }

  const test = async () => {
    setBusy(true)
    setSaved(null)
    try {
      setDiagnosis(await diagnoseRelay())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.ai.relay.title')}</h2>
      <p className="small muted">{c('setup.ai.relay.help')}</p>
      {!active && (
        <p className="small">
          <span className="pill local">{c('setup.ai.relay.not-in-use')}</span>{' '}
          {c('setup.ai.relay.not-in-use-help')}
        </p>
      )}

      <label className="small muted" htmlFor="relay-url">
        {c('setup.ai.relay.url-label')}
      </label>
      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
        <input
          id="relay-url"
          value={urlText}
          placeholder={DEFAULT_RELAY_URL}
          onChange={(e) => setUrlText(e.target.value)}
          style={{ flex: '1 1 14rem', minWidth: 0 }}
        />
        <button className="ghost small" disabled={busy} onClick={saveUrl}>
          {c('setup.ai.relay.url-save')}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {c('setup.ai.relay.url-current', 'label', { url: getRelayUrl() })}
      </p>
      {urlError && <p className="small banner warn">{urlError}</p>}

      <label className="small muted" htmlFor="relay-token">
        {c('setup.ai.relay.token-label')}
      </label>
      {hasToken ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
          <span className="pill ok">{c('setup.ai.relay.token-set')}</span>
          <button
            className="danger-quiet small"
            disabled={busy}
            onClick={() => {
              clearRelayToken()
              setHasToken(false)
              setDiagnosis(null)
              setSaved(c('setup.ai.relay.token-cleared'))
            }}
          >
            {c('setup.ai.relay.token-clear')}
          </button>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
          <input
            id="relay-token"
            type="password"
            value={tokenText}
            placeholder={c('setup.ai.relay.token-placeholder')}
            onChange={(e) => setTokenText(e.target.value)}
            style={{ flex: '1 1 14rem', minWidth: 0 }}
          />
          <button className="ghost small" disabled={!tokenText.trim()} onClick={saveToken}>
            {c('setup.ai.relay.token-save')}
          </button>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 0 }}>
        {c('setup.ai.relay.token-help')}
      </p>

      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
        <button className="primary" disabled={busy} onClick={() => void test()}>
          {busy ? c('setup.ai.relay.testing') : c('setup.ai.relay.test')}
        </button>
      </div>
      {saved && <p className="small muted">{saved}</p>}
      {diagnosis && <Diagnosis diagnosis={diagnosis} />}

      {/* The posture, cited and dated, per tl-14's rule that the registry claims nothing
          of its own. This is the sentence that matters most in this mode, because the
          answer is set on somebody's Claude account rather than by the app. */}
      <p className="small muted">
        {c('setup.ai.relay.posture')}{' '}
        <a href={SUBSCRIPTION_POSTURE_SOURCE} target="_blank" rel="noreferrer">
          {c('setup.ai.relay.posture-source')}
        </a>{' '}
        {c('setup.ai.relay.posture-checked', 'label', { date: SUBSCRIPTION_POSTURE_REVIEWED })}
      </p>
    </div>
  )
}

function Diagnosis({ diagnosis }: { diagnosis: RelayDiagnosis }) {
  const state = diagnosis.state
  const ok = state === 'healthy'
  const warn = state === 'throttled'
  return (
    <div className="banner" data-relay-state={state}>
      <p className="small" style={{ marginBottom: '0.25rem' }}>
        <span className={`pill ${ok ? 'ok' : warn ? 'queued' : 'error'}`}>
          {c(`setup.ai.relay.state.${state}`)}
        </span>{' '}
        {c(`setup.ai.relay.fix.${state}`)}
      </p>
      {'failure' in diagnosis && diagnosis.failure.message && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {diagnosis.failure.message}
        </p>
      )}
      {'health' in diagnosis && <Health health={diagnosis.health} />}
    </div>
  )
}

function Health({ health }: { health: Extract<RelayDiagnosis, { state: 'healthy' }>['health'] }) {
  const { counts, last, uncollected } = health.queue
  return (
    <>
      <p className="small muted" style={{ marginBottom: '0.25rem' }}>
        {c('setup.ai.relay.queue', 'label', {
          queued: counts.queued,
          running: counts.leased,
          done: counts.done,
          failed: counts.failed,
          uncollected,
        })}
      </p>
      {health.throttled && (
        <p className="small" style={{ marginBottom: '0.25rem' }}>
          {health.throttled.until
            ? c('setup.ai.relay.throttled-until', 'label', {
                time: health.throttled.until.slice(0, 16).replace('T', ' '),
              })
            : c('setup.ai.relay.throttled-unknown')}
        </p>
      )}
      {last && (
        <p className="small muted" style={{ marginBottom: '0.25rem' }}>
          {c('setup.ai.relay.last', 'label', {
            fn: c(`setup.ai.fn.${last.fn}`),
            status: last.status,
            at: String(last.at).slice(0, 16).replace('T', ' '),
            tokens_in: last.tokens_in ?? 0,
            tokens_out: last.tokens_out ?? 0,
            ms: last.duration_ms ?? 0,
          })}
        </p>
      )}
      {last?.error && (
        <p className="small muted" style={{ marginBottom: '0.25rem' }}>
          {last.error}
        </p>
      )}
      {/* The folder exchange, named where somebody can find it: it is the transport that
          always works, and the one an administrator on a phone or in Safari needs. */}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {c('setup.ai.relay.drop', 'label', { path: health.drop.in })}
      </p>
    </>
  )
}
