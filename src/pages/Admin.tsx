import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { loadReferenceData, primeFromSeed } from '../db/reference'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  addParticipant,
  addTeam,
  deleteParticipant,
  deleteTeam,
  updateParticipant,
  updateTeam,
  updateWorkshop,
} from '../db/admin'
import { exportAll, importAll } from '../db/backup'
import { getRequiredConfirmations, setRequiredConfirmations } from '../reports/verification'
import { downloadText } from '../lib/download'
import type { Activity, Ksa, Participant, Team, Workshop } from '../lib/types'

// Admin: load/seed reference content, edit the workshop meta + roster (teams and
// participants) so a real workshop can be entered without code edits. KSAs and the
// schedule are authored content and shown read-only here.
export function Admin() {
  const [busy, setBusy] = useState(false)
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])

  const workshop = (workshops ?? [])[0] ?? null
  const [newTeam, setNewTeam] = useState('')
  const [newName, setNewName] = useState('')
  const [restore, setRestore] = useState('')
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [required, setRequired] = useState(() => getRequiredConfirmations())

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
  const teamName = (id: string | null) => myTeams.find((t) => t.id === id)?.name ?? 'Unassigned'

  return (
    <main>
      <div className="card">
        <h1>Admin</h1>
        <p className="muted small">Backend: {isSupabaseConfigured ? 'Supabase configured' : 'local-only (no Supabase)'}</p>
        <div className="row">
          <button onClick={() => withBusy(loadReferenceData)} disabled={busy}>
            {isSupabaseConfigured ? 'Reload from backend' : 'Reload reference'}
          </button>
          <button className="ghost" onClick={() => withBusy(primeFromSeed)} disabled={busy}>
            Load sample workshop
          </button>
        </div>
        {isSupabaseConfigured && (
          <p className="small muted" style={{ marginTop: '0.4rem' }}>
            Note: reloading from the backend overwrites local edits. Manage the roster in the backend when Supabase is on.
          </p>
        )}
      </div>

      {!workshop ? (
        <div className="banner warn">No workshop loaded. Use "Load sample workshop" to start, then edit it below.</div>
      ) : (
        <>
          <div className="card">
            <h2>Workshop</h2>
            <label htmlFor="wname">Name</label>
            <input id="wname" defaultValue={workshop.name ?? ''} onBlur={(e) => updateWorkshop(workshop.id, { name: e.target.value })} />
            <label htmlFor="wloc">Location</label>
            <input id="wloc" defaultValue={workshop.location ?? ''} onBlur={(e) => updateWorkshop(workshop.id, { location: e.target.value })} />
            <div className="row">
              <span>
                <label htmlFor="wstart">Start</label>
                <input id="wstart" type="date" defaultValue={workshop.start_date ?? ''} onBlur={(e) => updateWorkshop(workshop.id, { start_date: e.target.value })} />
              </span>
              <span>
                <label htmlFor="wend">End</label>
                <input id="wend" type="date" defaultValue={workshop.end_date ?? ''} onBlur={(e) => updateWorkshop(workshop.id, { end_date: e.target.value })} />
              </span>
            </div>
          </div>

          <div className="card">
            <h2>Teams</h2>
            {myTeams.map((t) => (
              <div className="row" key={t.id} style={{ marginBottom: '0.4rem' }}>
                <input defaultValue={t.name} onBlur={(e) => updateTeam(t.id, { name: e.target.value })} style={{ flex: 1 }} />
                <button className="ghost small" disabled={busy} onClick={() => withBusy(() => deleteTeam(t.id))}>delete</button>
              </div>
            ))}
            <div className="row">
              <input placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} style={{ flex: 1 }} />
              <button
                disabled={busy || !newTeam.trim()}
                onClick={() => withBusy(async () => { await addTeam(workshop.id, newTeam.trim()); setNewTeam('') })}
              >
                Add team
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Participants ({myParticipants.length})</h2>
            {myParticipants.map((p) => (
              <div key={p.id} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
                <div className="row">
                  <input defaultValue={p.name} onBlur={(e) => updateParticipant(p.id, { name: e.target.value })} style={{ flex: 1 }} />
                  <button className="ghost small" disabled={busy} onClick={() => withBusy(() => deleteParticipant(p.id))}>delete</button>
                </div>
                <div className="row" style={{ marginTop: '0.3rem' }}>
                  <input
                    type="email"
                    defaultValue={p.registered_email ?? ''}
                    placeholder="email"
                    onBlur={(e) => updateParticipant(p.id, { registered_email: e.target.value || null })}
                    style={{ flex: 1 }}
                  />
                  <select value={p.team_id ?? ''} onChange={(e) => updateParticipant(p.id, { team_id: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {myTeams.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <div className="muted small" style={{ marginTop: '0.2rem' }}>{teamName(p.team_id)}</div>
              </div>
            ))}
            <div className="row" style={{ marginTop: '0.4rem' }}>
              <input placeholder="New participant name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
              <button
                disabled={busy || !newName.trim()}
                onClick={() => withBusy(async () => { await addParticipant(workshop.id, { name: newName.trim() }); setNewName('') })}
              >
                Add participant
              </button>
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Verification</h2>
        <label htmlFor="reqconf" className="small muted">
          Evaluators who must confirm each observation before it counts toward a finalized report.
        </label>
        <div className="row">
          <input
            id="reqconf"
            type="number"
            min={1}
            max={5}
            value={required}
            onChange={(e) => {
              const n = Math.max(1, Math.min(5, Number(e.target.value) || 1))
              setRequired(n)
              setRequiredConfirmations(n)
            }}
            style={{ width: '5rem' }}
          />
          <span className="small muted">1 = solo review · 2 = dual review (default)</span>
        </div>
      </div>

      <div className="card">
        <h2>Backup &amp; restore</h2>
        <p className="small muted">
          Everything on this device (reference, captures, observations, verdicts) as one JSON file.
          Restore merges (upserts) into the current store.
        </p>
        <div className="row">
          <button
            disabled={busy}
            onClick={() => withBusy(async () => { downloadText('cairn-backup.json', JSON.stringify(await exportAll(), null, 2)) })}
          >
            Download backup
          </button>
        </div>
        <label htmlFor="restore" className="small muted">Paste a backup to restore:</label>
        <textarea id="restore" className="mono" rows={4} value={restore} onChange={(e) => setRestore(e.target.value)} placeholder='{"schema":"cairn.backup/v1", ...}' />
        <button
          disabled={busy || !restore.trim()}
          onClick={() =>
            withBusy(async () => {
              try {
                const r = await importAll(restore)
                setRestore('')
                setBackupMsg(`Restored ${r.rows} row(s) across ${r.tables} table(s).`)
              } catch (err) {
                setBackupMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
              }
            })
          }
        >
          Restore from paste
        </button>
        {backupMsg && <div className="banner">{backupMsg}</div>}
      </div>

      <div className="card">
        <h2>Schedule &amp; KSAs (read-only)</h2>
        <p className="small muted">
          {(activities ?? []).length} activities · {(ksas ?? []).length} KSAs. These are authored content,
          seeded from the workshop plan.
        </p>
        {(ksas ?? []).map((k) => (
          <p className="small" key={k.id}>
            <strong>{k.code}</strong> ({k.area})
          </p>
        ))}
      </div>
    </main>
  )
}
