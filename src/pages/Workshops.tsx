import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { db } from '../db/local'
import { createWorkshop, workshopReachedBackend } from '../db/referenceWrite'
import { getSettings, mirrorActiveWorkshop } from '../db/settings'
import { PageHeader } from '../layout/PageHeader'
import { useIsPlatformOwner, useScopedWorkshopId } from '../layout/roles'
import { setActiveWorkshopId } from '../lib/activeWorkshop'
import { c } from '../lib/content/chrome'
import {
  buildWorkshopCards,
  observationsForWorkshop,
  pendingTotal,
  type WorkshopCard,
} from '../reports/workshopOverview'
import type { WorkshopMember } from '../lib/types'

/**
 * The cross-workshop cockpit (tl-17).
 *
 * Answers "how is each of my workshops doing" without making the administrator
 * switch into each one to find out, and is the only place a workshop is created.
 *
 * Three things about it are deliberate.
 *
 * **Every card action switches first.** Set up and Health are ordinary links into
 * the active-workshop surfaces, so following one without switching would show the
 * Crash Course's card and Bali's setup page. Switching first makes a card a safe
 * entry point and means nothing here is ever a cross-workshop write.
 *
 * **The numbers are per workshop, not combined.** No aggregate matrix, no total
 * across workshops: two workshops can run different questions, different scales
 * and different rosters, so a sum over them would be arithmetic on incomparable
 * things. tl-01 deferred cross-workshop reporting and this does not undefer it.
 *
 * **Create is `platform_owner` only, and renders nothing for anybody else** rather
 * than a disabled button. A disabled control is an invitation to ask why, and the
 * answer ("the insert policy names one role") is not something an admin can act
 * on. It mirrors `workshop_insert` in 20260728000700_workshop_membership.sql; RLS
 * refuses regardless, this only decides whether the form is offered.
 */
export function Workshops() {
  const { memberships, reloadMemberships } = useAuth()
  const activeId = useScopedWorkshopId()
  const isOwner = useIsPlatformOwner()
  const cards = useWorkshopCards(memberships)

  return (
    <>
      <PageHeader
        title={c('workshops.title')}
        crumbs={[{ label: c('workshops.crumb') }]}
        meta={c('workshops.meta', 'label', { count: memberships.length })}
      />

      <p className="small muted">{c('workshops.help')}</p>

      {isOwner && <CreateWorkshop onCreated={reloadMemberships} />}

      {cards === null ? (
        <p className="small muted">{c('workshops.loading')}</p>
      ) : cards.length === 0 ? (
        <div className="banner warn">{c('workshops.none')}</div>
      ) : (
        <div className="grid grid--split">
          {cards.map((card) => (
            <WorkshopCardView key={card.workshop_id} card={card} active={card.workshop_id === activeId} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * One card per membership, live from Dexie.
 *
 * Reads the whole of four tables once and partitions in memory rather than
 * issuing a query per workshop per table: at workshop scale the tables are small,
 * and the alternative is N×4 live queries whose re-render fan-out is the real
 * cost. Returns null while the first read is in flight so the page can tell "no
 * workshops" apart from "not read yet" — the same distinction membershipStatus
 * draws one level up, for the same reason.
 */
function useWorkshopCards(memberships: WorkshopMember[]): WorkshopCard[] | null {
  const ids = memberships.map((m) => m.workshop_id).join(',')
  return (
    useLiveQuery(
      async () => {
        const [workshops, participants, evaluations, observations, verdicts] = await Promise.all([
          db.workshops.toArray(),
          db.participants.toArray(),
          db.evaluations.toArray(),
          db.observations.toArray(),
          db.verifications.toArray(),
        ])
        const byId = new Map(workshops.map((w) => [w.id, w]))
        const inputs = await Promise.all(
          memberships.map(async (membership) => {
            const id = membership.workshop_id
            // THIS workshop's threshold, read from its own cached settings rows.
            // The synchronous getRequiredConfirmations() mirror holds only the
            // ACTIVE workshop's value, so using it here would grade every other
            // card against the wrong rule and silently move its numbers.
            const settings = await getSettings(id)
            return {
              membership,
              workshop: byId.get(id) ?? null,
              participants: participants.filter((p) => p.workshop_id === id).length,
              evaluations: evaluations.filter((e) => e.workshop_id === id),
              observations: observationsForWorkshop(observations, evaluations, id),
              verdicts,
              threshold: settings.requiredConfirmations,
            }
          }),
        )
        return buildWorkshopCards(inputs, new Date().toISOString())
      },
      [ids],
      null as WorkshopCard[] | null,
    ) ?? null
  )
}

function WorkshopCardView({ card, active }: { card: WorkshopCard; active: boolean }) {
  const navigate = useNavigate()
  const pending = pendingTotal(card)

  /**
   * Switch, then go. Every action on this card routes through here, so there is
   * no path from the overview into a workshop-scoped page that leaves the active
   * workshop pointing somewhere else.
   */
  const go = (to: string | null) => {
    setActiveWorkshopId(card.workshop_id)
    void mirrorActiveWorkshop(card.workshop_id)
    if (to) navigate(to)
  }

  return (
    <div className={`card${active ? ' card--active' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{card.name ?? c('workshops.unnamed')}</h2>
        <StateChip state={card.state} />
      </div>
      <p className="small muted">
        {describeDates(card)}
        {card.location ? ` · ${card.location}` : ''} · {c(`role.${card.role}`)}
        {active ? ` · ${c('workshops.current')}` : ''}
      </p>

      <div className="row" style={{ gap: 'var(--s-4)', flexWrap: 'wrap' }}>
        <Figure label={c('workshops.stat.participants')} value={String(card.participants)} />
        <Figure
          label={c('workshops.stat.coverage')}
          value={card.coveragePercent === null ? '—' : `${card.coveragePercent}%`}
          sub={
            card.coveragePercent === null
              ? c('workshops.stat.coverage-empty')
              : c('workshops.stat.coverage-sub', 'label', {
                  n: card.participantsWithEvidence,
                  total: card.participants,
                })
          }
        />
        <Figure
          label={c('workshops.stat.pending')}
          value={String(pending)}
          sub={c('workshops.stat.pending-sub', 'label', {
            unsynced: card.unsynced,
            unrouted: card.unrouted,
            unverified: card.unverified,
          })}
          attention={pending > 0}
        />
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button disabled={active} onClick={() => go(null)}>
          {active ? c('workshops.action.here') : c('workshops.action.switch')}
        </button>
        <button className="ghost" onClick={() => go('/admin/setup')}>
          {c('workshops.action.setup')}
        </button>
        <button className="ghost" onClick={() => go('/admin/workshop')}>
          {c('workshops.action.health')}
        </button>
      </div>
    </div>
  )
}

/**
 * A number with its label and denominator.
 *
 * Not `StatTile`: that one is a link or nothing, and every figure here has to
 * switch the active workshop before it navigates, which a bare `<Link>` cannot
 * do. The card's buttons carry the navigation instead.
 */
function Figure({
  label,
  value,
  sub,
  attention = false,
}: {
  label: string
  value: string
  sub?: string
  attention?: boolean
}) {
  return (
    <div className={`tile${attention ? ' tile--attention' : ''}`} style={{ flex: '1 1 8rem' }}>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {sub && <div className="tile__sub">{sub}</div>}
    </div>
  )
}

function StateChip({ state }: { state: WorkshopCard['state'] }) {
  const cls = state === 'draft' ? 'ok' : state === 'in_progress' ? 'queued' : 'local'
  return (
    <span className={`pill ${cls}`}>
      {c(`setup.state.${state === 'in_progress' ? 'in-progress' : state}`)}
    </span>
  )
}

function describeDates(card: WorkshopCard): string {
  if (card.start_date && card.end_date) return `${card.start_date} → ${card.end_date}`
  if (card.start_date) return `${c('workshops.from')} ${card.start_date}`
  if (card.end_date) return `${c('workshops.until')} ${card.end_date}`
  return c('workshops.no-dates')
}

/**
 * Create a workshop and land in guided setup.
 *
 * The sequence matters and every step of it has a failure it prevents:
 *
 *  1. `createWorkshop` writes to Dexie and enqueues the insert on the reference
 *     outbox, which is the app's own write path — writing straight to Supabase
 *     would work online and lose the workshop offline.
 *  2. **Wait for that insert to actually reach Postgres.** `createWorkshop` kicks
 *     the outbox off without awaiting it, which is right for every other caller
 *     and wrong for exactly this one, and getting it wrong is not a slow render:
 *     the creator's `chief_admin` row is written by an AFTER INSERT trigger, so
 *     until the insert lands there is no membership to find. This was a real bug
 *     and it failed the way client-side races do — the workshop was created, the
 *     admin was silently returned to the previous one, and nothing said why.
 *  3. `reloadMemberships` re-reads `workshop_member`, because the trigger's row
 *     is a fact the browser has no other way to learn.
 *  4. Only then switch and navigate.
 *
 * Offline, step 2 cannot complete: there is no membership because there is no
 * insert yet. The workshop is safely queued, so the honest answer is to say so
 * and leave the admin where they are, rather than switching them into a workshop
 * whose selection `resolveActiveWorkshopId` will discard on the next render. The
 * one thing not on the table is synthesizing a local membership to paper over it,
 * which would be the client naming its own privileges — the exact thing tl-01
 * spent a spec removing.
 */
function CreateWorkshop({ onCreated }: { onCreated: () => Promise<void> }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)

  const datesBackwards = Boolean(startDate && endDate && endDate < startDate)

  const submit = async () => {
    if (!name.trim() || datesBackwards) return
    setBusy(true)
    setError(null)
    setQueued(false)
    try {
      const created = await createWorkshop(name, {
        start_date: startDate || null,
        end_date: endDate || null,
        location: location.trim() || null,
      })

      if (!(await workshopReachedBackend(created.id))) {
        setQueued(true)
        return
      }

      await onCreated()
      setActiveWorkshopId(created.id)
      await mirrorActiveWorkshop(created.id)
      navigate('/admin/setup')
    } catch (err) {
      setError(err instanceof Error ? err.message : c('workshops.create.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="row">
        <button onClick={() => setOpen(true)}>{c('workshops.create.open')}</button>
      </div>
    )
  }

  return (
    <div className="card form-col">
      <h2>{c('workshops.create.title')}</h2>
      <p className="small muted">{c('workshops.create.help')}</p>

      <label className="small muted" htmlFor="new-ws-name">
        {c('workshops.create.name')}
      </label>
      <input
        id="new-ws-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={c('workshops.create.name-placeholder')}
      />

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span>
          <label className="small muted" htmlFor="new-ws-start">
            {c('workshops.create.start')}
          </label>
          <input
            id="new-ws-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </span>
        <span>
          <label className="small muted" htmlFor="new-ws-end">
            {c('workshops.create.end')}
          </label>
          <input
            id="new-ws-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </span>
        <span style={{ flex: 1 }}>
          <label className="small muted" htmlFor="new-ws-location">
            {c('workshops.create.location')}
          </label>
          <input
            id="new-ws-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={{ width: '100%' }}
          />
        </span>
      </div>

      <p className="small muted">{c('workshops.create.dates-note')}</p>
      {datesBackwards && <div className="banner warn">{c('workshops.create.dates-backwards')}</div>}
      {queued && <div className="banner warn">{c('workshops.create.queued')}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row">
        <button disabled={busy || !name.trim() || datesBackwards} onClick={() => void submit()}>
          {busy ? c('workshops.create.working') : c('workshops.create.submit')}
        </button>
        <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {c('workshops.create.cancel')}
        </button>
      </div>
    </div>
  )
}
