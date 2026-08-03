import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { loadReferenceData } from '../../db/reference'
import { rejectedReferenceWrites } from '../../db/referenceWrite'
import { isSupabaseConfigured } from '../../lib/supabase'
import { c } from '../../lib/content/chrome'
import { useScopedWorkshopId } from '../../layout/roles'
import { PageHeader } from '../../layout/PageHeader'
import { ProposalPanel } from '../../devfeedback/ProposalPanel'
import { SetupSaveProvider } from '../../setup/SetupSaveProvider'
import { SeverityPill } from '../../setup/SetupChangeDialog'
import { pushSetupLog, readSetupLog } from '../../setup/log'
import { useWorkshopState } from '../../setup/state'
import { BasicsSection } from '../../setup/sections/BasicsSection'
import { QuestionsSection } from '../../setup/sections/QuestionsSection'
import { EventsSection } from '../../setup/sections/EventsSection'
import { WiringSection } from '../../setup/sections/WiringSection'
import { ScaleSection } from '../../setup/sections/ScaleSection'
import { PeopleSection } from '../../setup/sections/PeopleSection'
import { AiSection } from '../../setup/sections/AiSection'
import { TemplatesSection } from '../../setup/sections/AiAndTemplates'
import { Roster } from './Roster'
import type { ReferenceOutboxEntry, SetupChangeLogEntry, Workshop } from '../../lib/types'

/**
 * The Setup hub (tl-07): one place that owns the whole workshop definition.
 *
 * Every editor here already existed — the Scenario Builder, the Roster, the parts of
 * Settings that are settings. What did not exist was a place that presents them as
 * one coherent act of setting a workshop up, a first-run path for somebody who has
 * never done it, and a warning layer in front of every save.
 *
 * Three structural decisions:
 *
 *  1. **Each section is a route** (`/admin/setup/<section>`), so a link can point at
 *     one and an admin can be sent straight to the thing that needs their attention.
 *  2. **The editors were MOVED, not copied.** `/builder`, `/admin/roster` and
 *     `/admin/settings` redirect here. Two editors for one entity diverge, and this
 *     wave has no budget for reconciling them later.
 *  3. **The provider wraps the sections, not each form.** The change dialog is
 *     rendered once, by SetupSaveProvider, so a new section cannot ship without the
 *     warning layer — the only way to save is a hook that classifies first.
 */

interface SectionSpec {
  key: string
  labelId: string
  helpId: string
}

/** In the order somebody actually sets a workshop up. */
const SECTIONS: SectionSpec[] = [
  { key: 'basics', labelId: 'setup.nav.basics', helpId: 'setup.nav.basics-help' },
  { key: 'goals', labelId: 'setup.nav.goals', helpId: 'setup.nav.goals-help' },
  { key: 'calendar', labelId: 'setup.nav.calendar', helpId: 'setup.nav.calendar-help' },
  { key: 'scale', labelId: 'setup.nav.scale', helpId: 'setup.nav.scale-help' },
  { key: 'participants', labelId: 'setup.nav.participants', helpId: 'setup.nav.participants-help' },
  { key: 'people', labelId: 'setup.nav.people', helpId: 'setup.nav.people-help' },
  { key: 'ai', labelId: 'setup.nav.ai', helpId: 'setup.nav.ai-help' },
  { key: 'templates', labelId: 'setup.nav.templates', helpId: 'setup.nav.templates-help' },
]

/**
 * What each section still needs, as chrome ids.
 *
 * "What is unset", not a progress bar: a bar that reads 62% tells an administrator
 * nothing they can act on, and a list of three missing things tells them exactly what
 * to do next. Sections owned by a later spec report nothing missing rather than
 * reporting themselves as incomplete forever.
 */
function unsetFor(section: string, overview: Overview): string[] {
  switch (section) {
    case 'basics': {
      const out: string[] = []
      if (!overview.hasName) out.push('setup.unset.name')
      if (!overview.hasDates) out.push('setup.unset.dates')
      return out
    }
    case 'goals':
      return overview.questions === 0 ? ['setup.unset.questions'] : []
    case 'calendar': {
      const out: string[] = []
      if (overview.events === 0) out.push('setup.unset.events')
      else if (overview.eventsWithoutQuestions > 0) out.push('setup.unset.wiring')
      return out
    }
    case 'participants':
      return overview.participants === 0 ? ['setup.unset.participants'] : []
    case 'people':
      return overview.evaluators === 0 ? ['setup.unset.evaluators'] : []
    default:
      return []
  }
}

interface Overview {
  hasName: boolean
  hasDates: boolean
  events: number
  eventsWithoutQuestions: number
  questions: number
  participants: number
  evaluators: number
}

function useOverview(workshop: Workshop | null): Overview {
  const empty: Overview = {
    hasName: false,
    hasDates: false,
    events: 0,
    eventsWithoutQuestions: 0,
    questions: 0,
    participants: 0,
    evaluators: 0,
  }
  const overview = useLiveQuery(
    async () => {
      if (!workshop) return empty
      const [events, links, questions, participants, people] = await Promise.all([
        db.activities.where('workshop_id').equals(workshop.id).toArray(),
        db.activityKsas.toArray(),
        // Scoped (tl-08). An unscoped count read the whole deployment's library, so
        // a brand-new workshop with no questions of its own would have reported the
        // Goals section complete on the strength of another workshop's work.
        db.ksas.where('workshop_id').equals(workshop.id).count(),
        db.participants.where('workshop_id').equals(workshop.id).count(),
        db.workshopPeople.where('workshop_id').equals(workshop.id).toArray(),
      ])
      const wired = new Set(links.map((l) => l.activity_id))
      return {
        hasName: Boolean(workshop.name?.trim()),
        hasDates: Boolean(workshop.start_date && workshop.end_date),
        events: events.length,
        eventsWithoutQuestions: events.filter((e) => !wired.has(e.id)).length,
        questions,
        participants,
        evaluators: people.filter((p) => p.role !== 'participant').length,
      }
    },
    [workshop?.id, workshop?.name, workshop?.start_date, workshop?.end_date],
    empty,
  )
  return overview ?? empty
}

export function Setup() {
  const { section } = useParams<{ section?: string }>()
  const workshopId = useScopedWorkshopId()
  const workshop = useLiveQuery<Workshop | undefined, undefined>(
    () => (workshopId ? db.workshops.get(workshopId) : Promise.resolve(undefined)),
    [workshopId],
    undefined,
  )
  const state = useWorkshopState(workshopId)
  const overview = useOverview(workshop ?? null)

  // Drain the log outbox when an admin opens Setup. Deliberately not in
  // startSyncLoop: an evaluator's device holds no setup log to push, and adding a
  // fifth table to that loop would have every phone asking for a table its role
  // cannot read.
  useEffect(() => {
    void pushSetupLog()
  }, [])

  const active = SECTIONS.find((s) => s.key === section) ?? null
  const firstRun = overview.events === 0 && overview.eventsWithoutQuestions === 0 && overview.participants === 0

  return (
    <SetupSaveProvider workshopId={workshopId}>
      <PageHeader
        title={c(active ? active.labelId : 'setup.title')}
        crumbs={
          active
            ? [{ label: c('setup.title'), to: '/admin/setup' }, { label: c(active.labelId) }]
            : [{ label: c('setup.crumb') }]
        }
        meta={
          workshop ? (
            <>
              {workshop.name} · <StateChip state={state} />
            </>
          ) : (
            c('setup.no-workshop')
          )
        }
      />

      {!workshop ? (
        <div className="banner warn">{c('setup.no-workshop-detail')}</div>
      ) : (
        <>
          <SectionTabs current={active?.key ?? null} overview={overview} />

          {active ? (
            <SectionBody section={active.key} workshop={workshop} />
          ) : (
            <>
              {firstRun ? (
                <FirstRun overview={overview} />
              ) : (
                <SectionCards overview={overview} />
              )}
              <BackendCard />
              <RejectedWrites />
              <RecentChanges workshopId={workshop.id} />
              <ProposalPanel />
            </>
          )}
        </>
      )}
    </SetupSaveProvider>
  )
}

function SectionBody({ section, workshop }: { section: string; workshop: Workshop }) {
  switch (section) {
    case 'basics':
      return <BasicsSection workshop={workshop} />
    case 'goals':
      return <QuestionsSection workshop={workshop} />
    case 'calendar':
      return (
        <>
          <EventsSection workshop={workshop} />
          <WiringSection workshop={workshop} />
        </>
      )
    case 'scale':
      return <ScaleSection workshopId={workshop.id} />
    case 'participants':
      return <Roster embedded />
    case 'people':
      return <PeopleSection workshop={workshop} />
    case 'ai':
      return <AiSection workshopId={workshop.id} />
    case 'templates':
      return <TemplatesSection />
    default:
      return <div className="banner warn">{c('setup.unknown-section')}</div>
  }
}

function StateChip({ state }: { state: 'draft' | 'in_progress' | 'closed' }) {
  const cls = state === 'draft' ? 'ok' : state === 'in_progress' ? 'queued' : 'local'
  return <span className={`pill ${cls}`}>{c(`setup.state.${state === 'in_progress' ? 'in-progress' : state}`)}</span>
}

function SectionTabs({ current, overview }: { current: string | null; overview: Overview }) {
  return (
    <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
      <Link className={current === null ? 'pill ok' : 'pill local'} to="/admin/setup">
        {c('setup.nav.overview')}
      </Link>
      {SECTIONS.map((s) => {
        const missing = unsetFor(s.key, overview).length
        return (
          <Link
            key={s.key}
            className={current === s.key ? 'pill ok' : missing > 0 ? 'pill queued' : 'pill local'}
            to={`/admin/setup/${s.key}`}
          >
            {c(s.labelId)}
            {missing > 0 ? ' ·' : ''}
          </Link>
        )
      })}
    </div>
  )
}

function SectionCards({ overview }: { overview: Overview }) {
  return (
    <div className="grid grid--split">
      {SECTIONS.map((s) => {
        const missing = unsetFor(s.key, overview)
        return (
          <div className="card" key={s.key}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>
                <Link to={`/admin/setup/${s.key}`}>{c(s.labelId)}</Link>
              </h2>
              {missing.length === 0 ? (
                <span className="pill ok">{c('setup.complete')}</span>
              ) : (
                <span className="pill queued">{c('setup.needs-attention')}</span>
              )}
            </div>
            <p className="small muted">{c(s.helpId)}</p>
            {missing.length > 0 && (
              <ul className="small">
                {missing.map((id) => (
                  <li key={id}>{c(id)}</li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The first-run path: a sequence, not a dashboard of empty cards.
 *
 * A grid of eight empty sections is a fair description of the state and useless as
 * an instruction. Somebody who has never set a workshop up needs to be told what to
 * do first.
 */
function FirstRun({ overview }: { overview: Overview }) {
  const next = SECTIONS.find((s) => unsetFor(s.key, overview).length > 0) ?? SECTIONS[0]
  return (
    <div className="card form-col">
      <h2>{c('setup.first-run.title')}</h2>
      <p className="small muted">{c('setup.first-run.help')}</p>
      <ol className="small">
        {SECTIONS.map((s) => (
          <li key={s.key} style={{ marginBottom: '0.25rem' }}>
            <Link to={`/admin/setup/${s.key}`}>{c(s.labelId)}</Link> — {c(s.helpId)}
          </li>
        ))}
      </ol>
      <div className="row">
        <Link className="pill ok" to={`/admin/setup/${next.key}`}>
          {c('setup.first-run.start', 'label', { section: c(next.labelId) })}
        </Link>
        <Link className="pill local" to="/admin/setup/ai">
          {c('setup.first-run.ai')}
        </Link>
      </div>
    </div>
  )
}

/** Backend status and the manual reference reload, moved from Settings. */
function BackendCard() {
  const [busy, setBusy] = useState(false)
  return (
    <div className="card form-col">
      <h2>{c('setup.backend.title')}</h2>
      <p className="muted small">
        {isSupabaseConfigured ? c('setup.backend.configured') : c('setup.backend.local')}
      </p>
      <div className="row">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await loadReferenceData()
            } finally {
              setBusy(false)
            }
          }}
        >
          {c('setup.backend.reload')}
        </button>
      </div>
      <p className="small muted">{c('setup.backend.reload-note')}</p>
    </div>
  )
}

/**
 * Reference edits the backend refused (tl-01 left this with nothing displaying it).
 *
 * These are the worst kind of divergence: the edit stands on this device, will never
 * reach anybody else, and until now said so only in a console. An administrator
 * looking at Setup is exactly the person who can act on it.
 */
function RejectedWrites() {
  const rejected = useLiveQuery(() => rejectedReferenceWrites(), [], [] as ReferenceOutboxEntry[])
  if (!rejected || rejected.length === 0) return null
  return (
    <div className="card">
      <h2>{c('setup.rejected.title')}</h2>
      <p className="small muted">{c('setup.rejected.help', 'label', { count: rejected.length })}</p>
      {rejected.map((entry) => (
        <p className="small" key={entry.id}>
          <span className="pill error">{entry.op}</span> <strong>{entry.table}</strong> ·{' '}
          {entry.rowKey} · {entry.rejectedReason ?? c('setup.rejected.no-reason')}
        </p>
      ))}
    </div>
  )
}

/** The setup audit log, as this device holds it. */
function RecentChanges({ workshopId }: { workshopId: string }) {
  const entries = useLiveQuery(
    () => readSetupLog(workshopId, 25),
    [workshopId],
    [] as SetupChangeLogEntry[],
  )
  return (
    <div className="card">
      <h2>{c('setup.log.title')}</h2>
      <p className="small muted">{c('setup.log.help')}</p>
      {(entries ?? []).length === 0 ? (
        <p className="small muted">{c('setup.log.empty')}</p>
      ) : (
        (entries ?? []).map((e) => (
          <p className="small" key={e.id}>
            <SeverityPill severity={e.severity} /> <strong>{e.entity_label}</strong> · {e.operation}{' '}
            · {e.at.slice(0, 16).replace('T', ' ')} · {e.actor_email ?? c('setup.log.unknown-actor')}
            {e.sync_status !== 'synced' && (
              <>
                {' '}
                <span className="pill queued">{c('setup.log.not-synced')}</span>
              </>
            )}
          </p>
        ))
      )}
    </div>
  )
}