import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { saveAnswers, submitEvaluation, undoLastEdit } from '../db/evaluations'
import { composeSourceText } from '../lib/compose'
import { INPUT_RULES, DICTATION_HINT } from '../lib/ruleset'
import { RubricPanel } from '../components/RubricPanel'
import type { Ksa, Participant, ParticipantScopeEntry } from '../lib/types'

export function CaptureActivity() {
  const { clientId = '' } = useParams()
  const navigate = useNavigate()

  const record = useLiveQuery(() => db.evaluations.get(clientId), [clientId])
  const activity = useLiveQuery(
    () => (record?.activity_id ? db.activities.get(record.activity_id) : undefined),
    [record?.activity_id],
  )
  const [ksas, setKsas] = useState<Ksa[]>([])
  const participants = useLiveQuery(
    () =>
      record?.workshop_id
        ? db.participants.where('workshop_id').equals(record.workshop_id).toArray()
        : Promise.resolve([] as Participant[]),
    [record?.workshop_id],
    [] as Participant[],
  )

  // Local working copy so typing is never clobbered by the live query.
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<ParticipantScopeEntry[]>([])
  const [attested, setAttested] = useState(false)
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const editRecorded = useRef(false)

  useEffect(() => {
    if (record?.activity_id) void ksasForActivity(record.activity_id).then(setKsas)
  }, [record?.activity_id])

  // Seed local state from the record on first load (React's "adjust state during
  // render" pattern — avoids a clobber-prone effect).
  if (record && seededFor !== record.client_id) {
    setSeededFor(record.client_id)
    setAnswers(record.answers ?? {})
    setScope(record.participant_scope ?? [])
  }

  const alreadySubmitted = Boolean(record?.attestation)

  const persist = (next: Record<string, string>, nextScope = scope) => {
    // After submission, the first change in this session records an undo snapshot.
    const recordEdit = alreadySubmitted && !editRecorded.current
    if (recordEdit) editRecorded.current = true
    void saveAnswers(clientId, next, { recordEdit, participant_scope: nextScope })
  }

  const onAnswerChange = (ksaId: string, text: string) => {
    const next = { ...answers, [ksaId]: text }
    setAnswers(next)
    persist(next)
  }

  const toggleParticipant = (p: Participant) => {
    const exists = scope.some((s) => s.participant_id === p.id)
    const next = exists
      ? scope.filter((s) => s.participant_id !== p.id)
      : [...scope, { participant_id: p.id, name: p.name }]
    setScope(next)
    persist(answers, next)
  }

  const onUndo = async () => {
    const restored = await undoLastEdit(clientId)
    if (restored) setAnswers(restored)
  }

  const hasContent = useMemo(
    () => Object.values(answers).some((v) => v.trim().length > 0),
    [answers],
  )

  const submit = async () => {
    const a = answers
    await submitEvaluation(clientId, {
      answers: a,
      source_text: composeSourceText(a, ksas),
      participant_scope: scope,
      source_language: record?.source_language ?? 'English',
    })
    navigate('/evaluations')
  }

  if (!record) {
    return (
      <main>
        <div className="banner warn">Evaluation not found. <Link to="/">Back home</Link></div>
      </main>
    )
  }

  return (
    <main>
      <div className="card">
        <h1>{activity?.title ?? 'Activity'}</h1>
        <div className="banner info">{DICTATION_HINT}</div>
        {alreadySubmitted && (
          <div className="banner info">
            Submitted. You can edit, add to, or correct this evaluation; changes save instantly.
          </div>
        )}
        <label>Who are you watching?</label>
        <div className="row">
          {(participants ?? []).map((p) => {
            const on = scope.some((s) => s.participant_id === p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={on ? 'primary' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleParticipant(p)}
              >
                {p.name}
              </button>
            )
          })}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Tag who an observation is about as you dictate. Whole-group remarks are fine; the AI step
          (later) distributes them to each individual.
        </p>
      </div>

      {ksas.map((k) => (
        <div className="card" key={k.id}>
          <label htmlFor={`ksa-${k.id}`}>{k.evaluator_facing_prompt}</label>
          <p className="muted small" style={{ marginTop: -4 }}>
            {k.code} · {k.area}
          </p>
          <RubricPanel levels={k.evidence_levels} />
          <textarea
            id={`ksa-${k.id}`}
            value={answers[k.id] ?? ''}
            onChange={(e) => onAnswerChange(k.id, e.target.value)}
            placeholder="Dictate or type what you observed…"
          />
        </div>
      ))}

      <div className="card">
        <h2>Before you submit</h2>
        <ul className="small muted">
          {INPUT_RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <label className="row" style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
          />
          <span>This text is what I meant, and I followed the input rules.</span>
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!attested || !hasContent} onClick={submit}>
            {alreadySubmitted ? 'Save changes' : 'Submit'}
          </button>
          {record.edit_history.length > 0 && (
            <button className="ghost" onClick={onUndo}>
              Undo last edit
            </button>
          )}
          <span className="spacer" />
          <button
            className="ghost"
            disabled
            title="Restores the first AI translation — available once the AI translation layer ships"
          >
            Reload original (later)
          </button>
        </div>
      </div>
    </main>
  )
}
