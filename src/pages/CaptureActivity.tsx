import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { coverageForActivity } from '../db/coverage'
import { saveAnswers, submitEvaluation, undoLastEdit } from '../db/evaluations'
import { composeSourceText } from '../lib/compose'
import { INPUT_RULES, INPUT_RULES_SHORT, DICTATION_HINT } from '../lib/ruleset'
import { QuickRating } from '../components/QuickRating'
import { Glossary } from '../components/Glossary'
import type { Ksa, Participant, ParticipantScopeEntry, QuickRatings } from '../lib/types'

type Level = 0 | 1 | 2 | 3

/** Short initials for an evaluator email (local-part), e.g. "josh_frost@sil.org" -> "JF". */
function evaluatorInitials(email: string): string {
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const letters = (parts.length >= 2 ? [parts[0], parts[1]] : [local]).map((s) => s[0] ?? '')
  return letters.join('').toUpperCase().slice(0, 2) || '?'
}

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

  // Live evaluation coverage for this activity: who has already received an
  // evaluation, by whom, and how many. Fed by this device's submissions and, via
  // Supabase Realtime, other evaluators' devices (see db/coverage.ts). The
  // live-query repaints the selector automatically when a coverage row lands.
  const coverage = useLiveQuery(
    () => (record?.activity_id ? coverageForActivity(record.activity_id) : undefined),
    [record?.activity_id],
  )

  // Local working copy so typing is never clobbered by the live query.
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<ParticipantScopeEntry[]>([])
  const [quickRatings, setQuickRatings] = useState<QuickRatings>({})
  const [focusParticipantId, setFocusParticipantId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
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
    setQuickRatings(record.quick_ratings ?? {})
    setFocusParticipantId(record.focus_participant_id ?? null)
    setFocusMode(Boolean(record.focus_participant_id))
  }

  const alreadySubmitted = Boolean(record?.attestation)

  const persist = (
    next: Record<string, string>,
    overrides: {
      scope?: ParticipantScopeEntry[]
      quick_ratings?: QuickRatings
      focus_participant_id?: string | null
    } = {},
  ) => {
    // After submission, the first change in this session records an undo snapshot.
    const recordEdit = alreadySubmitted && !editRecorded.current
    if (recordEdit) editRecorded.current = true
    void saveAnswers(clientId, next, {
      recordEdit,
      participant_scope: overrides.scope ?? scope,
      quick_ratings: overrides.quick_ratings ?? quickRatings,
      focus_participant_id:
        overrides.focus_participant_id !== undefined ? overrides.focus_participant_id : focusParticipantId,
    })
  }

  const onAnswerChange = (ksaId: string, text: string) => {
    const next = { ...answers, [ksaId]: text }
    setAnswers(next)
    persist(next)
  }

  const onRatingChange = (ksaId: string, level: Level | undefined) => {
    const next = { ...quickRatings }
    if (level === undefined) delete next[ksaId]
    else next[ksaId] = level
    setQuickRatings(next)
    persist(answers, { quick_ratings: next })
  }

  const toggleParticipant = (p: Participant) => {
    const exists = scope.some((s) => s.participant_id === p.id)
    const next = exists
      ? scope.filter((s) => s.participant_id !== p.id)
      : [...scope, { participant_id: p.id, name: p.name }]
    setScope(next)
    persist(answers, { scope: next })
  }

  // Focus mode: capture about exactly one CIT for clean attribution.
  const selectFocus = (p: Participant) => {
    const next: ParticipantScopeEntry[] = [{ participant_id: p.id, name: p.name }]
    setScope(next)
    setFocusParticipantId(p.id)
    persist(answers, { scope: next, focus_participant_id: p.id })
  }

  const toggleFocusMode = () => {
    const on = !focusMode
    setFocusMode(on)
    if (on) {
      // Carry a single existing selection into focus; otherwise start unselected.
      const single = scope.length === 1 ? scope[0] : null
      const nextScope = single ? [single] : []
      const fid = single?.participant_id ?? null
      setScope(nextScope)
      setFocusParticipantId(fid)
      persist(answers, { scope: nextScope, focus_participant_id: fid })
    } else {
      setFocusParticipantId(null)
      persist(answers, { focus_participant_id: null })
    }
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
      source_text: composeSourceText(a, ksas, quickRatings),
      participant_scope: scope,
      source_language: record?.source_language ?? 'English',
      quick_ratings: quickRatings,
      focus_participant_id: focusParticipantId,
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
        <div className="banner info">
          {alreadySubmitted
            ? 'Submitted. You can edit, add to, or correct this evaluation; changes save instantly.'
            : DICTATION_HINT}
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted small">{INPUT_RULES_SHORT}</span>
          <Glossary />
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label style={{ margin: 0 }}>Who are you watching?</label>
          <button
            type="button"
            className={`rubric-toggle ${focusMode ? 'primary' : ''}`}
            aria-pressed={focusMode}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleFocusMode}
          >
            {focusMode ? 'Focus: one CIT' : 'Focus on one CIT'}
          </button>
        </div>
        {(() => {
          const total = participants?.length ?? 0
          const covered = (participants ?? []).filter((p) => (coverage?.get(p.id)?.count ?? 0) > 0).length
          const remaining = total - covered
          if (total === 0) return null
          return (
            <p
              className={`small coverage-summary ${remaining === 0 ? 'ok' : ''}`}
              style={{ marginTop: 8, marginBottom: 0 }}
            >
              {remaining === 0
                ? `All ${total} participants have an evaluation for this activity.`
                : `${remaining} of ${total} still need evaluation.`}
            </p>
          )
        })()}
        <div className="row" style={{ marginTop: 8 }}>
          {(participants ?? []).map((p) => {
            const on = focusMode ? focusParticipantId === p.id : scope.some((s) => s.participant_id === p.id)
            const cov = coverage?.get(p.id)
            const evs = cov?.evaluators ?? []
            const title = cov
              ? `Evaluated ${cov.count}× by ${evs.join(', ') || 'unknown'}`
              : 'Not yet evaluated for this activity'
            return (
              <button
                key={p.id}
                type="button"
                className={`participant-btn${on ? ' primary' : ''}${cov ? ' covered' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (focusMode ? selectFocus(p) : toggleParticipant(p))}
                title={title}
              >
                <span>{p.name}</span>
                {cov && (
                  <span className="coverage-badge" aria-label={title}>
                    <span className="coverage-check" aria-hidden="true">
                      &#10003;
                    </span>
                    {evs.slice(0, 2).map((e) => (
                      <span key={e} className="coverage-initials">
                        {evaluatorInitials(e)}
                      </span>
                    ))}
                    {evs.length > 2 && <span className="coverage-initials more">+{evs.length - 2}</span>}
                    {cov.count > 1 && <span className="coverage-count">{cov.count}</span>}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          {focusMode
            ? 'Focus mode: everything you capture is attributed to the one CIT you picked.'
            : 'Tag who an observation is about as you dictate. Whole-group remarks are fine; the AI step (later) distributes them to each individual.'}
        </p>
      </div>

      {ksas.map((k) => (
        <div className="card" key={k.id}>
          <label htmlFor={`ksa-${k.id}`} className="ksa-title">
            {k.short_label || k.code}
          </label>
          <p className="ksa-cue" style={{ marginTop: 2 }}>
            {k.evaluator_facing_prompt}
          </p>
          {k.guiding_questions && k.guiding_questions.length > 0 && (
            <ul className="muted small" style={{ marginTop: 4 }}>
              {k.guiding_questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          <textarea
            id={`ksa-${k.id}`}
            value={answers[k.id] ?? ''}
            onChange={(e) => onAnswerChange(k.id, e.target.value)}
            placeholder="Dictate or type what you observed…"
          />
          <QuickRating
            levels={k.evidence_levels}
            value={quickRatings[k.id]}
            onChange={(level) => onRatingChange(k.id, level)}
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
        </div>
      </div>
    </main>
  )
}
