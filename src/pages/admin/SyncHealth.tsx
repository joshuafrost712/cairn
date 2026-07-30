import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { PageHeader } from '../../layout/PageHeader'
import { StatTile } from '../../components/data/StatTile'
import { DataTable, type Column } from '../../components/data/DataTable'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import { db } from '../../db/local'
import { pullPendingCaptures, pullObservations, pullVerdicts } from '../../db/sync'
import { isSupabaseConfigured } from '../../lib/supabase'
import { useScopedWorkshopId } from '../../layout/roles'
import { getRequiredConfirmations } from '../../reports/verification'
import { buildSyncFunnel, exceptionRows, formatAge, type FunnelRow } from '../../reports/syncHealth'

/**
 * "Which submitted evaluations are not counting yet, and why" (tl-18).
 *
 * The honest limit is stated on the page rather than buried in this comment:
 * work that has never left a phone cannot be seen from a laptop, by definition.
 * This page covers every stage from the moment an evaluation reaches the shared
 * database onward, and the device's own status bar covers the step before that.
 * A page that implied otherwise would reproduce the failure it exists to end,
 * which is a number that reads like completeness and is not.
 */
export function SyncHealth() {
  const workshopId = useScopedWorkshopId()
  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (id: string): Promise<string> => {
    const captures = await pullPendingCaptures(id)
    const obs = await pullObservations(id)
    const verdicts = await pullVerdicts(id)
    return c('sync-health.refresh.result', 'label', {
      captures: captures.pulled,
      observations: obs.pulled,
      verdicts: verdicts.pulled,
    })
  }, [])

  // Pull on open. Without it the page reports this laptop's cache, which is the
  // same partial view that let the original failure hide for months.
  useEffect(() => {
    if (!workshopId) return
    let cancelled = false
    void (async () => {
      // Inside the async body rather than the effect body: a synchronous
      // setState in an effect is a cascading render, and the lint rule that
      // says so is right.
      setPulling(true)
      try {
        const msg = await refresh(workshopId)
        if (cancelled) return
        setNow(Date.now())
        setPullMsg(msg)
      } finally {
        if (!cancelled) setPulling(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workshopId, refresh])

  const funnel = useLiveQuery(
    async () => {
      if (!workshopId) return null
      const [evaluations, observations, verdicts] = await Promise.all([
        db.evaluations.where('workshop_id').equals(workshopId).toArray(),
        db.observations.where('workshop_id').equals(workshopId).toArray(),
        db.verifications.where('workshop_id').equals(workshopId).toArray(),
      ])
      return buildSyncFunnel(evaluations, observations, verdicts, getRequiredConfirmations())
    },
    [workshopId],
    null,
  )

  const exceptions = funnel ? exceptionRows(funnel) : null
  const r = funnel?.rollup

  const onRefresh = () => {
    if (!workshopId) return
    setPulling(true)
    void (async () => {
      try {
        setPullMsg(await refresh(workshopId))
        setNow(Date.now())
      } finally {
        setPulling(false)
      }
    })()
  }

  return (
    <>
      <PageHeader
        title={c('sync-health.title')}
        crumbs={[
          { label: c('nav.group.dashboard'), to: '/admin/overview' },
          { label: c('sync-health.title') },
        ]}
        meta={funnel ? c('sync-health.meta', 'label', { threshold: funnel.threshold }) : undefined}
        actions={
          <button className="ghost small" disabled={pulling || !workshopId} onClick={onRefresh}>
            {pulling ? c('sync-health.refresh.busy') : c('sync-health.refresh')}
          </button>
        }
      />

      {!isSupabaseConfigured && (
        <div className="banner warn" role="alert">
          <Copy id="sync-health.no-backend" />
        </div>
      )}

      <p className="muted small">
        <Copy id="sync-health.intro" />
      </p>

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-5)' }}>
        <StatTile
          label={c('sync-health.stage.unsynced')}
          value={r?.unsynced ?? '—'}
          sub={c('sync-health.stage.unsynced.sub')}
          attention={(r?.unsynced ?? 0) > 0}
        />
        <StatTile
          label={c('sync-health.stage.unrouted')}
          value={r?.syncedUnrouted ?? '—'}
          sub={c('sync-health.stage.unrouted.sub')}
          to="/admin/routing"
          attention={(r?.syncedUnrouted ?? 0) > 0}
        />
        <StatTile
          label={c('sync-health.stage.unverified')}
          value={r?.routedUnverified ?? '—'}
          sub={c('sync-health.stage.unverified.sub')}
          to="/observations"
          attention={(r?.routedUnverified ?? 0) > 0}
        />
        <StatTile
          label={c('sync-health.stage.counting')}
          value={r?.verifiedCounting ?? '—'}
          sub={c('sync-health.stage.counting.sub')}
        />
      </div>

      {pullMsg && <p className="muted small">{pullMsg}</p>}
      {funnel && funnel.draftsExcluded > 0 && (
        <p className="muted small">
          {c('sync-health.drafts-excluded', 'label', { count: funnel.draftsExcluded })}
        </p>
      )}

      {funnel && exceptions && (
        <>
          <Exceptions
            titleId="sync-health.errors.title"
            emptyId="sync-health.errors.empty"
            rows={exceptions.errored}
            now={now}
            detailHeaderId="sync-health.col.message"
            detail={(row) => <span className="pill error">{row.sync_error ?? c('sync-health.no-message')}</span>}
          />
          <Exceptions
            titleId="sync-health.unrouted.title"
            emptyId="sync-health.unrouted.empty"
            rows={exceptions.unrouted}
            now={now}
            detailHeaderId="sync-health.col.action"
            detail={() => <Link to="/admin/routing">{c('sync-health.action.route')}</Link>}
          />
          <Exceptions
            titleId="sync-health.unverified.title"
            emptyId="sync-health.unverified.empty"
            rows={exceptions.unverified}
            now={now}
            detailHeaderId="sync-health.col.action"
            detail={(row) => (
              <>
                <span className="muted">
                  {c('sync-health.unverified.counts', 'label', {
                    counting: row.counting,
                    total: row.observations,
                    disputed: row.disputed,
                  })}
                </span>{' '}
                <Link to="/observations">{c('sync-health.action.verify')}</Link>
              </>
            )}
          />

          <div className="card" style={{ marginTop: 'var(--s-5)' }}>
            <h2>
              <Copy id="sync-health.by-evaluator.title" />
            </h2>
            <p className="muted small">
              <Copy id="sync-health.by-evaluator.intro" />
            </p>
            <DataTable
              rows={funnel.byEvaluator}
              rowKey={(e) => e.evaluator_email}
              defaultSort="submitted"
              empty={<p className="muted small">{c('sync-health.by-evaluator.empty')}</p>}
              columns={[
                {
                  key: 'evaluator',
                  header: c('sync-health.col.evaluator'),
                  sortValue: (e) => e.evaluator_email,
                  render: (e) => e.evaluator_email,
                },
                {
                  key: 'submitted',
                  header: c('sync-health.col.submitted'),
                  numeric: true,
                  sortValue: (e) => e.total,
                  render: (e) => e.total,
                },
                {
                  key: 'unrouted',
                  header: c('sync-health.stage.unrouted'),
                  numeric: true,
                  sortValue: (e) => e.syncedUnrouted,
                  render: (e) => e.syncedUnrouted,
                },
                {
                  key: 'unverified',
                  header: c('sync-health.stage.unverified'),
                  numeric: true,
                  sortValue: (e) => e.routedUnverified,
                  render: (e) => e.routedUnverified,
                },
                {
                  key: 'counting',
                  header: c('sync-health.stage.counting'),
                  numeric: true,
                  sortValue: (e) => e.verifiedCounting,
                  render: (e) => e.verifiedCounting,
                },
              ]}
            />
          </div>
        </>
      )}
    </>
  )
}

/**
 * One block of exceptions. Only the rows that need a human — a table of the
 * healthy majority would bury the three rows that matter, which is how a
 * dashboard becomes something nobody reads.
 */
function Exceptions({
  titleId,
  emptyId,
  rows,
  now,
  detail,
  detailHeaderId,
}: {
  titleId: string
  emptyId: string
  rows: FunnelRow[]
  now: number
  detail: (row: FunnelRow) => React.ReactNode
  detailHeaderId: string
}) {
  const columns: Column<FunnelRow>[] = [
    {
      key: 'evaluator',
      header: c('sync-health.col.evaluator'),
      sortValue: (row) => row.evaluator_email ?? '',
      render: (row) => row.evaluator_email ?? c('sync-health.unattributed'),
    },
    {
      key: 'age',
      header: c('sync-health.col.age'),
      // Sorted on the raw timestamp, not the rendered age: "3 days" and
      // "3 hours" compare as strings in the wrong order.
      sortValue: (row) => row.submitted_at,
      render: (row) => formatAge(row.submitted_at, now),
    },
    { key: 'detail', header: c(detailHeaderId), render: detail },
  ]
  return (
    <div className="card" style={{ marginTop: 'var(--s-5)' }}>
      <h2>
        <Copy id={titleId} /> <span className="muted small">({rows.length})</span>
      </h2>
      <DataTable
        rows={rows}
        rowKey={(row) => row.client_id}
        columns={columns}
        defaultSort="age"
        defaultDir="asc"
        empty={
          <p className="muted small">
            <Copy id={emptyId} />
          </p>
        }
      />
    </div>
  )
}
