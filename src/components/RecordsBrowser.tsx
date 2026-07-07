// Participant records dashboard — chief evaluator view.
//
// Lets the chief evaluator select a participant and see their full record:
//   • Per-KSA report summary (representative designation, conflict flags)
//   • Raw observations grouped by KSA (with inline edit of designation + text)
//   • Mentoring conversations for the participant
//   • "Add observation after the fact" form
//
// Used only from Admin.tsx. Does not touch App.tsx or any restricted file.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { buildParticipantReport } from '../reports/build'
import { annotateObservations, type AnnotatedObservation } from '../reports/verification'
import { reconcileMentoringConversations } from '../db/mentoring'
import { useAuth } from '../auth/AuthContext'
import type { Activity, Ksa, MentoringConversation, ObservationRecord, Participant, Team, VerificationVerdict } from '../lib/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function designationLabel(d: number | null): string {
  if (d === null) return 'none'
  return `${d}/3`
}

function statusPill(vstatus: string) {
  const map: Record<string, string> = {
    verified: 'synced',
    adjusted: 'synced',
    disputed: 'error',
    pending: 'queued',
  }
  return map[vstatus] ?? ''
}

function mentoringStatusPill(status: string) {
  if (status === 'completed') return 'synced'
  if (status === 'needed') return 'queued'
  return ''
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString([], { dateStyle: 'medium' })
}

// ---------------------------------------------------------------------------
// Inline observation editor
// ---------------------------------------------------------------------------

interface ObsEditorProps {
  obs: AnnotatedObservation
  onSaved: () => void
  onCancel: () => void
}

function ObsEditor({ obs, onSaved, onCancel }: ObsEditorProps) {
  const [designation, setDesignation] = useState<number>(obs.evidence_designation)
  const [text, setText] = useState(obs.text)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      await db.observations.update(obs.id, {
        evidence_designation: designation as 0 | 1 | 2 | 3,
        text,
      })
      onSaved()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} style={{ marginTop: '0.6rem', borderTop: '1px dashed var(--line)', paddingTop: '0.6rem' }}>
      <p className="small muted" style={{ marginBottom: '0.4rem' }}>Admin correction — changes the stored record directly.</p>
      <label htmlFor={`desg-${obs.id}`}>Evidence designation</label>
      <select
        id={`desg-${obs.id}`}
        value={designation}
        onChange={(e) => setDesignation(Number(e.target.value))}
        style={{ marginBottom: '0.5rem' }}
      >
        <option value={0}>0 — Not demonstrated</option>
        <option value={1}>1 — Partially demonstrated</option>
        <option value={2}>2 — Demonstrated</option>
        <option value={3}>3 — Clearly demonstrated</option>
      </select>
      <label htmlFor={`text-${obs.id}`}>Observation text</label>
      <textarea
        id={`text-${obs.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ marginBottom: '0.5rem' }}
        required
      />
      {err && <div className="banner" style={{ color: 'var(--danger)', background: '#fef2f2', borderColor: '#fecaca', marginBottom: '0.4rem' }}>{err}</div>}
      <div className="row">
        <button type="submit" className="primary" disabled={saving || !text.trim()}>
          {saving ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Single observation row
// ---------------------------------------------------------------------------

interface ObsRowProps {
  obs: AnnotatedObservation
}

function ObsRow({ obs }: ObsRowProps) {
  const [editing, setEditing] = useState(false)

  return (
    <div
      className="activity-item"
      style={{ display: 'block', cursor: 'default', marginBottom: '0.4rem' }}
    >
      <div className="row" style={{ marginBottom: '0.2rem' }}>
        <span className="small">
          <strong>{designationLabel(obs.effective_designation)}</strong>
          {obs.effective_designation !== obs.evidence_designation && (
            <span className="muted"> (orig {designationLabel(obs.evidence_designation)})</span>
          )}
          {obs.origin === 'group' && <span className="muted"> (group)</span>}
        </span>
        <span className={`pill ${statusPill(obs.vstatus)}`}>{obs.vstatus}</span>
        {obs.needs_review && <span className="pill queued">needs review</span>}
        <span className="spacer" />
        {!editing && (
          <button
            className="ghost"
            style={{ fontSize: '0.78rem', padding: '0.2rem 0.5rem' }}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </div>
      <p className="small" style={{ margin: '0.1rem 0' }}>{obs.text}</p>
      {obs.source_excerpt && (
        <p className="small muted" style={{ margin: '0.1rem 0', fontStyle: 'italic' }}>"{obs.source_excerpt}"</p>
      )}
      <p className="small muted" style={{ margin: '0.1rem 0' }}>
        Evaluator: {obs.evaluator_email ?? 'unknown'} · imported {obs.imported_at.slice(0, 10)}
      </p>
      {editing && (
        <ObsEditor obs={obs} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// "Add observation after the fact" form
// ---------------------------------------------------------------------------

interface AppendFormProps {
  participant: Participant
  activities: Activity[]
  ksas: Ksa[]
  evaluatorEmail: string
  onAdded: () => void
}

function AppendForm({ participant, activities, ksas, evaluatorEmail, onAdded }: AppendFormProps) {
  const [activityId, setActivityId] = useState(activities[0]?.id ?? '')
  const [ksaId, setKsaId] = useState(ksas[0]?.id ?? '')
  const [designation, setDesignation] = useState<number>(1)
  const [text, setText] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const selectedKsa = ksas.find((k) => k.id === ksaId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedKsa) return
    setSaving(true)
    setErr(null)

    try {
      const count = await db.observations.count()
      const id = `manual-${Date.now()}-${count}`
      const captureId = `manual::${id}`
      const now = new Date().toISOString()

      const record: ObservationRecord = {
        id,
        capture_client_id: captureId,
        participant_id: participant.id,
        participant_name: participant.name,
        ksa_code: selectedKsa.code,
        evidence_designation: designation as 0 | 1 | 2 | 3,
        text: text.trim(),
        source_excerpt: excerpt.trim(),
        sentiment_flag: 'neutral',
        confidence: 'high',
        needs_review: false,
        origin: 'individual',
        imported_at: now,
        evaluator_email: evaluatorEmail || null,
      }

      await db.observations.add(record)
      await reconcileMentoringConversations()
      setText('')
      setExcerpt('')
      onAdded()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p className="small muted" style={{ marginBottom: '0.6rem' }}>
        Use when a participant has a late-breaking performance to record that belongs to a past activity.
        Reconcile runs automatically after adding so a low designation triggers a mentoring conversation.
      </p>

      <label htmlFor="af-activity">Activity</label>
      <select
        id="af-activity"
        value={activityId}
        onChange={(e) => setActivityId(e.target.value)}
        style={{ marginBottom: '0.5rem' }}
        disabled={activities.length === 0}
      >
        {activities.length === 0 && <option value="">No activities loaded</option>}
        {activities.map((a) => (
          <option key={a.id} value={a.id}>{a.title}{a.day ? ` (${a.day})` : ''}</option>
        ))}
      </select>

      <label htmlFor="af-ksa">KSA</label>
      <select
        id="af-ksa"
        value={ksaId}
        onChange={(e) => setKsaId(e.target.value)}
        style={{ marginBottom: '0.5rem' }}
        disabled={ksas.length === 0}
      >
        {ksas.length === 0 && <option value="">No KSAs loaded</option>}
        {ksas.map((k) => (
          <option key={k.id} value={k.id}>{k.code} — {k.short_label}</option>
        ))}
      </select>

      <label htmlFor="af-designation">Evidence designation</label>
      <select
        id="af-designation"
        value={designation}
        onChange={(e) => setDesignation(Number(e.target.value))}
        style={{ marginBottom: '0.5rem' }}
      >
        <option value={0}>0 — Not demonstrated</option>
        <option value={1}>1 — Partially demonstrated</option>
        <option value={2}>2 — Demonstrated</option>
        <option value={3}>3 — Clearly demonstrated</option>
      </select>

      <label htmlFor="af-text">Observation</label>
      <textarea
        id="af-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What did you observe?"
        required
        style={{ marginBottom: '0.5rem' }}
      />

      <label htmlFor="af-excerpt">Source excerpt (optional)</label>
      <textarea
        id="af-excerpt"
        value={excerpt}
        onChange={(e) => setExcerpt(e.target.value)}
        placeholder="Relevant quote from their work or speech"
        style={{ marginBottom: '0.5rem', minHeight: '60px' }}
      />

      {err && (
        <div className="banner" style={{ color: 'var(--danger)', background: '#fef2f2', borderColor: '#fecaca', marginBottom: '0.4rem' }}>{err}</div>
      )}

      <button type="submit" className="primary" disabled={saving || !text.trim() || ksas.length === 0}>
        {saving ? 'Adding…' : 'Add observation'}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RecordsBrowser() {
  const { identity } = useAuth()

  const participants = useLiveQuery(() => db.participants.toArray(), [], [] as Participant[])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [] as Ksa[])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [] as Activity[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const allObservations = useLiveQuery(() => db.observations.toArray(), [], [] as ObservationRecord[])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [] as VerificationVerdict[])
  const allConversations = useLiveQuery(() => db.mentoringConversations.toArray(), [], [] as MentoringConversation[])

  const [selectedId, setSelectedId] = useState<string>('')
  const [showAppend, setShowAppend] = useState(false)

  const sortedKsas = useMemo(
    () => [...(ksas ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [ksas],
  )

  const sortedActivities = useMemo(
    () => [...(activities ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    [activities],
  )

  const annotated = useMemo(
    () => annotateObservations(allObservations ?? [], verdicts ?? []),
    [allObservations, verdicts],
  )

  const selected = useMemo(
    () => (participants ?? []).find((p) => p.id === selectedId) ?? null,
    [participants, selectedId],
  )

  const report = useMemo(() => {
    if (!selected) return null
    return buildParticipantReport(selected, sortedKsas, annotated, teams ?? [])
  }, [selected, sortedKsas, annotated, teams])

  const participantObs = useMemo(
    () => annotated.filter((o) => o.participant_id === selectedId),
    [annotated, selectedId],
  )

  // Group observations by ksa_code for the raw view
  const obsByKsa = useMemo(() => {
    const m = new Map<string, AnnotatedObservation[]>()
    for (const o of participantObs) {
      const list = m.get(o.ksa_code) ?? []
      list.push(o)
      m.set(o.ksa_code, list)
    }
    return m
  }, [participantObs])

  const participantConvs = useMemo(
    () => (allConversations ?? []).filter((c) => c.participant_id === selectedId),
    [allConversations, selectedId],
  )

  if ((participants ?? []).length === 0) {
    return (
      <p className="small muted">No participants loaded. Load a workshop first.</p>
    )
  }

  return (
    <div>
      <label htmlFor="rec-picker">Select participant</label>
      <select
        id="rec-picker"
        value={selectedId}
        onChange={(e) => { setSelectedId(e.target.value); setShowAppend(false) }}
        style={{ marginBottom: '0.75rem' }}
      >
        <option value="">— choose —</option>
        {(participants ?? []).map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      {!selected && (
        <p className="small muted">Pick a participant above to see their full record.</p>
      )}

      {selected && report && (
        <>
          {/* ---- KSA summary ---- */}
          <div style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.4rem' }}>KSA summary</h3>
            <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
              {report.totals.evidencedKsas}/{report.totals.totalKsas} areas evidenced
              {report.totals.needsReviewCount > 0 ? ` · ${report.totals.needsReviewCount} pending review` : ''}
              {report.team_name ? ` · ${report.team_name}` : ''}
            </p>

            {report.ksaRollups.filter((r) => r.representative !== null).length === 0 && (
              <p className="small muted">No observations recorded yet.</p>
            )}

            {report.ksaRollups
              .filter((r) => r.representative !== null)
              .map((r) => (
                <div
                  key={r.ksa_code}
                  className="activity-item"
                  style={{ display: 'block', cursor: 'default', marginBottom: '0.35rem' }}
                >
                  <div className="row">
                    <span>
                      <strong>{r.ksa_code}</strong>
                      <span className="muted small"> {r.area}</span>
                    </span>
                    <span className="pill">{designationLabel(r.representative)}</span>
                    {r.conflict && (
                      <span className="pill queued">conflict</span>
                    )}
                  </div>
                  <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                    {r.contributing.length} counting · {r.toVerify.length} to verify
                    {r.designations.length > 1 && ` · spread: ${r.designations[0]}–${r.designations[r.designations.length - 1]}`}
                  </p>
                </div>
              ))}

            {report.ksaRollups.some((r) => r.representative === null) && (
              <p className="small muted">
                No evidence yet: {report.ksaRollups.filter((r) => r.representative === null).map((r) => r.ksa_code).join(', ')}.
              </p>
            )}
          </div>

          {/* ---- Raw observations by KSA ---- */}
          <div style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.4rem' }}>
              Raw observations ({participantObs.length})
            </h3>
            <p className="small muted" style={{ marginBottom: '0.5rem' }}>
              To dispute or verify, use <Link to="/observations">Observations</Link> or <Link to="/inbox">Inbox</Link>.
              The edit button below makes an admin correction to designation and text only.
            </p>

            {participantObs.length === 0 && (
              <p className="small muted">No observations for this participant yet.</p>
            )}

            {sortedKsas
              .filter((k) => (obsByKsa.get(k.code) ?? []).length > 0)
              .map((k) => (
                <div key={k.code} style={{ marginBottom: '0.6rem' }}>
                  <p className="small" style={{ fontWeight: 700, margin: '0 0 0.25rem' }}>
                    {k.code} — {k.short_label}
                  </p>
                  {(obsByKsa.get(k.code) ?? []).map((o) => (
                    <ObsRow key={o.id} obs={o} />
                  ))}
                </div>
              ))}
          </div>

          {/* ---- Mentoring conversations ---- */}
          <div style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.4rem' }}>
              Mentoring conversations ({participantConvs.length})
            </h3>

            {participantConvs.length === 0 && (
              <p className="small muted">No mentoring conversations for this participant.</p>
            )}

            {participantConvs.map((c) => (
              <div key={c.id} className="activity-item" style={{ display: 'block', cursor: 'default', marginBottom: '0.35rem' }}>
                <div className="row" style={{ marginBottom: '0.15rem' }}>
                  <span className="small">
                    <strong>{c.trigger_ksa_code ?? 'KSA unknown'}</strong>
                    {c.trigger_designation !== null && (
                      <span className="pill" style={{ marginLeft: '0.4rem' }}>{c.trigger_designation}/3</span>
                    )}
                  </span>
                  <span className={`pill ${mentoringStatusPill(c.status)}`}>{c.status}</span>
                </div>
                {c.scheduled_for && (
                  <p className="small muted" style={{ margin: '0.1rem 0' }}>Scheduled: {fmtDate(c.scheduled_for)}</p>
                )}
                {c.summary && (
                  <p className="small muted" style={{ margin: '0.1rem 0' }}>Summary: {c.summary}</p>
                )}
                {c.participant_response && (
                  <p className="small muted" style={{ margin: '0.1rem 0' }}>
                    <em>Response:</em> {c.participant_response}
                  </p>
                )}
              </div>
            ))}

            {participantConvs.length > 0 && (
              <p className="small muted">
                Manage conversations on <Link to="/conversations">Conversations</Link>.
              </p>
            )}
          </div>

          {/* ---- Append form ---- */}
          <div>
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '0.95rem', margin: 0 }}>Add observation after the fact</h3>
              <span className="spacer" />
              <button
                className="ghost"
                style={{ fontSize: '0.85rem', padding: '0.3rem 0.65rem' }}
                onClick={() => setShowAppend((v) => !v)}
              >
                {showAppend ? 'Cancel' : 'Open form'}
              </button>
            </div>

            {showAppend && (
              <AppendForm
                participant={selected}
                activities={sortedActivities}
                ksas={sortedKsas}
                evaluatorEmail={identity?.email ?? ''}
                onAdded={() => setShowAppend(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
