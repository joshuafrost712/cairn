import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { useAuth } from '../../auth/AuthContext'
import { useScopedWorkshopId } from '../../layout/roles'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { ASSIGNABLE_ROLES } from '../../db/directory'
import { applyProposals, assign, transfer, unassign } from '../../db/assignments'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import {
  autoAssign,
  buildBoard,
  fairShare,
  quotaFor,
  underCovered,
  type AssignmentProposal,
  type BoardCard,
  type BoardColumn,
  type EvaluatorRef,
} from '../../lib/assignment'
import { PageHeader } from '../../layout/PageHeader'
import { StatTile } from '../../components/data/StatTile'
import { ConfirmAction } from '../../components/data/ConfirmAction'
import { EmptyState } from '../../components/data/EmptyState'
import type { AssignmentKind, ReportAssignment, WorkshopPerson } from '../../lib/types'

/**
 * Who owes what, as a board.
 *
 * The page answers one question at a glance: which participants do not yet have
 * enough people responsible for them. That is why the colour rule is on the CARD
 * rather than on the column, and why the count in the header is participants
 * short rather than assignments made.
 *
 * Two boards, selected by `?kind=`, because review and observation are different
 * jobs held by overlapping people. Kind lives in the URL rather than in state so
 * a board can be linked to, matching the master-detail-in-the-URL choice already
 * made on Reports.
 *
 * Deliberately no drag-and-drop. It is expensive to build accessibly and it
 * degrades badly on the phone this will be opened on in a workshop room, where
 * a select is a native picker and a drag is a scroll you did not mean.
 */
export function Assignments() {
  const { identity } = useAuth()
  const workshopId = useScopedWorkshopId()
  const bundle = useAnalyticsBundle()
  const [params, setParams] = useSearchParams()
  const [proposals, setProposals] = useState<AssignmentProposal[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const kind: AssignmentKind = params.get('kind') === 'observation' ? 'observation' : 'review'
  const setKind = (k: AssignmentKind) => {
    setProposals(null)
    setMsg(null)
    setParams(k === 'review' ? {} : { kind: k }, { replace: true })
  }

  const people = useLiveQuery(
    () =>
      workshopId
        ? db.workshopPeople.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as WorkshopPerson[]),
    [workshopId],
    [] as WorkshopPerson[],
  )
  const assignments = useLiveQuery(
    () =>
      workshopId
        ? db.assignments.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as ReportAssignment[]),
    [workshopId],
    [] as ReportAssignment[],
  )
  const settings = useLiveQuery(
    async () =>
      workshopId
        ? resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray())
        : SETTINGS_DEFAULTS,
    [workshopId],
    SETTINGS_DEFAULTS,
  )

  const evaluators: EvaluatorRef[] = useMemo(
    () =>
      (people ?? [])
        .filter((p) => ASSIGNABLE_ROLES.includes(p.role))
        .map((p) => ({ email: p.email, name: p.name })),
    [people],
  )

  const required = settings.requiredConfirmations
  const participants = useMemo(
    () => bundle.participants.map((p) => ({ id: p.id, name: p.name })),
    [bundle.participants],
  )
  const share = fairShare(participants.length, evaluators.length, required)
  const quotaOf = useMemo(
    () => (email: string) => quotaFor(email, kind, settings, share),
    [kind, settings, share],
  )

  // "Who evaluated this person the most", taken straight from the analytics
  // layer rather than recomputed here. `topParticipants` already IS that
  // measure, and a second definition of it would drift from the one the
  // evaluator pages show.
  const affinity = useMemo(() => {
    const out = new Map<string, Map<string, number>>()
    for (const e of bundle.byEvaluator) {
      const m = new Map<string, number>()
      for (const p of e.topParticipants) {
        if (p.participant_id) m.set(p.participant_id, p.n)
      }
      out.set(e.evaluator, m)
    }
    return out
  }, [bundle.byEvaluator])

  // Review progress: of this participant's observations, how many has this
  // evaluator already ruled on. Built from the annotated set the bundle already
  // computed, so no extra query.
  const { observationsByParticipant, verdictsByEvaluator } = useMemo(() => {
    const byParticipant = new Map<string, string[]>()
    const byEvaluator = new Map<string, Set<string>>()
    for (const o of bundle.annotated) {
      if (o.participant_id) {
        const list = byParticipant.get(o.participant_id) ?? []
        list.push(o.id)
        byParticipant.set(o.participant_id, list)
      }
      for (const v of o.verdicts) {
        const set = byEvaluator.get(v.evaluator_email) ?? new Set<string>()
        set.add(o.id)
        byEvaluator.set(v.evaluator_email, set)
      }
    }
    return { observationsByParticipant: byParticipant, verdictsByEvaluator: byEvaluator }
  }, [bundle.annotated])

  const columns = useMemo(
    () =>
      buildBoard({
        participants,
        evaluators,
        assignments: assignments ?? [],
        kind,
        required,
        quotaOf,
        observationsByParticipant,
        verdictsByEvaluator,
      }),
    [
      participants,
      evaluators,
      assignments,
      kind,
      required,
      quotaOf,
      observationsByParticipant,
      verdictsByEvaluator,
    ],
  )

  const short = underCovered(columns)
  const by = identity?.email ?? null

  const propose = () => {
    setMsg(null)
    const next = autoAssign({
      participants,
      evaluators,
      affinity,
      existing: assignments ?? [],
      kind,
      required,
      quotaOf,
    })
    setProposals(next)
    if (next.length === 0) {
      setMsg(
        short > 0
          ? `Nothing to propose: every evaluator is at their quota, so ${short} participant(s) stay short. Raise a quota on Settings or add another evaluator.`
          : 'Nothing to propose: everybody already has enough assignees.',
      )
    }
  }

  const applyAll = async () => {
    if (!workshopId || !proposals) return
    setBusy(true)
    try {
      const n = await applyProposals(workshopId, proposals, kind, by)
      setProposals(null)
      setMsg(`${n} assignment(s) made.`)
    } finally {
      setBusy(false)
    }
  }

  if (!workshopId) {
    return (
      <>
        <PageHeader title="Assignments" crumbs={[{ label: 'Configure' }, { label: 'Assignments' }]} />
        <EmptyState title="No workshop selected">
          Choose a scenario in the <Link to="/builder">Scenario Builder</Link> first.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Assignments"
        crumbs={[{ label: 'Configure' }, { label: 'Assignments' }]}
        meta={
          short === 0
            ? 'Everybody has enough assignees'
            : `${short} participant${short === 1 ? '' : 's'} short of ${required}`
        }
        actions={
          <div className="row">
            <button
              className={kind === 'review' ? '' : 'ghost'}
              onClick={() => setKind('review')}
              aria-pressed={kind === 'review'}
            >
              Review
            </button>
            <button
              className={kind === 'observation' ? '' : 'ghost'}
              onClick={() => setKind('observation')}
              aria-pressed={kind === 'observation'}
            >
              Observation
            </button>
          </div>
        }
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-4)' }}>
        <StatTile
          label="Need another assignee"
          value={short}
          sub={`each participant needs ${required}`}
          attention={short > 0}
        />
        <StatTile label="Participants" value={participants.length} sub="on this roster" />
        <StatTile
          label="Evaluators"
          value={evaluators.length}
          sub={share === null ? 'nobody to assign to' : `even split is ${share} each`}
          attention={evaluators.length === 0}
        />
        <StatTile
          label="Assignments"
          value={(assignments ?? []).filter((a) => a.kind === kind).length}
          sub={`of ${kind === 'review' ? 'reports to review' : 'people to watch'}`}
        />
      </div>

      <div className="card form-col">
        <h2>{kind === 'review' ? 'Who reviews whom' : 'Who watches whom'}</h2>
        <p className="small muted">
          {kind === 'review' ? (
            <>
              A review assignment means you own getting this participant's report through the
              verification gate: casting a verdict on each of their observations. A participant
              needs {required} assignee{required === 1 ? '' : 's'}, which is the same number{' '}
              <Link to="/admin/settings">Settings</Link> uses for confirmations, because they are
              the same requirement seen from two sides.
            </>
          ) : (
            <>
              An observation assignment means you watch this participant during the workshop and
              capture on them. It is workshop-wide rather than per event: what matters is that
              nobody goes unwatched, not that every session is covered by a rota.
            </>
          )}
        </p>

        {evaluators.length === 0 ? (
          <p className="small muted">
            Nobody in this workshop can hold an assignment yet. People are added to a workshop in
            the backend; the app can read the roster but has no permission to change it.
          </p>
        ) : (
          <div className="row">
            <button disabled={busy} onClick={propose}>
              Auto-assign
            </button>
            <span className="small muted">
              Proposes only. Ranks by who has already observed each participant most, respects every
              quota, and never takes an existing assignment away.
            </span>
          </div>
        )}

        {proposals !== null && proposals.length > 0 && (
          <>
            <div className="proposal">
              {proposals.map((p) => (
                <p className="small" key={`${p.participant_id}::${p.evaluator_email}`}>
                  <strong>{p.participant_name}</strong> → {p.evaluator_email}{' '}
                  <span className="n-badge">
                    {p.observedCount > 0
                      ? `${p.observedCount} observation${p.observedCount === 1 ? '' : 's'} already`
                      : 'no history; balancing load'}
                  </span>
                </p>
              ))}
            </div>
            <div className="row">
              <button disabled={busy} onClick={() => void applyAll()}>
                Make these {proposals.length} assignment{proposals.length === 1 ? '' : 's'}
              </button>
              <button className="ghost" disabled={busy} onClick={() => setProposals(null)}>
                Discard
              </button>
            </div>
          </>
        )}

        {msg && <p className="small muted">{msg}</p>}
      </div>

      <div className="kanban">
        {columns.map((col) => (
          <Column
            key={col.evaluator?.email ?? '__none'}
            col={col}
            kind={kind}
            evaluators={evaluators}
            onAssign={(pid, email) => void assign(workshopId, pid, email, kind, { addedBy: by })}
            onTransfer={(pid, from, to) =>
              void transfer(workshopId, pid, from, to, kind, by)
            }
            onRemove={(pid, email) => void unassign(workshopId, pid, email, kind)}
          />
        ))}
      </div>
    </>
  )
}

function Column({
  col,
  kind,
  evaluators,
  onAssign,
  onTransfer,
  onRemove,
}: {
  col: BoardColumn
  kind: AssignmentKind
  evaluators: EvaluatorRef[]
  onAssign: (participantId: string, email: string) => void
  onTransfer: (participantId: string, from: string, to: string) => void
  onRemove: (participantId: string, email: string) => void
}) {
  const mine = col.evaluator
  const classes = [
    'kanban__col',
    mine ? '' : 'kanban__col--none',
    col.atCapacity ? 'kanban__col--full' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={classes} aria-label={mine ? mine.name : 'Unassigned'}>
      <header className="kanban__head">
        <span className="kanban__who">{mine ? mine.name : 'Unassigned'}</span>
        <span className={`n-badge${col.atCapacity ? ' n-badge--low' : ''}`}>
          {mine
            ? col.quota === null
              ? `${col.load} assigned · no limit`
              : `${col.load} of ${col.quota}${col.atCapacity ? ' · full' : ''}`
            : `${col.cards.length} with nobody`}
        </span>
      </header>

      {col.cards.length === 0 ? (
        <p className="small muted">{mine ? 'Nothing assigned.' : 'Everybody has someone.'}</p>
      ) : (
        col.cards.map((card) => (
          <Card
            key={card.participant_id}
            card={card}
            kind={kind}
            mine={mine}
            evaluators={evaluators}
            onAssign={onAssign}
            onTransfer={onTransfer}
            onRemove={onRemove}
          />
        ))
      )}
    </section>
  )
}

function Card({
  card,
  kind,
  mine,
  evaluators,
  onAssign,
  onTransfer,
  onRemove,
}: {
  card: BoardCard
  kind: AssignmentKind
  mine: EvaluatorRef | null
  evaluators: EvaluatorRef[]
  onAssign: (participantId: string, email: string) => void
  onTransfer: (participantId: string, from: string, to: string) => void
  onRemove: (participantId: string, email: string) => void
}) {
  const modifier =
    card.coverage === 'unassigned'
      ? ' kanban__card--unassigned'
      : card.coverage === 'under'
        ? ' kanban__card--under'
        : card.coverage === 'over'
          ? ' kanban__card--over'
          : ''

  // Somebody already on this participant is not a destination: moving them to a
  // person who already has them would silently delete the assignment instead.
  const elsewhere = evaluators.filter((e) => !card.assignees.includes(e.email))

  return (
    <article className={`kanban__card${modifier}`}>
      <Link className="kanban__name" to={`/admin/participants/${card.participant_id}`}>
        {card.participant_name}
      </Link>

      <span className="n-badge">
        {card.assignees.length} assignee{card.assignees.length === 1 ? '' : 's'}
        {card.progress && ` · ${card.progress.done}/${card.progress.total} reviewed`}
      </span>

      {mine ? (
        <>
          <select
            className="cell-select"
            value=""
            aria-label={`Move ${card.participant_name} to another evaluator`}
            onChange={(e) => {
              if (e.target.value) onTransfer(card.participant_id, mine.email, e.target.value)
            }}
          >
            <option value="">Move to…</option>
            {elsewhere.map((e) => (
              <option key={e.email} value={e.email}>
                {e.name}
              </option>
            ))}
          </select>
          <ConfirmAction
            className="danger-quiet small"
            label="Remove"
            confirmLabel={`Take ${card.participant_name} off ${mine.name}`}
            onConfirm={() => onRemove(card.participant_id, mine.email)}
          />
        </>
      ) : (
        <select
          className="cell-select"
          value=""
          aria-label={`Assign ${card.participant_name} to an evaluator`}
          onChange={(e) => {
            if (e.target.value) onAssign(card.participant_id, e.target.value)
          }}
        >
          <option value="">
            {kind === 'review' ? 'Assign a reviewer…' : 'Assign a watcher…'}
          </option>
          {elsewhere.map((e) => (
            <option key={e.email} value={e.email}>
              {e.name}
            </option>
          ))}
        </select>
      )}
    </article>
  )
}
