import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../../layout/PageHeader'
import { StatTile } from '../../components/data/StatTile'
import { DataTable } from '../../components/data/DataTable'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { useScopedWorkshopId } from '../../layout/roles'
import {
  fetchWorkshopHealth,
  mayFallBackToCache,
  readCachedHealth,
  type HealthResult,
} from '../../db/health'
import {
  briefingActions,
  rankCoverageGaps,
  renderHealthMarkdown,
  type BriefingAction,
  type CoverageGap,
  type WorkshopHealth,
} from '../../reports/health'

/**
 * "What does this workshop need today" (tl-38), read from the server.
 *
 * It is called Briefing and not Workshop health because `/admin/workshop` already
 * renders a page under that exact title, and two of them would make every future
 * bug report ambiguous.
 *
 * The page links and never acts. Running the routing backlog, chasing a silent
 * device and assigning somebody to watch a participant are all acts with a screen
 * of their own; a health panel that also performed them would become a second,
 * worse copy of the Routing page.
 *
 * FOUR STATES, AND NONE OF THEM IS A SILENT ZERO. Fresh, stale-from-cache,
 * refused, and never-fetched-and-offline. The refusal is the one that matters:
 * the RPC raises rather than returning an empty report, precisely so this page can
 * say "you may not read this" instead of drawing a healthy-looking workshop full
 * of zeroes.
 */
export function Briefing() {
  const workshopId = useScopedWorkshopId()
  const [result, setResult] = useState<HealthResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  // One clock for the whole render. Silence, ages and the markdown must all agree
  // about what "now" is, and three separate Date.now() calls in one paint do not.
  const [now, setNow] = useState(() => Date.now())

  // One request at a time, and only the latest one may write state. Refresh and
  // the mount effect are two callers of the same fetch, and without this a click
  // on workshop A that settles after a switch to B would paint A's numbers under
  // B's header, links and cache.
  const requestId = useRef(0)

  const load = useCallback(async (id: string) => {
    const ticket = (requestId.current += 1)
    setBusy(true)
    // A new read makes any previous copy stale, so the button stops claiming the
    // clipboard holds what is now on screen.
    setCopied('idle')
    try {
      const next = await fetchWorkshopHealth(id)
      if (requestId.current !== ticket) return
      setResult(next)
      setNow(Date.now())
    } finally {
      if (requestId.current === ticket) setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!workshopId) return
    let cancelled = false
    void (async () => {
      // Inside the async body rather than the effect body: a synchronous setState
      // in an effect is a cascading render, and the lint rule that says so is
      // right. Same idiom as SyncHealth.
      //
      // Clearing first is what stops the page showing workshop B's header, links
      // and cache key over workshop A's numbers while the new read is in flight.
      if (cancelled) return
      setResult(null)
      await load(workshopId)
    })()
    return () => {
      cancelled = true
    }
  }, [workshopId, load])

  if (!workshopId) {
    return (
      <>
        <PageHeader title={c('briefing.title')} />
        <div className="banner warn" role="alert">
          <Copy id="briefing.no-workshop" />
        </div>
      </>
    )
  }

  // A REFUSAL NEVER FALLS BACK TO THE CACHE. Every other failure may: offline with
  // a saved copy is a real and useful state. But `refused` means the server has
  // just said this caller may not read this workshop, and answering that with the
  // last report the device happens to hold is worse than answering it with zeroes,
  // because the numbers are real and nothing on screen dates them. The device's
  // own membership cache is what makes this reachable rather than theoretical: a
  // demoted chief still passes `RequireRole` locally while the RPC, which is the
  // live truth, raises.
  const cached = result && mayFallBackToCache(result) ? readCachedHealth(workshopId) : null
  const health: WorkshopHealth | null = result?.ok ? result.data : (cached?.data ?? null)
  const stale = Boolean(!result?.ok && cached)

  const onCopy = () => {
    if (!health) return
    void (async () => {
      try {
        await navigator.clipboard.writeText(renderHealthMarkdown(health, now))
        setCopied('done')
        // Reverts so a second copy gives feedback too. Never report success for a
        // state that has moved on.
        window.setTimeout(() => setCopied('idle'), 2500)
      } catch {
        setCopied('failed')
      }
    })()
  }

  return (
    <>
      <PageHeader
        title={c('briefing.title')}
        crumbs={[
          { label: c('nav.group.dashboard'), to: '/admin/overview' },
          { label: c('briefing.title') },
        ]}
        actions={
          <>
            <button className="ghost small" disabled={!health} onClick={onCopy}>
              {copied === 'done' ? c('briefing.copied') : c('briefing.copy')}
            </button>{' '}
            <button className="ghost small" disabled={busy} onClick={() => void load(workshopId)}>
              {busy ? c('briefing.refresh.busy') : c('briefing.refresh')}
            </button>
          </>
        }
      />

      <p className="muted small">
        <Copy id="briefing.intro" />
      </p>

      <StateBanner result={result} stale={stale} cachedAt={cached?.fetchedAt} now={now} />
      {copied === 'failed' && (
        <p className="muted small">
          <Copy id="briefing.copy-failed" />
        </p>
      )}

      {health && (
        <>
          <Worklist actions={briefingActions(health, now)} staleHours={health.stale_hours} />

          <h2 style={{ marginTop: 'var(--s-5)' }}>
            <Copy id="briefing.volume.title" />
          </h2>
          <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-5)' }}>
            <StatTile
              label={c('briefing.stat.captures')}
              value={health.volume.captures}
              sub={c('briefing.stat.captures.sub', 'label', { evaluators: health.volume.evaluators })}
            />
            <StatTile
              label={c('briefing.stat.queue')}
              value={health.pipeline.queue.count}
              sub={c('briefing.stat.queue.sub')}
              to="/admin/routing"
              attention={health.pipeline.queue.count > 0}
            />
            <StatTile
              label={c('briefing.stat.observations')}
              value={health.volume.observations}
              sub={c('briefing.stat.observations.sub', 'label', {
                people: health.volume.people_with_routed,
                mean: formatMean(health.volume.mean_evidence),
              })}
            />
            <StatTile
              label={c('briefing.stat.verdicts')}
              value={health.volume.verdicts}
              sub={c('briefing.stat.verdicts.sub')}
              to="/observations"
              attention={health.volume.verdicts < health.volume.observations}
            />
          </div>

          <CoverageTable gaps={rankCoverageGaps(health.coverage.participants)} />
          <GoalList health={health} />
          <UnresolvedNames health={health} />

          <p className="muted small" style={{ marginTop: 'var(--s-5)' }}>
            <Copy id="briefing.footer" />{' '}
            <Link to="/admin/sync-health">{c('briefing.footer.sync-health')}</Link>
            {', '}
            <Link to="/admin/workshop">{c('briefing.footer.workshop')}</Link>
            {', '}
            <Link to="/admin/routing">{c('briefing.footer.routing')}</Link>.
          </p>
        </>
      )}
    </>
  )
}

function formatMean(value: number | string | null): string {
  if (value === null || value === undefined || value === '') return 'n/a'
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : String(value)
}

function ageLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * The state line. A refusal renders as a sentence about permission, never as a
 * report full of zeroes, which is the failure this whole spec is shaped against.
 */
function StateBanner({
  result,
  stale,
  cachedAt,
  now,
}: {
  result: HealthResult | null
  stale: boolean
  cachedAt?: string
  now: number
}) {
  if (!result) return null

  if (result.ok) {
    return (
      <p className="muted small">
        {c('briefing.fetched', 'label', { when: ageLabel(result.fetchedAt, now) })}
      </p>
    )
  }

  if (result.reason === 'refused') {
    return (
      <div className="banner warn" role="alert">
        <Copy id="briefing.refused" />
      </div>
    )
  }

  if (stale && cachedAt) {
    return (
      <div className="banner warn" role="status">
        {c('briefing.stale', 'label', { when: ageLabel(cachedAt, now) })}
      </div>
    )
  }

  if (result.reason === 'offline') {
    return (
      <div className="banner warn" role="alert">
        <Copy id="briefing.offline-no-cache" />
      </div>
    )
  }

  return (
    <div className="banner warn" role="alert">
      {c('briefing.error', 'label', { message: result.message })}
    </div>
  )
}

function Worklist({ actions, staleHours }: { actions: BriefingAction[]; staleHours: number }) {
  return (
    <div className="card briefing-worklist" style={{ marginTop: 'var(--s-5)' }}>
      <h2>
        <Copy id="briefing.worklist.title" />
      </h2>
      <p className="muted small">
        <Copy id="briefing.worklist.intro" />
      </p>
      {actions.length === 0 ? (
        <p className="muted small">
          <Copy id="briefing.worklist.empty" />
        </p>
      ) : (
        <ul>
          {actions.map((action) => (
            <li key={action.kind} style={{ marginBottom: 'var(--s-2)' }}>
              {action.to ? (
                <Link to={action.to}>
                  {c(`briefing.action.${action.kind}`, 'label', {
                    count: action.count,
                    hours: staleHours,
                  })}
                </Link>
              ) : (
                c(`briefing.action.${action.kind}`, 'label', {
                  count: action.count,
                  hours: staleHours,
                })
              )}
              {action.detail.length > 0 && (
                <div className="muted small">{action.detail.slice(0, 8).join(', ')}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CoverageTable({ gaps }: { gaps: CoverageGap[] }) {
  return (
    <div className="card briefing-coverage" style={{ marginTop: 'var(--s-5)' }}>
      <h2>
        <Copy id="briefing.coverage.title" />
      </h2>
      <p className="muted small">
        <Copy id="briefing.coverage.intro" />
      </p>
      <DataTable
        rows={gaps}
        rowKey={(g) => g.row.participant_id}
        defaultSort="total"
        defaultDir="asc"
        empty={
          <p className="muted small">
            <Copy id="briefing.coverage.empty" />
          </p>
        }
        columns={[
          {
            key: 'participant',
            header: c('briefing.col.participant'),
            sortValue: (g) => g.row.name,
            // The team travels with the name here and is hidden by CSS on a wide
            // screen, where its own column shows it. Rendering it in both places
            // and choosing in CSS is what keeps one DOM for both widths.
            render: (g) => (
              <>
                <Link to={`/admin/participants/${g.row.participant_id}`}>{g.row.name}</Link>
                <span className="briefing-narrow-only muted small">
                  {g.row.team ? `${g.row.team} · ` : ''}
                  {c('briefing.counts-inline', 'label', {
                    routed: g.row.routed,
                    pending: g.row.pending,
                  })}
                </span>
              </>
            ),
          },
          {
            key: 'team',
            header: c('briefing.col.team'),
            sortValue: (g) => g.row.team ?? '',
            render: (g) => g.row.team ?? '',
          },
          {
            key: 'routed',
            header: c('briefing.col.routed'),
            numeric: true,
            sortValue: (g) => g.row.routed,
            render: (g) => g.row.routed,
          },
          {
            key: 'pending',
            header: c('briefing.col.pending'),
            numeric: true,
            sortValue: (g) => g.row.pending,
            render: (g) => g.row.pending,
          },
          {
            key: 'total',
            header: c('briefing.col.total'),
            numeric: true,
            sortValue: (g) => g.total,
            render: (g) => (g.unseen ? <span className="pill error">{g.total}</span> : g.total),
          },
        ]}
      />
    </div>
  )
}

function GoalList({ health }: { health: WorkshopHealth }) {
  if (health.by_goal.length === 0) return null
  return (
    <div className="card" style={{ marginTop: 'var(--s-5)' }}>
      <h2>
        <Copy id="briefing.goals.title" />
      </h2>
      <p className="muted small">
        <Copy id="briefing.goals.intro" />
      </p>
      <ul>
        {health.by_goal.map((goal) => (
          <li key={goal.goal}>
            <strong>{goal.n}</strong> {goal.goal}{' '}
            <span className="muted small">({formatMean(goal.mean_evidence)})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UnresolvedNames({ health }: { health: WorkshopHealth }) {
  const names = health.coverage.unresolved_scope_names
  const unattributed = health.coverage.unattributed_observations
  if (names.length === 0 && unattributed === 0) return null
  return (
    <div className="card" style={{ marginTop: 'var(--s-5)' }}>
      <h2>
        <Copy id="briefing.unresolved.title" />
      </h2>
      <p className="muted small">
        <Copy id="briefing.unresolved.intro" />
      </p>
      {/* Each half renders only if it has something to say. The first version drew
          an empty paragraph whenever there were unattributed observations but no
          unresolved names, and never showed the count that had opened the card. */}
      {names.length > 0 && <p>{names.join(', ')}</p>}
      {unattributed > 0 && (
        <p className="muted small">
          {c('briefing.unattributed', 'label', { count: unattributed })}
        </p>
      )}
    </div>
  )
}
