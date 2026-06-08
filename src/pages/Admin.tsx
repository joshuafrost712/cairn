import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { loadReferenceData, primeFromSeed } from '../db/reference'
import { isSupabaseConfigured } from '../lib/supabase'
import type { Activity, Ksa, Participant, Workshop } from '../lib/types'

/**
 * Minimal admin: shows what reference content is loaded on this device and lets you
 * (re)load it. A full admin authoring UI for workshops/schedules/KSAs is a later
 * step; for the foundation slice, content is loaded from Supabase (if configured)
 * or primed from the local seed.
 */
export function Admin() {
  const [busy, setBusy] = useState(false)
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])

  const reload = async () => {
    setBusy(true)
    try {
      await loadReferenceData()
    } finally {
      setBusy(false)
    }
  }

  const seed = async () => {
    setBusy(true)
    try {
      await primeFromSeed()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Admin</h1>
        <p className="muted small">
          Backend: {isSupabaseConfigured ? 'Supabase configured' : 'local-only (no Supabase)'}
        </p>
        <div className="row">
          <button onClick={reload} disabled={busy}>
            {isSupabaseConfigured ? 'Reload from backend' : 'Reload reference'}
          </button>
          <button className="ghost" onClick={seed} disabled={busy}>
            Load sample workshop
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Loaded content</h2>
        <ul className="small">
          <li>{workshops?.length ?? 0} workshop(s)</li>
          <li>{activities?.length ?? 0} activities</li>
          <li>{participants?.length ?? 0} participants</li>
          <li>{ksas?.length ?? 0} KSAs</li>
        </ul>
      </div>

      {(workshops ?? []).map((w) => (
        <div className="card" key={w.id}>
          <h2>{w.name}</h2>
          <p className="muted small">{w.location}</p>
          <p className="small">
            <strong>Activities:</strong>{' '}
            {(activities ?? [])
              .filter((a) => a.workshop_id === w.id)
              .sort((x, y) => x.sort_order - y.sort_order)
              .map((a) => a.title)
              .join(' · ')}
          </p>
          <p className="small">
            <strong>Participants:</strong>{' '}
            {(participants ?? []).filter((p) => p.workshop_id === w.id).map((p) => p.name).join(', ')}
          </p>
        </div>
      ))}

      <div className="card">
        <h2>KSAs</h2>
        {(ksas ?? []).map((k) => (
          <p className="small" key={k.id}>
            <strong>{k.code}</strong> ({k.area}) — {k.evaluator_facing_prompt}
          </p>
        ))}
      </div>
    </main>
  )
}
