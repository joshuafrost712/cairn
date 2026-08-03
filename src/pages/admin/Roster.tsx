import { lazy, Suspense, useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import {
  addParticipant,
  addTeam,
  deleteParticipant,
  deleteTeam,
  updateParticipant,
  updateTeam,
} from '../../db/admin'
import { PageHeader } from '../../layout/PageHeader'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { EmptyState } from '../../components/data/EmptyState'
import { useScopedWorkshopId } from '../../layout/roles'
import { countsForParticipant, countsForTeam } from '../../setup/counts'
import { diffFields } from '../../setup/impact'
import { useSetupSave } from '../../setup/useSetupSave'
import { formatBreakdown, membersOf, teamBreakdown } from '../../lib/teams'
import type { Participant, Team, Workshop } from '../../lib/types'

const RosterImport = lazy(() =>
  import('./RosterImport').then((m) => ({ default: m.RosterImport })),
)

/**
 * Workshop meta, teams, and the participant roster.
 *
 * Laid out as a split: the things you set once (workshop meta, teams) hold the
 * narrow column, and the roster, which is the reason you opened the page, gets
 * the width. Below 900px it stacks in that order.
 *
 * Three rules the earlier version of this page broke, all of them about the eye
 * finding the right thing:
 *
 *  1. THE PERSON IS THE LOUDEST THING IN THE ROW. Their name used to be a small
 *     text input, so a section heading outweighed every human being under it.
 *     It is now bold ink at body size, and the row clicks through to them.
 *  2. A CONTROL LOOKS LIKE WHAT IT DOES. Delete carries the danger ink before it
 *     is armed, and a menu takes the recessed surface, so "remove this person",
 *     "change their team", and "edit them" are three visibly different things
 *     rather than three grey rectangles.
 *  3. EDITING IS DELIBERATE. Fields are no longer live in the table; you open a
 *     row to change it. That is what lets a row click mean "show me this person"
 *     without a click on a name landing in a text cursor instead.
 *
 * Since tl-07 this is the Participants SECTION of the Setup hub rather than a page of
 * its own, so it is rendered with `embedded` and the hub owns the page header. Two
 * other things changed with the move.
 *
 * The workshop-meta card is gone: it lives in Setup's Basics section now, and two
 * editors for one entity is exactly what that spec forbids.
 *
 * And every write goes through useSetupSave(), which classifies it and logs it. The
 * per-field edits and the team moves stay save-on-blur because the classifier calls
 * them safe; adding somebody and deleting somebody do not, and their confirmation is
 * now the impact dialog with real counts rather than prose written into this file.
 */
export function Roster({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { request, busy } = useSetupSave()
  const workshopId = useScopedWorkshopId()
  // The validated active workshop, not workshops[0]. Since tl-01 made roles
  // per-workshop, editing whichever workshop happened to sort first was a real bug
  // in a multi-workshop deployment: it would silently edit somebody else's roster.
  const workshop = useLiveQuery(
    () => (workshopId ? db.workshops.get(workshopId) : Promise.resolve(undefined)),
    [workshopId],
    undefined,
  ) as Workshop | undefined
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])

  const [newTeam, setNewTeam] = useState('')
  const [newName, setNewName] = useState('')
  const [openTeam, setOpenTeam] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  /** A participant edit. Safe fields only; the classifier enforces that. */
  const editParticipant = (p: Participant, patch: Partial<Participant>) =>
    request({
      change: {
        entity: 'participant',
        operation: 'update',
        entityId: p.id,
        label: p.name,
        fields: diffFields(p, { ...p, ...patch }),
      },
      commit: () => updateParticipant(p.id, patch),
    })

  const removeParticipant = async (p: Participant) => {
    const counts = await countsForParticipant(p.id)
    await request({
      change: { entity: 'participant', operation: 'delete', entityId: p.id, label: p.name, counts },
      commit: () => deleteParticipant(p.id),
    })
  }

  const createParticipant = (workshopId: string, name: string) =>
    request({
      // Mid-workshop this classifies affects_future: a new person changes who
      // evaluators are asked to watch from here on. In a draft workshop, which is
      // when a roster is usually typed in, it is safe and saves without a dialog.
      change: { entity: 'participant', operation: 'create', entityId: null, label: name },
      commit: async () => {
        await addParticipant(workshopId, { name })
      },
    })

  const createTeam = (workshopId: string, name: string) =>
    request({
      change: { entity: 'team', operation: 'create', entityId: null, label: name },
      commit: async () => {
        await addTeam(workshopId, name)
      },
    })

  const renameTeam = (t: Team, name: string) =>
    request({
      change: {
        entity: 'team',
        operation: 'update',
        entityId: t.id,
        label: t.name,
        fields: diffFields(t, { ...t, name }),
      },
      commit: () => updateTeam(t.id, { name }),
    })

  const removeTeam = async (t: Team) => {
    const counts = await countsForTeam(t.id)
    await request({
      change: { entity: 'team', operation: 'delete', entityId: t.id, label: t.name, counts },
      commit: () => deleteTeam(t.id),
    })
  }

  const myTeams = (teams ?? []).filter((t) => t.workshop_id === workshop?.id)
  const myParticipants = (participants ?? []).filter((p) => p.workshop_id === workshop?.id)
  const unassigned = membersOf(myParticipants, null)

  // How much evidence a delete would strand. Shown in the confirm, because
  // "delete Amos" and "delete Amos and detach his 14 observations" are
  // different decisions and only one of them is visible from the name alone.
  const obsCount = (participantId: string) =>
    (observations ?? []).filter((o) => o.participant_id === participantId).length

  // A control inside a clickable row must not also navigate. Every interactive
  // cell stops the row's click here rather than leaving each call site to
  // remember, because forgetting once means a delete confirm that changes page
  // out from under itself.
  const stop = (e: MouseEvent) => e.stopPropagation()

  const columns: Column<Participant>[] = [
    {
      key: 'name',
      header: 'participant',
      sticky: true,
      sortValue: (p) => p.name,
      render: (p) => (
        <>
          <strong style={{ fontSize: 'var(--t-0)' }}>{p.name}</strong>
          {!p.registered_email && (
            <>
              {' '}
              <span className="pill queued" title="No address, so no email can be sent">
                no address
              </span>
            </>
          )}
          {p.organization && (
            <div className="small muted">
              {p.organization}
              {p.years_of_service != null ? ` · ${p.years_of_service}y` : ''}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'team',
      header: 'team',
      sortValue: (p) => myTeams.find((t) => t.id === p.team_id)?.name ?? null,
      render: (p) => (
        <select
          className="cell-select"
          value={p.team_id ?? ''}
          aria-label={`Team for ${p.name}`}
          onClick={stop}
          onChange={(e) => void editParticipant(p, { team_id: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {myTeams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'obs',
      header: 'observations',
      numeric: true,
      sortValue: (p) => obsCount(p.id),
      render: (p) => obsCount(p.id),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <span className="row" onClick={stop}>
          <button
            className="btn--sm"
            aria-expanded={editing === p.id}
            onClick={() => setEditing(editing === p.id ? null : p.id)}
          >
            {editing === p.id ? 'done' : 'edit'}
          </button>
          {/* No arm-then-fire here any more: the impact dialog IS the confirmation,
              and it names the real counts rather than the prose this file used to
              carry. A destructive delete also demands the person's name typed back. */}
          <button
            className="btn--sm danger-quiet"
            disabled={busy}
            onClick={() => void removeParticipant(p)}
          >
            delete
          </button>
        </span>
      ),
    },
  ]

  /** The in-place edit panel: everything about the person that is not evidence. */
  const editPanel = (p: Participant) => (
    <div className="stack-tight">
      <div className="row row--top">
        <span>
          <label htmlFor={`n-${p.id}`} className="small muted">
            Name
          </label>
          <input
            id={`n-${p.id}`}
            className="input--cell"
            defaultValue={p.name}
            onBlur={(e) => void editParticipant(p, { name: e.target.value })}
          />
        </span>
        <span>
          <label htmlFor={`e-${p.id}`} className="small muted">
            Email
          </label>
          <input
            id={`e-${p.id}`}
            className="input--cell"
            type="email"
            placeholder="none"
            defaultValue={p.registered_email ?? ''}
            onBlur={(e) => void editParticipant(p, { registered_email: e.target.value || null })}
          />
        </span>
      </div>
      <div className="row row--top">
        <span>
          <label htmlFor={`s-${p.id}`} className="small muted">
            Sex
          </label>
          <select
            id={`s-${p.id}`}
            className="cell-select"
            value={p.sex ?? ''}
            onChange={(e) =>
              void editParticipant(p, { sex: (e.target.value || null) as 'male' | 'female' | null })
            }
          >
            <option value="">Unrecorded</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </span>
        <span>
          <label htmlFor={`o-${p.id}`} className="small muted">
            Organization
          </label>
          <input
            id={`o-${p.id}`}
            className="input--cell"
            placeholder="e.g. SIL Indonesia"
            defaultValue={p.organization ?? ''}
            onBlur={(e) => void editParticipant(p, { organization: e.target.value || null })}
          />
        </span>
        <span>
          <label htmlFor={`y-${p.id}`} className="small muted">
            Years of service
          </label>
          <input
            id={`y-${p.id}`}
            className="input--cell"
            type="number"
            min={0}
            max={80}
            style={{ width: '6rem' }}
            defaultValue={p.years_of_service ?? ''}
            onBlur={(e) =>
              void editParticipant(p, {
                years_of_service: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </span>
      </div>
      <p className="small muted">
        Fields save when you click away. Renaming is safe: everything downstream keys on the
        participant id, not the name.
      </p>
    </div>
  )

  return (
    <>
      {!embedded && (
        <PageHeader
          title="Roster"
          crumbs={[{ label: 'Configure' }, { label: 'Roster' }]}
          meta={
            workshop
              ? `${myParticipants.length} participants · ${myTeams.length} teams · ${unassigned.length} unassigned`
              : undefined
          }
        />
      )}
      {embedded && workshop && (
        <p className="small muted">
          {myParticipants.length} participants · {myTeams.length} teams · {unassigned.length}{' '}
          unassigned
        </p>
      )}

      {!workshop ? (
        <div className="banner warn">
          No workshop selected. Choose or create one in{' '}
          <Link to="/admin/setup/basics">Workshop basics</Link>.
        </div>
      ) : (
        <div className="grid grid--split">
          <div>
            <div className="card">
              <h2>Teams</h2>
              <p className="small muted">
                Open a team to see who is on it and to move people in or out. The same assignment
                can be made from the team menu on any roster row; both write the same field.
              </p>

              {myTeams.length === 0 && (
                <p className="small muted">No teams yet. Participants can stay unassigned.</p>
              )}

              {myTeams.map((t) => {
                const members = membersOf(myParticipants, t.id)
                const breakdown = teamBreakdown(members)
                const open = openTeam === t.id
                return (
                  <div className={`team${open ? ' team--open' : ''}`} key={t.id}>
                    <button
                      className="team__summary"
                      aria-expanded={open}
                      onClick={() => setOpenTeam(open ? null : t.id)}
                    >
                      <span className="row">
                        <span className="team__name">{t.name}</span>
                        <span className="spacer" />
                        <span className="n-badge">
                          {breakdown.total} {breakdown.total === 1 ? 'member' : 'members'}
                        </span>
                        <span aria-hidden="true" className="muted small">
                          {open ? '▾' : '▸'}
                        </span>
                      </span>
                      <span className="small muted">{formatBreakdown(breakdown)}</span>
                    </button>

                    {open && (
                      <div className="team__body stack-tight">
                        <label htmlFor={`t-${t.id}`} className="small muted">
                          Team name
                        </label>
                        <input
                          id={`t-${t.id}`}
                          className="input--cell"
                          defaultValue={t.name}
                          onBlur={(e) => void renameTeam(t, e.target.value)}
                        />

                        {members.length === 0 ? (
                          <p className="small muted">Nobody on this team yet.</p>
                        ) : (
                          <div className="row">
                            {members.map((m) => (
                              <span className="member-chip" key={m.id}>
                                {m.name}
                                <button
                                  aria-label={`Remove ${m.name} from ${t.name}`}
                                  title={`Remove ${m.name} from ${t.name}`}
                                  disabled={busy}
                                  onClick={() => void editParticipant(m, { team_id: null })}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        <select
                          className="cell-select"
                          aria-label={`Add a member to ${t.name}`}
                          value=""
                          disabled={busy || unassigned.length === 0}
                          onChange={(e) => {
                            const id = e.target.value
                            const person = myParticipants.find((p) => p.id === id)
                            if (person) void editParticipant(person, { team_id: t.id })
                          }}
                        >
                          <option value="">
                            {unassigned.length === 0
                              ? 'everyone is on a team'
                              : `add a member (${unassigned.length} unassigned)…`}
                          </option>
                          {unassigned.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>

                        <button
                          className="btn--sm danger-quiet"
                          disabled={busy}
                          onClick={() => void removeTeam(t)}
                        >
                          delete team
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}

              <div className="row" style={{ marginTop: 'var(--s-3)' }}>
                <input
                  className="input--cell"
                  placeholder="New team name"
                  aria-label="New team name"
                  value={newTeam}
                  onChange={(e) => setNewTeam(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  disabled={busy || !newTeam.trim()}
                  onClick={() => {
                    const name = newTeam.trim()
                    setNewTeam('')
                    void createTeam(workshop.id, name)
                  }}
                >
                  Add team
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Participants</h2>
            <p className="small muted">
              Click a row to open that person's record: their evidence, their questions, and the
              state of their report. Use <strong>edit</strong> to change their details here.
            </p>
            <DataTable
              rows={myParticipants}
              columns={columns}
              rowKey={(p) => p.id}
              defaultSort="name"
              defaultDir="asc"
              onRowClick={(p) => navigate(`/admin/participants/${p.id}`)}
              expandedKey={editing}
              renderDetail={editPanel}
              empty={<EmptyState title="No participants yet">Add the first one below.</EmptyState>}
            />
            <div className="row" style={{ marginTop: 'var(--s-3)' }}>
              <input
                placeholder="New participant name"
                aria-label="New participant name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={{ flex: 1, margin: 0, maxWidth: '20rem' }}
              />
              <button
                disabled={busy || !newName.trim()}
                onClick={() => {
                  const name = newName.trim()
                  setNewName('')
                  void createParticipant(workshop.id, name)
                }}
              >
                Add participant
              </button>
            </div>
          </div>
        </div>
      )}

      {/* tl-10. Below the roster rather than beside it: importing is something you
          do to the list you are looking at, and it is the second thing you reach
          for, after seeing that the list is empty or wrong.

          Lazy, and measured rather than assumed: eagerly imported it put 24.4 kB
          (7.0 kB gzipped) of parser, planner and preview into the shell every
          evaluator downloads, to serve a control only an administrator can reach.
          The spreadsheet reader is a second, nested split inside it. */}
      {workshop && (
        <Suspense fallback={null}>
          <RosterImport workshopId={workshop.id} />
        </Suspense>
      )}
    </>
  )
}
