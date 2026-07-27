import { useState } from 'react'
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
import type { Participant, Team, Workshop } from '../../lib/types'

/**
 * Workshop meta, teams, and the participant roster.
 *
 * Lifted verbatim out of the old single Admin page, with two changes. The
 * roster is a table rather than 28 stacked cards, because on a roster you are
 * always comparing a column (who has no email, who is unassigned) and a stack
 * makes that a scroll. And deleting a participant now arms first: it used to
 * fire on one click, next to an editable name field, with no undo and with
 * their observations left orphaned behind them.
 */
export function Roster() {
  const [busy, setBusy] = useState(false)
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])

  const workshop = (workshops ?? [])[0] ?? null
  const [newTeam, setNewTeam] = useState('')
  const [newName, setNewName] = useState('')

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

  // How much evidence a delete would strand. Shown in the confirm, because
  // "delete Amos" and "delete Amos and detach his 14 observations" are
  // different decisions and only one of them is visible from the name alone.
  const obsCount = (participantId: string) =>
    (observations ?? []).filter((o) => o.participant_id === participantId).length

  const columns: Column<Participant>[] = [
    {
      key: 'name',
      header: 'name',
      sticky: true,
      sortValue: (p) => p.name,
      render: (p) => (
        <input
          defaultValue={p.name}
          aria-label={`Name of ${p.name}`}
          onBlur={(e) => updateParticipant(p.id, { name: e.target.value })}
          style={{ margin: 0, minWidth: '10rem' }}
        />
      ),
    },
    {
      key: 'email',
      header: 'email',
      sortValue: (p) => p.registered_email ?? null,
      render: (p) => (
        <input
          type="email"
          defaultValue={p.registered_email ?? ''}
          placeholder="none"
          aria-label={`Email for ${p.name}`}
          onBlur={(e) => updateParticipant(p.id, { registered_email: e.target.value || null })}
          style={{ margin: 0, minWidth: '12rem' }}
        />
      ),
    },
    {
      key: 'team',
      header: 'team',
      sortValue: (p) => myTeams.find((t) => t.id === p.team_id)?.name ?? null,
      render: (p) => (
        <select
          value={p.team_id ?? ''}
          aria-label={`Team for ${p.name}`}
          onChange={(e) => updateParticipant(p.id, { team_id: e.target.value || null })}
          style={{ margin: 0 }}
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
      key: 'delete',
      header: '',
      render: (p) => (
        <ConfirmAction
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
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Roster"
        crumbs={[{ label: 'Configure' }, { label: 'Roster' }]}
        meta={workshop ? `${myParticipants.length} participants · ${myTeams.length} teams` : undefined}
      />

      {!workshop ? (
        <div className="banner warn">
          No workshop loaded. Load one from <a href="/admin/data">Data</a>, then edit it here.
        </div>
      ) : (
        <>
          <div className="card form-col">
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

          <div className="card form-col">
            <h2>Teams</h2>
            {myTeams.length === 0 && (
              <p className="small muted">No teams yet. Participants can stay unassigned.</p>
            )}
            {myTeams.map((t) => (
              <div className="row" key={t.id} style={{ marginBottom: 'var(--s-2)' }}>
                <input
                  defaultValue={t.name}
                  aria-label={`Team name ${t.name}`}
                  onBlur={(e) => updateTeam(t.id, { name: e.target.value })}
                  style={{ flex: 1, margin: 0 }}
                />
                <ConfirmAction
                  label="delete"
                  confirmLabel={`Delete ${t.name}`}
                  disabled={busy}
                  warning={<>Participants on this team become unassigned. Their evidence is untouched.</>}
                  onConfirm={() => withBusy(() => deleteTeam(t.id))}
                />
              </div>
            ))}
            <div className="row">
              <input
                placeholder="New team name"
                aria-label="New team name"
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value)}
                style={{ flex: 1, margin: 0 }}
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

          <div className="card">
            <h2>Participants</h2>
            <p className="small muted">
              Fields save when you click away. Renaming is safe: everything downstream keys on the
              participant id, not the name.
            </p>
            <DataTable
              rows={myParticipants}
              columns={columns}
              rowKey={(p) => p.id}
              defaultSort="name"
              defaultDir="asc"
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
        </>
      )}
    </>
  )
}
