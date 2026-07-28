import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { useScopedWorkshopId } from '../../layout/roles'
import { useAnalyticsBundle } from '../../hooks/useAnalyticsBundle'
import { assigneesByParticipant, coverageOf, type Coverage } from '../../lib/assignment'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import { PageHeader } from '../../layout/PageHeader'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { StatTile } from '../../components/data/StatTile'
import { EmptyState } from '../../components/data/EmptyState'
import type { DraftDoc, RecipientStatus } from '../../drafts/types'
import type { ReportAssignment } from '../../lib/types'

/**
 * Where everything stands, one row per participant.
 *
 * Joshua's ask was "a way that the admin can view the progress on everything",
 * and the honest reading of "everything" is the whole chain: evidence gathered,
 * evidence verified, somebody responsible for it, a document written, a document
 * sent. Each of those already had a page; none of them had a row that put all
 * five side by side for one person, which is the thing you actually need at 9pm.
 *
 * Nothing here is computed fresh. Every column reads a value the app already
 * derives elsewhere, so this page cannot disagree with the page it links to.
 *
 * The send column deliberately shows `awaiting confirmation` in its own words
 * rather than rounding it up to sent. The mailto transport genuinely cannot know
 * whether a message left the machine, and that state exists so the audit trail
 * never claims otherwise.
 */

interface Row {
  participant_id: string
  participant_name: string
  team: string | null
  observations: number
  verified: number
  pending: number
  disputed: number
  gateReady: boolean
  assignees: string[]
  coverage: Coverage
  draft: DraftDoc | null
  send: SendState
}

type SendState =
  | { kind: 'none' }
  | { kind: 'not-approved' }
  | { kind: 'no-address' }
  | { kind: 'progress'; sent: number; awaiting: number; failed: number; total: number }

/** What the per-recipient rows on a draft add up to. */
function sendStateOf(draft: DraftDoc | null): SendState {
  if (!draft) return { kind: 'none' }
  if (draft.recipients.length === 0 || draft.recipients.every((r) => !r.email.trim())) {
    return { kind: 'no-address' }
  }
  if (draft.status === 'draft') return { kind: 'not-approved' }
  const count = (s: RecipientStatus) => draft.recipients.filter((r) => r.status === s).length
  return {
    kind: 'progress',
    sent: count('sent'),
    awaiting: count('awaiting_confirmation'),
    failed: count('failed'),
    total: draft.recipients.length,
  }
}

function SendCell({ state }: { state: SendState }) {
  switch (state.kind) {
    case 'none':
      return <span className="muted">no document</span>
    case 'no-address':
      return (
        <span className="pill error" title="Add it on the roster">
          no address
        </span>
      )
    case 'not-approved':
      return <span className="muted">not approved</span>
    case 'progress': {
      const { sent, awaiting, failed, total } = state
      if (failed > 0) return <span className="pill error">{failed} failed</span>
      if (awaiting > 0) {
        return (
          <span
            className="pill queued"
            title="The mail app was opened but nobody has confirmed the message was actually sent. Confirm it on the document."
          >
            awaiting confirmation
          </span>
        )
      }
      if (sent === total) return <span className="pill ok">sent</span>
      return (
        <span className="n-badge">
          {sent} of {total} sent
        </span>
      )
    }
  }
}

export function Progress() {
  const workshopId = useScopedWorkshopId()
  const bundle = useAnalyticsBundle()

  const assignments = useLiveQuery(
    () =>
      workshopId
        ? db.assignments.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as ReportAssignment[]),
    [workshopId],
    [] as ReportAssignment[],
  )
  const drafts = useLiveQuery(() => db.docDrafts.toArray(), [], [] as DraftDoc[])
  const settings = useLiveQuery(
    async () =>
      workshopId
        ? resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray())
        : SETTINGS_DEFAULTS,
    [workshopId],
    SETTINGS_DEFAULTS,
  )

  const required = settings.requiredConfirmations

  const rows = useMemo<Row[]>(() => {
    const byParticipant = assigneesByParticipant(assignments ?? [], 'review')

    // The newest live participant email per person. Superseded revisions are
    // excluded: they are the audit trail of what was replaced, not the thing
    // anybody is waiting on.
    const latest = new Map<string, DraftDoc>()
    for (const d of drafts ?? []) {
      if (d.kind !== 'participant_email' || d.status === 'superseded') continue
      const cur = latest.get(d.subjectKey)
      if (!cur || d.revision > cur.revision || (d.revision === cur.revision && d.updatedAt > cur.updatedAt)) {
        latest.set(d.subjectKey, d)
      }
    }

    return bundle.participants.map((p) => {
      const gate = bundle.gates.get(p.id)
      const assignees = byParticipant.get(p.id) ?? []
      const draft = latest.get(p.id) ?? null
      const team = bundle.teams.find((t) => t.id === p.team_id)?.name ?? null
      return {
        participant_id: p.id,
        participant_name: p.name,
        team,
        observations: gate?.total ?? 0,
        verified: gate?.verified ?? 0,
        pending: gate?.pending ?? 0,
        disputed: gate?.disputed ?? 0,
        gateReady: gate?.status === 'ready',
        assignees,
        coverage: coverageOf(assignees.length, required),
        draft,
        send: sendStateOf(draft),
      }
    })
  }, [bundle.participants, bundle.gates, bundle.teams, assignments, drafts, required])

  const ready = rows.filter((r) => r.gateReady).length
  const short = rows.filter((r) => r.coverage === 'unassigned' || r.coverage === 'under').length
  const unapproved = rows.filter((r) => r.draft?.status === 'draft').length
  const notConfirmed = rows.filter(
    (r) => r.send.kind === 'progress' && (r.send.awaiting > 0 || r.send.failed > 0),
  ).length

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'participant',
      sticky: true,
      sortValue: (r) => r.participant_name,
      render: (r) => (
        <>
          <strong>{r.participant_name}</strong>
          {r.team && <div className="small muted">{r.team}</div>}
        </>
      ),
    },
    {
      key: 'obs',
      header: 'evidence',
      numeric: true,
      sortValue: (r) => r.observations,
      render: (r) =>
        r.observations === 0 ? <span className="muted">none yet</span> : r.observations,
    },
    {
      key: 'gate',
      header: 'verification',
      sortValue: (r) => (r.disputed > 0 ? 0 : r.gateReady ? 2 : 1),
      render: (r) => {
        if (r.observations === 0) return <span className="muted">—</span>
        if (r.disputed > 0) return <span className="pill error">{r.disputed} disputed</span>
        if (r.pending > 0) return <span className="pill queued">{r.pending} to confirm</span>
        return <span className="pill ok">ready</span>
      },
    },
    {
      key: 'assignees',
      header: <span title="Evaluators responsible for getting this report through the gate">reviewers</span>,
      numeric: true,
      sortValue: (r) => r.assignees.length,
      render: (r) => (
        <span
          className={`n-badge${r.coverage === 'unassigned' || r.coverage === 'under' ? ' n-badge--low' : ''}`}
          title={r.assignees.join(', ') || 'nobody assigned'}
        >
          {r.assignees.length} of {required}
        </span>
      ),
    },
    {
      key: 'draft',
      header: 'document',
      sortValue: (r) => r.draft?.status ?? '',
      render: (r) =>
        r.draft ? (
          <Link to={`/outgoing/${encodeURIComponent(r.draft.id)}`}>
            {r.draft.status}
            {r.draft.revision > 1 && <span className="small muted"> · rev {r.draft.revision}</span>}
          </Link>
        ) : (
          <span className="muted">not generated</span>
        ),
    },
    {
      key: 'send',
      header: 'email',
      sortValue: (r) => r.send.kind,
      render: (r) => <SendCell state={r.send} />,
    },
  ]

  if (!workshopId) {
    return (
      <>
        <PageHeader title="Progress" crumbs={[{ label: 'Dashboard' }, { label: 'Progress' }]} />
        <EmptyState title="No workshop selected">
          Choose a scenario in the <Link to="/builder">Scenario Builder</Link> first.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Progress"
        crumbs={[{ label: 'Dashboard' }, { label: 'Progress' }]}
        meta={`${rows.length} participant(s)`}
        actions={<Link to="/outgoing">Outgoing →</Link>}
      />

      <div className="grid grid--tiles" style={{ marginBottom: 'var(--s-4)' }}>
        <StatTile label="Reports ready" value={ready} sub={`of ${rows.length} on the roster`} to="/reports" />
        <StatTile
          label="Need another reviewer"
          value={short}
          sub={`fewer than ${required} assigned`}
          to="/admin/assignments"
          attention={short > 0}
        />
        <StatTile
          label="Documents unapproved"
          value={unapproved}
          sub="written but nobody has signed off"
          to="/outgoing"
          attention={unapproved > 0}
        />
        <StatTile
          label="Sends unconfirmed"
          value={notConfirmed}
          sub="opened in mail, or failed"
          to="/outgoing"
          attention={notConfirmed > 0}
        />
      </div>

      <div className="card">
        <h2>Every participant, end to end</h2>
        <p className="small muted">
          Evidence gathered, evidence verified, somebody responsible, a document written, the
          document sent. Each column links to the page that owns it.
        </p>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.participant_id}
          defaultSort="gate"
          defaultDir="asc"
          empty={<EmptyState title="Nobody on the roster yet" />}
        />
        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          <strong>awaiting confirmation</strong> means the mail app was opened with the message
          ready and nobody has since said it went. The app cannot see your outbox, so it will not
          claim a send it has no evidence for. Confirm it on the document itself.
        </p>
      </div>
    </>
  )
}
