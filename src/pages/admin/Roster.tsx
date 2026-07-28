import { useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import {
  addParticipant,
  addTeam,
  deleteParticipant,
  deleteTeam,
  updateParticipant,
  updateTeam,
  updateWorkshop,
} from '../../db/admin'
import { PageHeader } from '../../layout/PageHeader'
import { DataTable } from '../../components/data/DataTable'
import type { Column } from '../../components/data/DataTable'
import { ConfirmAction } from '../../components/data/ConfirmAction'
import { EmptyState } from '../../components/data/EmptyState'
import { formatBreakdown, membersOf, teamBreakdown } from '../../lib/teams'
import type { Participant, Team, Workshop } from '../../lib/types'

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
 * Deleting a participant still arms first, and still says how much evidence the
 * delete would strand.
 */
export function Roster() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])

  const workshop = (workshops ?? [])[0] ?? null
  const [newTeam, setNewTeam] = useState('')
  const [newName, setNewName] = useState('')
  const [openTeam, setOpenTeam] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
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
          onChange={(e) => updateParticipant(p.id, { team_id: e.target.value || null })}
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
          <ConfirmAction
            className="btn--sm danger-quiet"
            label="delete"
            confirmLabel={`Delete ${p.name}`}
            disabled={busy}
            warning={
              obsCount(p.id) > 0 ? (
                <>
                  {p.name} has <strong>{obsCount(p.id)}</strong> observation(s). Deleting the person
                  does not delete the evidence; those rows stay in the database attributed to a
                  participant who no longer exists, and will show as unattributed.
                </>
              ) : undefined
            }
            onConfirm={() => withBusy(() => deleteParticipant(p.id))}
          />
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
            onBlur={(e) => updateParticipant(p.id, { name: e.target.value })}
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
            onBlur={(e) => updateParticipant(p.id, { registered_email: e.target.value || null })}
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
              updateParticipant(p.id, { sex: (e.target.value || null) as 'male' | 'female' | null })
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
            onBlur={(e) => updateParticipant(p.id, { organization: e.target.value || null })}
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
              updateParticipant(p.id, {
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
      <PageHeader
        title="Roster"
        crumbs={[{ label: 'Configure' }, { label: 'Roster' }]}
        meta={
          workshop
            ? `${myParticipants.length} participants · ${myTeams.length} teams · ${unassigned.length} unassigned`
            : undefined
        }
      />

      {!workshop ? (
        <div className="banner warn">
          No workshop loaded. Load one from <a href="/admin/data">Data</a>, then edit it here.
        </div>
      ) : (
        <div className="grid grid--split">
          <div>
            <div className="card">
              <h2>Workshop</h2>
              <label htmlFor="wname">Name</label>
              <input
                id="wname"
                defaultValue={workshop.name ?? ''}
                onBlur={(e) => updateWorkshop(workshop.id, { name: e.target.value })}
              />
              <label htmlFor="wloc">Location</label>
              <input
                id="wloc"
                defaultValue={workshop.location ?? ''}
                onBlur={(e) => updateWorkshop(workshop.id, { location: e.target.value })}
              />
              <div className="row">
                <span>
                  <label htmlFor="wstart">Start</label>
                  <input
                    id="wstart"
                    type="date"
                    defaultValue={workshop.start_date ?? ''}
                    onBlur={(e) => updateWorkshop(workshop.id, { start_date: e.target.value })}
                  />
                </span>
                <span>
                  <label htmlFor="wend">End</label>
                  <input
                    id="wend"
                    type="date"
                    defaultValue={workshop.end_date ?? ''}
                    onBlur={(e) => updateWorkshop(workshop.id, { end_date: e.target.value })}
                  />
                </span>
              </div>
            </div>

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
                          onBlur={(e) => updateTeam(t.id, { name: e.target.value })}
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
                                  onClick={() =>
                                    withBusy(() => updateParticipant(m.id, { team_id: null }))
                                  }
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
                            if (id) void withBusy(() => updateParticipant(id, { team_id: t.id }))
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

                        <ConfirmAction
                          className="btn--sm danger-quiet"
                          label="delete team"
                          confirmLabel={`Delete ${t.name}`}
                          disabled={busy}
                          warning={
                            <>
                              Its {breakdown.total} member(s) become unassigned. Their evidence is
                              untouched.
                            </>
                          }
                          onConfirm={() => withBusy(() => deleteTeam(t.id))}
                        />
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
                  onClick={() =>
                    withBusy(async () => {
                      await addTeam(workshop.id, newTeam.trim())
                      setNewTeam('')
                    })
                  }
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
                onClick={() =>
                  withBusy(async () => {
                    await addParticipant(workshop.id, { name: newName.trim() })
                    setNewName('')
                  })
                }
              >
                Add participant
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
