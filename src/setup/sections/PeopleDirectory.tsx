import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { ConfirmAction } from '../../components/data/ConfirmAction'
import { DataTable, type Column } from '../../components/data/DataTable'
import { cachedDirectory, refreshDirectory } from '../../db/directory'
import {
  inviteToWorkshop,
  listInvitations,
  removeWorkshopMember,
  resendInvitation,
  revokeInvitation,
  setSignupBudgetPerHour,
  setWorkshopMemberRole,
  signupBudgetPerHour,
  transferChiefAdmin,
  type MembershipResult,
} from '../../db/membership'
import { describeWindow } from '../../lib/admission'
import { c, findChromeNode } from '../../lib/content/chrome'
import { canRemove, canTransferChiefAdmin, grantableRoles } from '../../lib/permissions'
import { useIsPlatformOwner, useWorkshopRole } from '../../layout/roles'
import { countsForMembership } from '../counts'
import { useSetupSave } from '../useSetupSave'
import { ProfileButton } from '../../components/ProfileButton'
import type { Workshop, WorkshopInvitation, WorkshopPerson, WorkshopRole } from '../../lib/types'

/**
 * Who has access to this workshop, and the only screen that can change it (tl-11).
 *
 * Two lists that are one list on purpose. A membership and an invitation are
 * different rows in different tables with different permissions, and an
 * administrator the night before a workshop is asking one question — is everybody
 * who needs to be here, here? Showing pending invitations somewhere else is how
 * "I invited her, why can't she sign in" happens.
 *
 * Nothing on this page is a security boundary. Every action is re-decided by a
 * security-definer RPC from `auth.uid()`; `canGrant` here only decides which
 * controls are worth rendering. Where an action is withheld for a reason worth
 * stating, the reason is stated, because a control that silently is not there and
 * a control that is not permitted look identical to the person looking for it.
 */

/** Sorted by authority, then by name: the question is usually "who are the admins". */
const ROLE_ORDER: WorkshopRole[] = [
  'chief_admin',
  'admin',
  'chief_evaluator',
  'consultant',
  'evaluator',
  'participant',
]

type Row =
  | { kind: 'member'; key: string; person: WorkshopPerson }
  | { kind: 'invitation'; key: string; invitation: WorkshopInvitation }

const roleLabel = (role: WorkshopRole | string) => c(`people.role.${role.replace(/_/g, '-')}`)

const rowRole = (row: Row): WorkshopRole =>
  row.kind === 'member' ? row.person.role : row.invitation.role
const rowName = (row: Row): string =>
  row.kind === 'member' ? row.person.name : row.invitation.email

/**
 * A refusal, as a sentence.
 *
 * The slug in `detail` is preferred over the server's own message so the wording
 * is editable in chrome.json like everything else, but the server message is the
 * fallback rather than the id: `c()` returns the id for an unknown node, and
 * `people.refusal.tl11.bad_email` on screen is worse than plain Postgres prose.
 */
function refusalText(result: Exclude<MembershipResult, { ok: true }>): string {
  if (result.reason === 'offline') return c('people.refusal.offline')
  const id = result.slug ? `people.refusal.${result.slug}` : null
  if (id && findChromeNode(id)) return c(id)
  return result.message
}

export function PeopleDirectory({ workshop }: { workshop: Workshop }) {
  const workshopId = workshop.id
  const { request } = useSetupSave()
  const { identity } = useAuth()
  const actorRole = useWorkshopRole()
  const isPlatformOwner = useIsPlatformOwner()

  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [pendingMessage, setPendingMessage] = useState<WorkshopInvitation | null>(null)
  /** Bumped after every action, to re-ask the two questions this page shows. */
  const [refreshToken, setRefreshToken] = useState(0)

  /**
   * The roster reads the Dexie CACHE, not the network.
   *
   * `refreshDirectory` writes what it pulls into `workshopPeople`, so the live
   * query below is what re-renders when it lands, and the same query is what an
   * offline admin sees — the roster they last synced rather than an empty workshop.
   * Holding the fetched array in React state instead would have made a network
   * failure look like an empty workshop for exactly as long as the page was open.
   */
  const people = useLiveQuery(
    () => cachedDirectory(workshopId),
    [workshopId],
    [] as WorkshopPerson[],
  )

  /**
   * Invitations have no Dexie table on purpose (see `listInvitations`), so this is
   * a plain fetch keyed on `refreshToken`. The token is how an action re-asks; it
   * is not a timer, because a list of who has not joined yet does not change
   * underneath an administrator except by their own hand.
   */
  const invitations = useLiveQuery(
    () => listInvitations(workshopId),
    [workshopId, refreshToken],
    [] as WorkshopInvitation[],
  )

  const reload = useCallback(async () => {
    await refreshDirectory(workshopId)
    setRefreshToken((n) => n + 1)
  }, [workshopId])

  useEffect(() => {
    // No setState here: `refreshDirectory` writes to Dexie and the live query above
    // picks it up, which is the pattern the rest of this app already uses.
    void refreshDirectory(workshopId)
  }, [workshopId])

  const rows = useMemo<Row[]>(() => {
    const members: Row[] = (people ?? []).map((p) => ({ kind: 'member', key: `m:${p.pk}`, person: p }))
    const pending: Row[] = (invitations ?? [])
      .filter((i) => i.status === 'pending')
      .map((i) => ({ kind: 'invitation', key: `i:${i.id}`, invitation: i }))
    return [...members, ...pending].sort((a, b) => {
      const byRole = ROLE_ORDER.indexOf(rowRole(a)) - ROLE_ORDER.indexOf(rowRole(b))
      if (byRole !== 0) return byRole
      return rowName(a).localeCompare(rowName(b))
    })
  }, [people, invitations])

  /**
   * Run one membership call through the warning layer.
   *
   * The result is read INSIDE the commit rather than after `request()` resolves,
   * because a change that shows a dialog returns from `request()` immediately and
   * commits later, when the admin confirms. Reading it outside would report success
   * before anybody had agreed to anything.
   */
  const run = (
    change: Parameters<typeof request>[0]['change'],
    call: () => Promise<MembershipResult>,
    successId: string,
    tokens?: Record<string, string | number>,
  ) =>
    request({
      change,
      commit: async () => {
        const result = await call()
        if (result.ok) {
          setNotice({ tone: 'ok', text: c(successId, 'label', tokens) })
          await reload()
        } else {
          setNotice({ tone: 'error', text: refusalText(result) })
        }
      },
    })

  const changeRole = async (person: WorkshopPerson, role: WorkshopRole) => {
    const counts = await countsForMembership(workshopId, person.email, person.app_user_id)
    await run(
      {
        entity: 'membership',
        operation: 'update',
        entityId: person.app_user_id,
        label: person.name,
        fields: [{ field: 'role', before: person.role, after: role }],
        counts,
      },
      () => setWorkshopMemberRole(workshopId, person.app_user_id, role),
      'people.notice.role-changed',
      { name: person.name, role: roleLabel(role) },
    )
  }

  const remove = async (person: WorkshopPerson) => {
    const counts = await countsForMembership(workshopId, person.email, person.app_user_id)
    await run(
      {
        entity: 'membership',
        operation: 'delete',
        entityId: person.app_user_id,
        label: person.name,
        fields: [{ field: 'role', before: person.role, after: null }],
        counts,
      },
      () => removeWorkshopMember(workshopId, person.app_user_id),
      'people.notice.removed',
      { name: person.name },
    )
  }

  const transfer = async (person: WorkshopPerson) => {
    await run(
      {
        entity: 'membership',
        operation: 'update',
        entityId: person.app_user_id,
        label: person.name,
        fields: [{ field: 'role', before: person.role, after: 'chief_admin' }],
      },
      () => transferChiefAdmin(workshopId, person.app_user_id),
      'people.notice.transferred',
      { name: person.name },
    )
  }

  const columns: Column<Row>[] = [
    {
      key: 'person',
      header: c('people.column.person'),
      sortValue: rowName,
      sticky: true,
      render: (row) => (
        <span>
          <strong>{rowName(row)}</strong>
          {row.kind === 'member' && row.person.name !== row.person.email && (
            <span className="small muted"> · {row.person.email}</span>
          )}
          {/* tl-12. Members only: an invitation has an address and no person yet,
              which is the whole reason `workshop_invitation` is its own table. */}
          {row.kind === 'member' && (
            <>
              {' '}
              <ProfileButton
                email={row.person.email}
                name={row.person.name}
                workshopId={workshopId}
              />
            </>
          )}
        </span>
      ),
    },
    {
      key: 'role',
      header: c('people.column.role'),
      sortValue: (row) => ROLE_ORDER.indexOf(rowRole(row)),
      render: (row) => roleLabel(rowRole(row)),
    },
    {
      key: 'status',
      header: c('people.column.status'),
      sortValue: (row) => (row.kind === 'member' ? 0 : 1),
      render: (row) =>
        row.kind === 'member' ? (
          <span className="pill ok">{c('people.status.member')}</span>
        ) : (
          <PendingStatus invitation={row.invitation} />
        ),
    },
    {
      key: 'actions',
      header: c('people.column.actions'),
      render: (row) =>
        row.kind === 'member' ? (
          <MemberActions
            person={row.person}
            actorRole={actorRole}
            isSelf={row.person.app_user_id === identity?.appUserId}
            isPlatformOwner={isPlatformOwner}
            onRole={changeRole}
            onRemove={remove}
            onTransfer={transfer}
          />
        ) : (
          <InvitationActions
            invitation={row.invitation}
            actorRole={actorRole}
            onShowMessage={() => setPendingMessage(row.invitation)}
            onResend={async () => {
              const result = await resendInvitation(row.invitation.id)
              setNotice(
                result.ok
                  ? { tone: 'ok', text: c('people.notice.resent') }
                  : { tone: 'error', text: refusalText(result) },
              )
              if (result.ok) await reload()
            }}
            onRevoke={() =>
              run(
                {
                  entity: 'invitation',
                  operation: 'delete',
                  entityId: row.invitation.id,
                  label: row.invitation.email,
                },
                () => revokeInvitation(row.invitation.id),
                'people.notice.revoked',
                { email: row.invitation.email },
              )
            }
          />
        ),
    },
  ]

  return (
    <>
      <div className="card form-col">
        <h2>{c('people.title')}</h2>
        <p className="small muted">{c('people.help')}</p>
        <p className="small muted">{c('people.not-participants')}</p>

        {notice && (
          <div className={`banner ${notice.tone === 'ok' ? 'ok' : 'warn'}`}>{notice.text}</div>
        )}

        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(row) => row.key}
          caption={c('people.table-caption')}
          empty={c('people.empty')}
        />
      </div>

      <InviteCard
        workshop={workshop}
        actorRole={actorRole}
        onInvited={async (invitation, outcome) => {
          setNotice({
            tone: 'ok',
            text: c(
              outcome === 'added' ? 'people.notice.added-directly' : 'people.notice.invited',
              'label',
              { email: invitation },
            ),
          })
          await reload()
          if (outcome === 'invited') {
            const fresh = await listInvitations(workshopId)
            setPendingMessage(
              fresh.find((i) => i.email === invitation && i.status === 'pending') ?? null,
            )
          }
        }}
        onRefused={(text) => setNotice({ tone: 'error', text })}
        request={request}
      />

      <BudgetCard />

      {pendingMessage && (
        <InvitationMessage
          workshop={workshop}
          invitation={pendingMessage}
          onClose={() => setPendingMessage(null)}
        />
      )}
    </>
  )
}

/**
 * The actions one administrator may take on one person.
 *
 * Withheld actions are not rendered disabled. A greyed-out "Promote to admin" with
 * no explanation is a worse answer than no button plus one line saying an admin
 * cannot act on another admin, which is the case Joshua will hit most.
 */
function MemberActions({
  person,
  actorRole,
  isSelf,
  isPlatformOwner,
  onRole,
  onRemove,
  onTransfer,
}: {
  person: WorkshopPerson
  actorRole: WorkshopRole | null
  isSelf: boolean
  isPlatformOwner: boolean
  onRole: (person: WorkshopPerson, role: WorkshopRole) => void | Promise<void>
  onRemove: (person: WorkshopPerson) => void | Promise<void>
  onTransfer: (person: WorkshopPerson) => void | Promise<void>
}) {
  // Self-action is decided by identity, not by role: the server refuses a caller
  // changing their own rank whatever they hold.
  const offerable = isSelf ? [] : grantableRoles(actorRole, person.role).filter((r) => r !== person.role)
  const mayRemove = !isSelf && canRemove(actorRole, person.role)
  const mayTransfer =
    !isSelf && person.role !== 'chief_admin' && canTransferChiefAdmin(actorRole, isPlatformOwner)

  if (offerable.length === 0 && !mayRemove && !mayTransfer) {
    return (
      <span className="small muted">
        {isSelf
          ? c('people.action.none-self')
          : person.role === 'chief_admin'
            ? c('people.action.none-chief')
            : c('people.action.none')}
      </span>
    )
  }

  return (
    <span className="row" style={{ gap: 'var(--s-1)', flexWrap: 'wrap' }}>
      {offerable.length > 0 && (
        <select
          value=""
          aria-label={`Change role for ${person.name}`}
          onChange={(e) => {
            const role = e.target.value as WorkshopRole
            e.target.value = ''
            if (role) void onRole(person, role)
          }}
          style={{ margin: 0 }}
        >
          <option value="">{c('people.action.change-role')}</option>
          {offerable.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      )}
      {mayTransfer && (
        <ConfirmAction
          label={c('people.action.transfer')}
          confirmLabel={c('people.action.transfer-confirm', 'label', { name: person.name })}
          // Typing the recipient's name, per the spec: this is the one action the
          // person taking it cannot undo on their own, so it must be impossible to
          // perform by clicking.
          phrase={person.name}
          warning={c('people.action.transfer-warning', 'label', { name: person.name })}
          onConfirm={() => onTransfer(person)}
        />
      )}
      {mayRemove && (
        <ConfirmAction
          label={c('people.action.remove')}
          confirmLabel={c('people.action.remove-confirm', 'label', { name: person.name })}
          onConfirm={() => onRemove(person)}
        />
      )}
    </span>
  )
}

function InvitationActions({
  invitation,
  actorRole,
  onShowMessage,
  onResend,
  onRevoke,
}: {
  invitation: WorkshopInvitation
  actorRole: WorkshopRole | null
  onShowMessage: () => void
  onResend: () => void | Promise<void>
  onRevoke: () => void | Promise<void>
}) {
  // "Could you have issued this invitation" is the same question as "may you
  // withdraw it", asked of a target who is not a member — which is what a pending
  // invitee is.
  const mayAct = grantableRoles(actorRole, null).includes(invitation.role)
  return (
    <span className="row" style={{ gap: 'var(--s-1)', flexWrap: 'wrap' }}>
      <button className="ghost small" onClick={onShowMessage}>
        {c('people.action.message')}
      </button>
      {mayAct && (
        <>
          <button className="ghost small" onClick={() => void onResend()}>
            {c('people.action.resend')}
          </button>
          <ConfirmAction
            label={c('people.action.revoke')}
            confirmLabel={c('people.action.revoke-confirm')}
            onConfirm={onRevoke}
          />
        </>
      )}
    </span>
  )
}

function InviteCard({
  workshop,
  actorRole,
  onInvited,
  onRefused,
  request,
}: {
  workshop: Workshop
  actorRole: WorkshopRole | null
  onInvited: (email: string, outcome: 'invited' | 'added') => void | Promise<void>
  onRefused: (text: string) => void
  request: ReturnType<typeof useSetupSave>['request']
}) {
  const offerable = grantableRoles(actorRole, null)
  // Evaluator by default where it is offered, not the first grantable role. The
  // matrix lists `admin` first, so the obvious default handed a chief admin a form
  // pre-set to give away administration — one distracted click from the change this
  // whole spec is careful about. Nearly every invitation is an evaluator.
  const [role, setRole] = useState<WorkshopRole>(
    offerable.includes('evaluator') ? 'evaluator' : (offerable[0] ?? 'evaluator'),
  )
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  if (offerable.length === 0) {
    return (
      <div className="card">
        <h2>{c('people.invite.title')}</h2>
        <p className="small muted">{c('people.invite.not-permitted')}</p>
      </div>
    )
  }

  const submit = async () => {
    const address = email.trim()
    if (!address) return
    setBusy(true)
    try {
      await request({
        change: {
          entity: 'invitation',
          operation: 'create',
          entityId: null,
          label: address,
          fields: [{ field: 'role', after: role }],
        },
        commit: async () => {
          const result = await inviteToWorkshop(
            workshop.id,
            address,
            role as Exclude<WorkshopRole, 'chief_admin'>,
          )
          if (!result.ok) {
            onRefused(refusalText(result))
            return
          }
          setEmail('')
          await onInvited(address.toLowerCase(), result.outcome)
        },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form-col">
      <h2>{c('people.invite.title')}</h2>
      <p className="small muted">{c('people.invite.help')}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input
          type="email"
          value={email}
          aria-label={c('people.invite.email-label')}
          placeholder={c('people.invite.email-placeholder')}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, minWidth: '14rem', margin: 0 }}
        />
        <select
          value={role}
          aria-label={c('people.invite.role-label')}
          onChange={(e) => setRole(e.target.value as WorkshopRole)}
          style={{ margin: 0 }}
        >
          {offerable.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <button disabled={busy || !email.trim()} onClick={() => void submit()}>
          {c('people.invite.submit')}
        </button>
      </div>
      <p className="small muted">{c('people.invite.no-email-sent')}</p>
      {offerable.includes('participant') && (
        <p className="small muted">{c('people.invite.participant-note')}</p>
      )}
    </div>
  )
}

/**
 * The message an administrator sends themselves.
 *
 * There is no outbound mail service and this panel must not pretend otherwise, so
 * it says plainly that nothing has been sent and hands over the text and a
 * `mailto:` link. Naming that limit is cheaper than the support conversation that
 * follows from an invitation that silently never arrived.
 */
function InvitationMessage({
  workshop,
  invitation,
  onClose,
}: {
  workshop: Workshop
  invitation: WorkshopInvitation
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const described = describeWindow(invitation.opens_at, new Date())
  const tokens = {
    email: invitation.email,
    workshop: workshop.name,
    role: roleLabel(invitation.role),
    url: window.location.origin + import.meta.env.BASE_URL,
  }
  const subject = c('people.message.subject', 'label', tokens)
  // The window is a separate paragraph rather than a token inside the body,
  // because an invitation that opens immediately must not carry a sentence about
  // waiting — and a token that resolves to an empty string leaves the punctuation
  // around it stranded.
  const body = described.open
    ? c('people.message.body', 'label', tokens)
    : `${c('people.message.body', 'label', tokens)}\n\n${c('people.message.window', 'label', {
        clock: described.clock,
      })}`

  return (
    <div className="card form-col">
      <h2>{c('people.message.title')}</h2>
      <p className="small muted">{c('people.message.help', 'label', tokens)}</p>
      <textarea readOnly value={body} rows={8} style={{ width: '100%' }} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(body).then(() => setCopied(true))
          }}
        >
          {copied ? c('people.message.copied') : c('people.message.copy')}
        </button>
        <a
          className="pill local"
          href={`mailto:${encodeURIComponent(invitation.email)}?subject=${encodeURIComponent(
            subject,
          )}&body=${encodeURIComponent(body)}`}
        >
          {c('people.message.mailto')}
        </a>
        <button className="ghost" onClick={onClose}>
          {c('people.message.close')}
        </button>
      </div>
    </div>
  )
}

/**
 * A pending row's status: invited when, and open when.
 *
 * The relative phrasing rather than the clock one, because this reader is scanning
 * a column of them and comparing. The person who has to wait gets the clock time,
 * in the message and at the sign-up form.
 */
function PendingStatus({ invitation }: { invitation: WorkshopInvitation }) {
  const described = describeWindow(invitation.opens_at, new Date())
  return (
    <span>
      <span className="pill queued">
        {c('people.status.invited', 'label', { date: invitation.invited_at.slice(0, 10) })}
      </span>
      {!described.open && (
        <span className="small muted">
          {' '}
          {c('people.status.opens', 'label', { clock: described.clock, relative: described.relative })}
        </span>
      )}
    </span>
  )
}

/**
 * How many accounts this deployment may create in an hour.
 *
 * Shown to every administrator and editable only by the platform owner, because
 * the cap is one number the whole deployment draws on: an admin of one workshop
 * raising it would be spending a budget every other workshop shares.
 *
 * It MIRRORS the project's auth `rate_limit_email_sent`; it does not set it. That
 * is stated on the card rather than left to be discovered, because raising this
 * without raising that schedules people into an hour the mailer will still refuse
 * — which would turn an honest wait into a wait followed by an error.
 */
function BudgetCard() {
  const isPlatformOwner = useIsPlatformOwner()
  const [budget, setBudget] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void signupBudgetPerHour().then((n) => {
      setBudget(n)
      setDraft(n === null ? '' : String(n))
    })
  }, [])

  if (budget === null) return null

  return (
    <div className="card form-col">
      <h2>{c('people.budget.title')}</h2>
      <p className="small muted">{c('people.budget.help', 'label', { budget })}</p>
      <p className="small muted">{c('people.budget.mirror-note')}</p>
      {isPlatformOwner && (
        <div className="row">
          <input
            type="number"
            min={1}
            value={draft}
            aria-label={c('people.budget.field')}
            onChange={(e) => setDraft(e.target.value)}
            style={{ width: '6rem', margin: 0 }}
          />
          <button
            disabled={!draft.trim() || Number(draft) === budget}
            onClick={async () => {
              const n = Number(draft)
              if (!Number.isFinite(n) || n < 1) return
              const result = await setSignupBudgetPerHour(n)
              if (result.ok) {
                setBudget(Math.floor(n))
                setNotice(c('people.budget.saved', 'label', { budget: Math.floor(n) }))
              } else {
                setNotice(refusalText(result))
              }
            }}
          >
            {c('people.budget.save')}
          </button>
        </div>
      )}
      {notice && <p className="small muted">{notice}</p>}
    </div>
  )
}
