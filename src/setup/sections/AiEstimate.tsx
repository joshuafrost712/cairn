import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { c } from '../../lib/content/chrome'
import { aiEnabled } from '../../ai/aiEnabled'
import {
  DEFAULT_ASSUMPTIONS,
  EXCLUSIONS,
  assumptionsValue,
  estimateWorkshopTokens,
  resolveAssumptions,
  totalTokens,
  type EstimateAssumptions,
  type EstimateComponent,
  type TokenPair,
} from '../../ai/estimate'
import {
  MODEL_REGISTRY,
  RECOMMENDATIONS,
  REGISTRY_REVIEWED,
  estimateCostUsd,
  modeIsMetered,
  modelById,
  modelsForMode,
  registryIsStale,
} from '../../ai/models'
import { actualSpendForWorkshop, deriveWorkshopShape } from '../../ai/workshopShape'
import { setAiAssumptions, setAiFunctionModel } from '../../db/aiConfig'
import { countsForAiConfig } from '../counts'
import { useSetupSave } from '../useSetupSave'
import { AI_FUNCTIONS, AI_FUNCTION_BUILT, type AiConfig, type AiFunction } from '../../lib/aiConfig'

/**
 * Setup → AI: which model, and what running this workshop through it would cost (tl-14).
 *
 * The sentence tl-13 left here said estimates were a later spec and that showing a
 * made-up number would be worse than showing none. This is that spec, and the same
 * standard governs it: every figure below is either measured from the workshop or
 * labelled as an assumption an administrator can change, the range states what it
 * excludes, and the registry says when its prices were last checked.
 *
 * WHY THE COST IS PER FUNCTION RATHER THAN ONE NUMBER TIMES ONE MODEL. Functions can
 * name different models, and that is the point of the registry: routing on a cheap
 * high-volume tier, prose on a stronger one. Costing the whole workshop at whichever
 * model happened to be selected last would misprice exactly the configuration the
 * feature exists to encourage. So each component is costed at its own function's model
 * and the total is a sum. A function with no model named contributes tokens and no
 * money, and the total says so rather than quietly omitting it.
 *
 * STACKED ROWS, NOT TABLES, and it is the third time this program has had to learn it.
 * A price-and-posture table would be six columns of the densest content in the app;
 * tl-09's scale editor rendered a 730px layout viewport on a phone and tl-13's toggles
 * passed the audit outright with every switch off-screen. `.ai-fn`'s flex-wrap is the
 * shape that survived, so it is reused rather than re-invented.
 */

const fmtTokens = (n: number): string => n.toLocaleString('en-US')

/**
 * Money, at the precision the estimate actually has.
 *
 * Cents below ten dollars and whole dollars above it. A workshop estimate reading
 * "$412.68" would claim a precision that a 4-characters-per-token approximation and a
 * guessed capture length cannot support, which is Planning-Quality-Protocol's
 * significant-digits rule applied to the app's own output rather than to a plan.
 */
const fmtUsd = (n: number): string =>
  n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`

/**
 * A published per-million rate.
 *
 * Two decimals unless the rate is a whole number of dollars, so $0.10 does not render
 * as "$0.1". Raw number formatting dropped the trailing zero and the 390px screenshot
 * showed "$0.1 / $0.4" sitting under a price caption, which reads as a typo rather
 * than as a tenth of a dollar. This is a published figure being quoted, so unlike the
 * estimate it should be exact rather than rounded to the precision it deserves.
 */
const fmtRate = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

export function AiEstimate({ workshopId, config }: { workshopId: string; config: AiConfig }) {
  const shape = useLiveQuery(() => deriveWorkshopShape(workshopId), [workshopId])
  const actual = useLiveQuery(() => actualSpendForWorkshop(workshopId), [workshopId])
  const assumptions = resolveAssumptions(config.assumptions)

  const enabled = AI_FUNCTIONS.filter((fn) => AI_FUNCTION_BUILT[fn] && aiEnabled(fn, config))
  const metered = modeIsMetered(config.mode)
  const stale = registryIsStale(new Date())

  // `undefined` is Dexie still loading; a real shape with nothing in it is a different
  // state and gets a different sentence. Conflating them would show "not enough
  // workshop" for a moment on every render, which reads as a broken workshop.
  const loading = shape === undefined
  const tooEmpty = !loading && shape.activities === 0 && shape.participants === 0

  const estimate =
    loading || tooEmpty ? null : estimateWorkshopTokens(shape, enabled, assumptions)

  /** The USD cost of one component, at its own function's model. Null when no model is named. */
  const costOf = (comp: EstimateComponent): number | null => {
    if (!metered) return null
    return estimateCostUsd(comp, modelById(config.functions[comp.fn].model))
  }

  const costed = estimate?.components.map(costOf) ?? []
  const totalCost = costed.reduce<number | null>(
    (sum, v) => (v == null ? sum : (sum ?? 0) + v),
    null,
  )
  const someUncosted = metered && costed.some((v) => v == null) && estimate !== null

  return (
    <>
      <ModelPicker workshopId={workshopId} config={config} />

      <div className="card form-col">
        <h2>{c('setup.ai.est.title')}</h2>
        <p className="small muted">{c('setup.ai.est.help')}</p>
        <p className="small muted">
          {metered ? c('setup.ai.est.metered-framing') : c('setup.ai.est.subscription-framing')}
        </p>

        {stale && (
          <p className="banner small">
            <span className="pill error">{c('setup.ai.est.stale')}</span>
          </p>
        )}

        {loading ? null : tooEmpty ? (
          <p className="small muted">{c('setup.ai.est.empty')}</p>
        ) : enabled.length === 0 ? (
          <p className="small muted">{c('setup.ai.est.all-off')}</p>
        ) : (
          <>
            <div className="est-band">
              <Figure labelId="setup.ai.est.low" tokens={estimate!.low} usd={null} />
              <Figure
                labelId="setup.ai.est.expected"
                tokens={estimate!.expected}
                usd={metered ? totalCost : null}
                emphasis
              />
              <Figure labelId="setup.ai.est.high" tokens={estimate!.high} usd={null} />
            </div>
            <p className="small muted">{c('setup.ai.est.band-help')}</p>
            {someUncosted && <p className="small muted">{c('setup.ai.est.no-model')}</p>}

            <p className="small">
              <strong>{c('setup.ai.est.recurring')}:</strong> {fmtTokens(totalTokens(estimate!.recurring))}{' '}
              {c('setup.ai.est.tokens')}
              {estimate!.oneOff.inputTokens + estimate!.oneOff.outputTokens > 0 && (
                <>
                  {' · '}
                  <strong>{c('setup.ai.est.one-off')}:</strong>{' '}
                  {fmtTokens(totalTokens(estimate!.oneOff))} {c('setup.ai.est.tokens')}
                </>
              )}
            </p>
            <p className="small muted">{c('setup.ai.est.one-off-help')}</p>

            {/* Per function, with its basis. This is the half that makes the estimate
                arguable rather than magic, so it is not behind a disclosure. */}
            <ul className="plain-list">
              {estimate!.components.map((comp, i) => (
                <li key={comp.fn} className="ai-fn">
                  <div className="ai-fn__text">
                    <div className="row" style={{ gap: 'var(--s-1)', alignItems: 'baseline' }}>
                      <strong>{c(`setup.ai.fn.${comp.fn}`)}</strong>
                      {comp.oneOff && (
                        <span className="pill local">{c('setup.ai.est.one-off')}</span>
                      )}
                    </div>
                    {/* Both halves render through the content layer. The first draft
                        printed the derived side as raw field names, so one column was
                        prose and the other was camelCase: the spec's central
                        presentation criterion, half-implemented. */}
                    <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                      <strong>{c('setup.ai.est.derived')}:</strong>{' '}
                      {comp.basis.derived.map((k) => c(`setup.ai.derived.${k}`)).join('; ') ||
                        c('setup.ai.est.basis-none')}
                    </p>
                    <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                      <strong>{c('setup.ai.est.assumed')}:</strong>{' '}
                      {comp.basis.assumed.map((k) => c(`setup.ai.assume.${k}`)).join('; ') ||
                        c('setup.ai.est.basis-none')}
                    </p>
                  </div>
                  <p className="small ai-fn__meta" style={{ margin: 0 }}>
                    {fmtTokens(comp.inputTokens)} {c('setup.ai.est.in')}
                    {' · '}
                    {fmtTokens(comp.outputTokens)} {c('setup.ai.est.out')}
                    {costed[i] != null && (
                      <>
                        <br />
                        <strong>{fmtUsd(costed[i]!)}</strong>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            <p className="small muted">{c('setup.ai.est.basis-help')}</p>
            <p className="small muted">
              {estimate!.usedObservedCaptureLength
                ? c('setup.ai.est.measured-capture')
                : c('setup.ai.est.assumed-capture')}
            </p>

            <h3>{c('setup.ai.est.exclusions-title')}</h3>
            <ul className="small muted">
              {EXCLUSIONS.map((id) => (
                <li key={id}>{c(id)}</li>
              ))}
            </ul>
          </>
        )}

        <p className="small muted">
          {c('setup.ai.est.reviewed')} {REGISTRY_REVIEWED}.
        </p>
      </div>

      {/* Calibration. Beside the estimate rather than on another page, because a
          number nobody puts next to the outcome never gets corrected. */}
      <div className="card form-col">
        <h2>{c('setup.ai.est.actuals-title')}</h2>
        <p className="small muted">{c('setup.ai.est.actuals-help')}</p>
        {/* Same distinction the shape read makes above: `undefined` is Dexie still
            loading, `null` is a real "nothing has been measured". Conflating them
            flashes the empty state on first render, which reads as an answer. */}
        {actual === undefined ? null : actual ? (
          <p className="small">
            <strong>
              {fmtTokens(actual.inputTokens)} {c('setup.ai.est.in')} ·{' '}
              {fmtTokens(actual.outputTokens)} {c('setup.ai.est.out')}
            </strong>{' '}
            <span className="muted">
              {c('setup.ai.est.actuals-calls')} {actual.calls}{' '}
              {c('setup.ai.est.actuals-calls-suffix')}
            </span>
          </p>
        ) : (
          <p className="small muted">{c('setup.ai.est.actuals-none')}</p>
        )}
      </div>

      <AssumptionsEditor workshopId={workshopId} config={config} assumptions={assumptions} />
    </>
  )
}

function Figure({
  labelId,
  tokens,
  usd,
  emphasis,
}: {
  labelId: string
  tokens: TokenPair
  usd: number | null
  emphasis?: boolean
}) {
  return (
    <div className="est-figure" data-emphasis={emphasis ? 'yes' : 'no'}>
      <div className="small muted">{c(labelId)}</div>
      <div className="est-figure__value">
        {fmtTokens(totalTokens(tokens))} <span className="small muted">{c('setup.ai.est.tokens')}</span>
      </div>
      {usd != null && <div className="est-figure__usd">{fmtUsd(usd)}</div>}
    </div>
  )
}

/**
 * Which model each function uses, plus the registry it is chosen from.
 *
 * A model change routes through tl-07's dialog exactly as the mode and the toggles do:
 * it is the same `ai_config` entity and it genuinely changes where a workshop's
 * evidence goes next. The assumptions below deliberately do not, and that contrast is
 * the argument for both.
 */
function ModelPicker({ workshopId, config }: { workshopId: string; config: AiConfig }) {
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()
  const available = modelsForMode(config.mode)
  const recommendedFor = (id: string) => RECOMMENDATIONS.some((r) => r.model_id === id)

  const choose = async (fn: AiFunction, model: string | null) => {
    const before = config.functions[fn].model
    if (before === model) return
    const counts = await countsForAiConfig(workshopId)
    await request({
      change: {
        entity: 'ai_config',
        operation: 'update',
        entityId: null,
        label: c(`setup.ai.fn.${fn}`),
        fields: [{ field: 'model', before, after: model }],
        counts,
      },
      commit: async () => {
        await setAiFunctionModel(workshopId, fn, model, identity?.email ?? null)
      },
    })
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.ai.model.title')}</h2>
      <p className="small muted">{c('setup.ai.model.help')}</p>

      <ul className="plain-list">
        {AI_FUNCTIONS.filter((fn) => AI_FUNCTION_BUILT[fn]).map((fn) => {
          const chosen = config.functions[fn].model
          const chosenEntry = modelById(chosen)
          // A model stored for a mode that cannot reach it is a real state: an admin
          // picks a Claude model, then switches to hosted AI. Saying so beats silently
          // resetting a choice they made on purpose.
          const unreachable = chosenEntry !== null && !available.includes(chosenEntry)
          return (
            <li key={fn} className="ai-fn">
              <div className="ai-fn__text">
                <strong>{c(`setup.ai.fn.${fn}`)}</strong>
                {unreachable && (
                  <p className="small" style={{ margin: '0.15rem 0 0' }}>
                    <span className="pill local">{c('setup.ai.model.unreachable')}</span>
                  </p>
                )}
              </div>
              <label className="small" style={{ margin: 0 }}>
                {/* Labelled by attribute rather than visible text: the function's own
                    name is the heading beside it, and a second visible label would
                    repeat it. Attribute copy cannot be reached by edit-in-place, which
                    is a stated limit of the content layer, so it lives here anyway for
                    single-source authoring. */}
                <select
                  aria-label={c('setup.ai.model.title')}
                  value={chosen ?? ''}
                  disabled={busy}
                  onChange={(e) => void choose(fn, e.target.value || null)}
                >
                  <option value="">{c('setup.ai.model.none')}</option>
                  {available.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                  {/* Keep an unreachable stored choice selectable, so opening the
                      control does not silently rewrite it to the default. */}
                  {unreachable && chosenEntry && (
                    <option value={chosenEntry.id}>{chosenEntry.display_name}</option>
                  )}
                </select>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="small muted">{c('setup.ai.model.none-help')}</p>

      {/* Its own heading, not the link text reused. The first draft used
          `model.posture-source` here and the 390px screenshot showed why that was
          wrong: the section heading and every link beneath it read identically, so the
          heading named an action instead of naming the section. Found by opening the
          harness's own screenshot, which is the half of the audit a person has to do. */}
      <h3>{c('setup.ai.model.registry-title')}</h3>
      <ul className="plain-list">
        {MODEL_REGISTRY.map((m) => (
          <li key={m.id} className="ai-fn">
            <div className="ai-fn__text">
              <div className="row" style={{ gap: 'var(--s-1)', alignItems: 'baseline' }}>
                <strong>{m.display_name}</strong>
                {recommendedFor(m.id) && (
                  <span className="pill ok">{c('setup.ai.model.recommended')}</span>
                )}
                {!available.includes(m) && (
                  <span className="pill queued">{c('setup.ai.model.unreachable')}</span>
                )}
              </div>
              <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                {c(`setup.ai.posture.${m.data_posture.replace(/_/g, '-')}`)}.{' '}
                <a href={m.posture_source} target="_blank" rel="noreferrer noopener">
                  {c('setup.ai.model.posture-source')}
                </a>
              </p>
              {/* The provider's own words. Without them the screen shows this app's
                  three-word summary and a link, and nothing an administrator can judge
                  the summary by without leaving the page. */}
              <p className="small muted" style={{ margin: '0.15rem 0 0' }}>{m.posture_note}</p>
              {/* Per entry and gated, because it is false for a provider with no tier
                  split, and it carries its OWN citation: Google states the paid-tier
                  position on the logs policy and the free-tier position on the pricing
                  page, so one link cannot substantiate both. */}
              {m.free_tier_differs && m.free_tier_note && (
                <p className="small" style={{ margin: '0.3rem 0 0' }}>
                  <span className="pill local">{c('setup.ai.model.free-tier-label')}</span>{' '}
                  {m.free_tier_note}
                  {m.free_tier_source && (
                    <>
                      {' '}
                      <a href={m.free_tier_source} target="_blank" rel="noreferrer noopener">
                        {c('setup.ai.model.free-tier-source')}
                      </a>
                    </>
                  )}
                </p>
              )}
              {RECOMMENDATIONS.filter((r) => r.model_id === m.id).map((r) => (
                <p className="small muted" key={r.job} style={{ margin: '0.15rem 0 0' }}>
                  {c(r.whyId)}
                </p>
              ))}
            </div>
            <p className="small ai-fn__meta" style={{ margin: 0 }}>
              <strong>
                {fmtRate(m.input_per_mtok)} / {fmtRate(m.output_per_mtok)}
              </strong>
              <br />
              <span className="muted">{c('setup.ai.model.price')}</span>
              <br />
              <span className="muted">
                {fmtTokens(m.context_window)} {c('setup.ai.model.context')}
              </span>
              {m.price_note_id && (
                <>
                  <br />
                  <span className="muted">{c(m.price_note_id)}</span>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The assumptions, editable.
 *
 * DELIBERATELY NOT THROUGH `useSetupSave`, and the reason is the same one tl-12 gave
 * for the profile editor read in the opposite direction. tl-07's dialog exists to warn
 * that a save will affect evidence somebody has already recorded; an assumption
 * changes a number on this screen and nothing else, so a dialog here would be a
 * warning about a consequence that does not exist, and a setup-log entry would put
 * "captureChars 1200 to 2400" in the record of database edits an administrator scans
 * for real changes. Selecting a model DOES route through the dialog, three components
 * up, because that one really does decide where the next request goes.
 *
 * Local state until Save, rather than a write per keystroke: each character of "2400"
 * would otherwise be a queued reference write, and "24" is a stored assumption that
 * was never intended.
 */
function AssumptionsEditor({
  workshopId,
  config,
  assumptions,
}: {
  workshopId: string
  config: AiConfig
  assumptions: EstimateAssumptions
}) {
  const { identity } = useAuth()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const keys = Object.keys(DEFAULT_ASSUMPTIONS) as (keyof EstimateAssumptions)[]
  const shown = (key: keyof EstimateAssumptions): string =>
    draft[key] ?? String(assumptions[key])
  const dirty = Object.keys(draft).length > 0

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const next: EstimateAssumptions = { ...assumptions }
      for (const key of keys) {
        const raw = draft[key]
        if (raw === undefined) continue
        const parsed = Number(raw)
        // A field left blank or typed badly keeps the value it had rather than
        // becoming zero. Zero is a legal assumption (nobody expects discrepancy
        // notes), so it must be reachable by typing 0 and not by typing nothing.
        if (raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) continue
        next[key] = parsed
      }
      await setAiAssumptions(workshopId, assumptionsValue(next), identity?.email ?? null)
      setDraft({})
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await setAiAssumptions(workshopId, {}, identity?.email ?? null)
      setDraft({})
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.ai.assume.title')}</h2>
      <p className="small muted">{c('setup.ai.assume.help')}</p>
      <ul className="plain-list">
        {keys.map((key) => (
          <li key={key} className="ai-fn">
            <div className="ai-fn__text">
              <label htmlFor={`assume-${key}`}>{c(`setup.ai.assume.${key}`)}</label>
            </div>
            <input
              id={`assume-${key}`}
              type="number"
              min="0"
              step="any"
              className="est-assume__input"
              value={shown(key)}
              disabled={saving}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            />
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 'var(--s-1)', flexWrap: 'wrap' }}>
        <button disabled={saving || !dirty} onClick={() => void save()}>
          {c('setup.ai.assume.save')}
        </button>
        <button
          className="ghost"
          disabled={saving || Object.keys(config.assumptions).length === 0}
          onClick={() => void reset()}
        >
          {c('setup.ai.assume.reset')}
        </button>
        {saved && !dirty && <span className="pill ok">{c('setup.ai.assume.saved')}</span>}
      </div>
    </div>
  )
}
