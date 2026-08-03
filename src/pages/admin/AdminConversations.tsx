import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { assignableEvaluators } from '../../db/directory'
import {
  assignConversation,
  evaluatorLoads,
  reconcileMentoringConversations,
  setAdminGuidance,
  unassignConversation,
} from '../../db/mentoring'
import type { EvaluatorLoad } from '../../db/mentoring'
import { useAuth } from '../../auth/AuthContext'
import { useScopedWorkshopId } from '../../layout/roles'
import { PageHeader } from '../../layout/PageHeader'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { Drawer } from '../../components/data/Drawer'
import { EmptyState } from '../../components/data/EmptyState'
import { Copy } from '../../components/Copy'
import { c } from '../../lib/content/chrome'
import type { MentoringConversation, WorkshopPerson } from '../../lib/types'

/**
 * The administrator's conversation queue.
 *
 * Joshua's feedback was that conversations are an administrator's function and
 * that handing one to an evaluator should carry guidance on how to open it. Both
 * halves are here; the evaluator's side of the same rows is tl-06.
 *
 * Three views rather than one table, because an admin arrives with one of three
 * questions and a single sortable list answers none of them well: what needs
 * handing out, who has room to take it, and where is that one conversation I was
 * thinking about.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { dateStyle: 'medium' })
}

const OPEN_STATUSES = new Set(['needed', 'scheduled'])

// ---------------------------------------------------------------------------
// The assignment drawer
// ---------------------------------------------------------------------------

function AssignPanel({
  conv,
  evaluators,
  actorEmail,
  onClose,
}: {
  conv: MentoringConversation
  evaluators: WorkshopPerson[]
  actorEmail: string | null
  onClose: () => void
}) {
  // Assignment and guidance are two independent saves on purpose: an admin can
  // work out how a conversation should be opened before deciding who is the
  // right person to open it, and the spec asks for exactly that order.
  const [choice, setChoice] = useState(conv.assigned_to ?? '')
  const [guidance, setGuidance] = useState(conv.admin_guidance ?? '')
  const [savingAssign, setSavingAssign] = useState(false)
  const [savingGuidance, setSavingGuidance] = useState(false)
  const [guidanceSaved, setGuidanceSaved] = useState(false)

  const handleAssign = async () => {
    if (!choice) return
    setSavingAssign(true)
    await assignConversation(conv.id, { assignedTo: choice, assignedBy: actorEmail })
    setSavingAssign(false)
  }

  const handleUnassign = async () => {
    setSavingAssign(true)
    await unassignConversation(conv.id)
    setChoice('')
    setSavingAssign(false)
  }

  const handleGuidance = async () => {
    setSavingGuidance(true)
    await setAdminGuidance(conv.id, guidance)
    setSavingGuidance(false)
    setGuidanceSaved(true)
  }

  return (
    <>
      <p className="small muted">
        <strong>{conv.participant_name}</strong>
        {conv.trigger_ksa_code && (
          <>
            {' · '}
            {c('admin-conversations.drawer.trigger', 'label', {
              ksa: conv.trigger_ksa_code,
              designation: conv.trigger_designation ?? '?',
            })}
          </>
        )}
      </p>

      <p className="small">
        {conv.assigned_to
          ? c('admin-conversations.assign.current', 'label', {
              email: conv.assigned_to,
              date: fmtDate(conv.assigned_at) || '—',
            })
          : c('admin-conversations.assign.none')}
      </p>

      {evaluators.length === 0 ? (
        <p className="small muted">
          <Copy id="admin-conversations.assign.no-evaluators" />
        </p>
      ) : (
        <>
          <label htmlFor="tl05-assignee">
            <Copy id="admin-conversations.assign.label" />
          </label>
          <select
            id="tl05-assignee"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            style={{ marginBottom: '0.5rem' }}
          >
            <option value="">{c('admin-conversations.assign.placeholder')}</option>
            {evaluators.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
          <div className="row" style={{ marginBottom: '1rem' }}>
            <button
              type="button"
              className="primary"
              onClick={handleAssign}
              disabled={savingAssign || !choice || choice === conv.assigned_to}
            >
              {savingAssign
                ? c('admin-conversations.assign.saving')
                : conv.assigned_to
                  ? c('admin-conversations.assign.reassign')
                  : c('admin-conversations.assign.submit')}
            </button>
            {conv.assigned_to && (
              <button type="button" onClick={handleUnassign} disabled={savingAssign}>
                {c('admin-conversations.assign.unassign')}
              </button>
            )}
          </div>
        </>
      )}

      <label htmlFor="tl05-guidance">
        <Copy id="admin-conversations.guidance.label" />
      </label>
      <p className="small muted" style={{ marginTop: 0 }}>
        <Copy id="admin-conversations.guidance.help" />
      </p>
      <textarea
        id="tl05-guidance"
        value={guidance}
        rows={5}
        placeholder={c('admin-conversations.guidance.placeholder')}
        onChange={(e) => {
          setGuidance(e.target.value)
          setGuidanceSaved(false)
        }}
        style={{ marginBottom: '0.5rem' }}
      />
      <div className="row">
        <button type="button" onClick={handleGuidance} disabled={savingGuidance}>
          {savingGuidance
            ? c('admin-conversations.assign.saving')
            : c('admin-conversations.guidance.save')}
        </button>
        {guidanceSaved && (
          <span className="small muted">{c('admin-conversations.guidance.saved')}</span>
        )}
        {!guidanceSaved && conv.admin_guidance_updated_at && (
          <span className="small muted">
            {c('admin-conversations.guidance.stamp', 'label', {
              date: fmtDate(conv.admin_guidance_updated_at),
            })}
          </span>
        )}
      </div>
      <div className="row" style={{ marginTop: '1rem' }}>
        <button type="button" onClick={onClose}>
          {c('nav.close')}
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdminConversations() {
  const { identity } = useAuth()
  const workshopId = useScopedWorkshopId()
  const [openId, setOpenId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)

  useEffect(() => {
    void reconcileMentoringConversations()
  }, [])

  // Scoped to the active workshop, for the reason useNavCounts records about its
  // own scoped query: the reference cache holds every workshop this account can
  // read, so an unscoped list would mix two workshops' queues under one
  // workshop's heading.
  const conversations = useLiveQuery(
    () =>
      workshopId
        ? db.mentoringConversations.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as MentoringConversation[]),
    [workshopId],
    [] as MentoringConversation[],
  )

  const evaluators = useLiveQuery(
    () => assignableEvaluators(workshopId),
    [workshopId],
    [] as WorkshopPerson[],
  )

  const all = useMemo(
    () =>
      [...(conversations ?? [])].sort((a, b) =>
        a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
      ),
    [conversations],
  )
  const unassigned = useMemo(
    () => all.filter((x) => !x.assigned_to && OPEN_STATUSES.has(x.status)),
    [all],
  )
  const loads = useMemo(
    () => evaluatorLoads(all, (evaluators ?? []).map((e) => e.email)),
    [all, evaluators],
  )

  const openConv = openId ? (all.find((x) => x.id === openId) ?? null) : null

  const handleReconcile = async () => {
    setReconciling(true)
    setReconcileMsg(null)
    const { added, repaired } = await reconcileMentoringConversations()
    const parts = [
      added > 0
        ? c('admin-conversations.reconcile.found', 'label', { added })
        : c('admin-conversations.reconcile.none'),
    ]
    if (repaired > 0) {
      parts.push(c('admin-conversations.reconcile.repaired', 'label', { repaired }))
    }
    setReconcileMsg(parts.join(' '))
    setReconciling(false)
  }

  const queueColumns: Column<MentoringConversation>[] = [
    {
      key: 'participant',
      header: c('admin-conversations.col.participant'),
      sticky: true,
      sortValue: (r) => r.participant_name,
      render: (r) => <strong>{r.participant_name}</strong>,
    },
    {
      key: 'trigger',
      header: c('admin-conversations.col.trigger'),
      sortValue: (r) => r.trigger_ksa_code ?? '',
      render: (r) => (
        <span className="small">
          {r.trigger_ksa_code ?? '—'}
          {r.trigger_designation !== null && (
            <span className="pill" style={{ marginLeft: '0.4rem' }}>
              {r.trigger_designation}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: c('admin-conversations.col.status'),
      sortValue: (r) => r.status,
      render: (r) => <span className="pill">{r.status}</span>,
    },
    {
      key: 'assignee',
      header: c('admin-conversations.col.assignee'),
      // Sorts unassigned to the top in the default descending direction, because
      // the row with nobody's name on it is the one wanting an admin's attention.
      sortValue: (r) => r.assigned_to ?? '',
      render: (r) =>
        r.assigned_to ? (
          <span className="small">{r.assigned_to}</span>
        ) : (
          <span className="pill queued">{c('admin-conversations.unassigned.pill')}</span>
        ),
    },
    {
      key: 'guidance',
      header: c('admin-conversations.col.guidance'),
      sortValue: (r) => (r.admin_guidance ? 1 : 0),
      render: (r) => (
        <span className="small muted">
          {r.admin_guidance
            ? c('admin-conversations.guidance.yes')
            : c('admin-conversations.guidance.no')}
        </span>
      ),
    },
  ]

  const loadColumns: Column<EvaluatorLoad>[] = [
    {
      key: 'evaluator',
      header: c('admin-conversations.load.col.evaluator'),
      sticky: true,
      sortValue: (r) => r.email,
      render: (r) => r.email,
    },
    {
      key: 'open',
      header: c('admin-conversations.load.col.open'),
      numeric: true,
      sortValue: (r) => r.open,
      render: (r) => r.open,
    },
    {
      key: 'scheduled',
      header: c('admin-conversations.load.col.scheduled'),
      numeric: true,
      sortValue: (r) => r.scheduled,
      render: (r) => r.scheduled,
    },
    {
      key: 'completed',
      header: c('admin-conversations.load.col.completed'),
      numeric: true,
      sortValue: (r) => r.completed,
      render: (r) => r.completed,
    },
  ]

  return (
    <>
      <PageHeader
        title={c('admin-conversations.title')}
        meta={<Copy id="admin-conversations.intro" className="small muted" as="span" />}
        actions={
          <div className="row">
            <button type="button" onClick={handleReconcile} disabled={reconciling}>
              {reconciling
                ? c('admin-conversations.reconcile.working')
                : c('admin-conversations.reconcile')}
            </button>
            {reconcileMsg && <span className="small muted">{reconcileMsg}</span>}
          </div>
        }
      />

      {all.length === 0 ? (
        <div className="card">
          <EmptyState title={c('admin-conversations.empty')} />
        </div>
      ) : (
        <>
          <div className="card">
            <h2>
              <Copy id="admin-conversations.unassigned.title" />
            </h2>
            <p className="small muted">
              <Copy id="admin-conversations.unassigned.intro" />
            </p>
            <DataTable
              rows={unassigned}
              columns={queueColumns}
              rowKey={(r) => r.id}
              defaultSort="participant"
              defaultDir="asc"
              onRowClick={(r) => setOpenId(r.id)}
              selectedKey={openId}
              empty={<EmptyState title={c('admin-conversations.unassigned.empty')} />}
            />
          </div>

          <div className="card">
            <h2>
              <Copy id="admin-conversations.load.title" />
            </h2>
            <p className="small muted">
              <Copy id="admin-conversations.load.intro" />
            </p>
            <DataTable
              rows={loads}
              columns={loadColumns}
              rowKey={(r) => r.email}
              defaultSort="open"
              empty={<EmptyState title={c('admin-conversations.load.empty')} />}
            />
          </div>

          <div className="card">
            <h2>
              <Copy id="admin-conversations.all.title" />
            </h2>
            <p className="small muted">
              <Copy id="admin-conversations.all.intro" />
            </p>
            <DataTable
              rows={all}
              columns={queueColumns}
              rowKey={(r) => r.id}
              defaultSort="participant"
              defaultDir="asc"
              onRowClick={(r) => setOpenId(r.id)}
              selectedKey={openId}
            />
          </div>
        </>
      )}

      <Drawer
        open={openConv !== null}
        onClose={() => setOpenId(null)}
        title={c('admin-conversations.drawer.title')}
      >
        {openConv && (
          // Remounted per conversation, per the Web App Build Protocol's second
          // reliability invariant: a singleton panel that clears its draft in an
          // effect leaks the last conversation's guidance into the next one, and
          // guidance is exactly the field where that would be believed.
          <AssignPanel
            key={openConv.id}
            conv={openConv}
            evaluators={evaluators ?? []}
            actorEmail={identity?.email ?? null}
            onClose={() => setOpenId(null)}
          />
        )}
      </Drawer>
    </>
  )
}
