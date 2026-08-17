import { useEffect, useMemo, useRef, useState } from 'react'

import type { ActivityKsaResolved } from '../lib/goals'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { coverageForActivity } from '../db/coverage'
import { saveAnswers, submitEvaluation, undoLastEdit } from '../db/evaluations'
import { composeSourceText } from '../lib/compose'
import { INPUT_RULES } from '../lib/ruleset'
import { c } from '../lib/content/chrome'
import { Copy } from '../components/Copy'
import { ProfileButton } from '../components/ProfileButton'
import { QuickRating } from '../components/QuickRating'
import { useScale } from '../hooks/useScale'
import { isValidDesignation } from '../lib/scale'
import { Glossary } from '../components/Glossary'
import { useAuth } from '../auth/AuthContext'
import { EVALUATING_ROLES, useHasWorkshopRole } from '../layout/roles'
import { allReviewPairs } from '../db/instructors'
import { isInstructorActivity, rosterForActivity } from '../lib/instructors'
import type { Participant, ParticipantScopeEntry, QuickRatings } from '../lib/types'


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
  const { identity } = useAuth()

  const record = useLiveQuery(() => db.evaluations.get(clientId), [clientId])
  const activity = useLiveQuery(
    () => (record?.activity_id ? db.activities.get(record.activity_id) : undefined),
    [record?.activity_id],
  )
  // Resolved by ksasForActivity: the per-event prompt override is already applied,
  // so this screen shows exactly what the Setup preview and the routing capture file
  // show. That is the point of there being one resolution site (tl-08).
  const [ksas, setKsas] = useState<ActivityKsaResolved[]>([])
  // tl-30. Which roster this event wants, and — for the Instructor feedback
  // event — which of it this viewer is entitled to. `rosterForActivity` is the
  // one place that decision is made, so the grid, the coverage line and the Setup
  // preview cannot disagree about whether a facilitator's name belongs here.
  //
  // An administrator opening the instructor event holds no reviewer pairs and
  // correctly sees nobody: reading the feedback is their job, writing it is not.
  const participants = useLiveQuery(
    async () => {
      if (!record?.workshop_id) return [] as Participant[]
      const [roster, pairs] = await Promise.all([
        db.participants.where('workshop_id').equals(record.workshop_id).toArray(),
        allReviewPairs(),
      ])
      return rosterForActivity(activity, roster, pairs, identity?.email, record.workshop_id)
    },
    [record?.workshop_id, activity?.id, activity?.audience, identity?.email],
    [] as Participant[],
  )

  // One review names one instructor. The database says so with a check
  // constraint (`evaluation_instructor_needs_focus`), so the toggle is not
  // offered here rather than being offered and then refused on submit.
  const instructorReview = isInstructorActivity(activity)
  const canEvaluateTrainees = useHasWorkshopRole(EVALUATING_ROLES)

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
  const scale = useScale()
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
    // tl-30: an instructor review is always a focus capture, even before a name
    // has been picked. Seeding it off `focus_participant_id` alone would open the
    // multi-select grid for the one kind of capture that may not be one.
    setFocusMode(Boolean(record.focus_participant_id) || instructorReview)
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

  /**
   * A quick read is a point on the WORKSHOP's scale (tl-09), so the type no
   * longer constrains it and this is a boundary: the value comes from a button
   * the scale rendered, but the scale can change under a capture that is already
   * open, and a rating for a point that has just been removed would be written
   * into a record nothing could later label. `isValidDesignation` is what
   * replaces the union the compiler used to enforce here.
   */
  const onRatingChange = (ksaId: string, level: number | undefined) => {
    const next = { ...quickRatings }
    if (level === undefined || !isValidDesignation(level, scale)) delete next[ksaId]
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
      <>
        <div className="banner warn">
          <Copy id="capture.not-found.before" /> <Link to="/">{c('capture.not-found.link')}</Link>
        </div>
      </>
    )
  }

  // tl-30. The route gate cannot make this call: whether a capture is allowed
  // depends on the ACTIVITY behind this record, which the router does not know.
  // A reviewer-only member (Angie holds `participant`) may reach /capture for
  // their instructor review and nothing else, and typing another capture's URL
  // must not put a trainee grid in front of them.
  //
  // Not a security boundary. `evaluation_insert` refuses the write either way;
  // this is here so the refusal happens before the dictation rather than after.
  //
  // Review fix, 2026-08-18: the guard waits for the activity. `activity` is a
  // live query and is `undefined` until it resolves, so `instructorReview` is
  // false on the first paint of every capture — and this refusal would flash on
  // the screen of the one person it is written about, on the only screen she has.
  // A capture with no activity at all resolves the query and falls through here,
  // which is the case the refusal is actually for.
  if (record.activity_id && activity === undefined) {
    return null
  }

  if (!instructorReview && !canEvaluateTrainees) {
    return (
      <div className="banner warn">
        <Copy id="capture.not-yours" /> <Link to="/">{c('capture.not-found.link')}</Link>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h1>
          {activity ? (
            <span
              data-dfb-node={activity.id}
              data-dfb-field="title"
              data-dfb-source="ref"
              data-dfb-table="activity"
            >
              {activity.title}
            </span>
          ) : (
            c('capture.activity-fallback')
          )}
        </h1>
        <div className="banner info">
          <Copy id={alreadySubmitted ? 'capture.submitted-banner' : 'capture.dictation-hint'} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Copy id="capture.input-rules-short" className="muted small" />
          <Glossary />
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Copy
            id={instructorReview ? 'capture.instructor-prompt' : 'capture.watching-prompt'}
            as="label"
            style={{ margin: 0 }}
          />
          {/* No focus toggle on an instructor review: focus is not a preference
              there, it is the shape the record must have. Offering the button and
              then refusing the submit would be the worse of the two. */}
          {!instructorReview && (
            <button
              type="button"
              className={`rubric-toggle ${focusMode ? 'primary' : ''}`}
              aria-pressed={focusMode}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleFocusMode}
            >
              {focusMode ? c('capture.focus-on') : c('capture.focus-off')}
            </button>
          )}
        </div>
        {instructorReview && participants.length === 0 && (
          <Copy id="capture.instructor-none" as="p" className="muted small" style={{ marginTop: 8 }} />
        )}
        {(() => {
          // Coverage is a trainee idea: it exists so a room of 26 gets evaluated
          // evenly. "1 of 3 instructors still to review" would read as a quota on
          // a colleague, which is not what this event is.
          if (instructorReview) return null
          const total = participants?.length ?? 0
          const covered = (participants ?? []).filter((p) => (coverage?.get(p.id)?.count ?? 0) > 0).length
          const remaining = total - covered
          if (total === 0) return null
          return (
            <Copy
              id={remaining === 0 ? 'capture.coverage-all' : 'capture.coverage-remaining'}
              tokens={{ total, remaining }}
              as="p"
              className={`small coverage-summary ${remaining === 0 ? 'ok' : ''}`}
              style={{ marginTop: 8, marginBottom: 0 }}
            />
          )
        })()}
        <div className="row" style={{ marginTop: 8 }}>
          {(participants ?? []).map((p) => {
            const on = focusMode ? focusParticipantId === p.id : scope.some((s) => s.participant_id === p.id)
            const cov = coverage?.get(p.id)
            const evs = cov?.evaluators ?? []
            const title = cov
              ? c('capture.coverage-evaluated', 'label', {
                  count: cov.count,
                  evaluators: evs.join(', ') || c('capture.coverage-unknown'),
                })
              : c('capture.coverage-none')
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
        {/* tl-12: background, one tap away and only for the people actually
            selected. Not a control on every name in the grid — the grid is the
            thing an evaluator is scanning, and a second affordance on 26 buttons
            competes with the one that matters. Nested buttons are also invalid,
            and the coverage cue already lives inside each. */}
        {(() => {
          const selectedIds = focusMode
            ? focusParticipantId
              ? [focusParticipantId]
              : []
            : scope.map((sc) => sc.participant_id)
          const selected = (participants ?? []).filter((p) => selectedIds.includes(p.id))
          if (selected.length === 0) return null
          return (
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {selected.map((p) => (
                <ProfileButton
                  key={p.id}
                  participantId={p.id}
                  name={p.name}
                  workshopId={p.workshop_id}
                  compact
                  label={`${c('capture.profile-open')} · ${p.name}`}
                />
              ))}
            </div>
          )
        })()}
        <Copy
          id={
            instructorReview
              ? 'capture.instructor-help'
              : focusMode
                ? 'capture.focus-help'
                : 'capture.tag-help'
          }
          as="p"
          className="muted small"
          style={{ marginTop: 8 }}
        />
      </div>

      {ksas.map((k) => (
        <div className="card" key={k.id}>
          <label htmlFor={`ksa-${k.id}`} className="ksa-title">
            {k.short_label ? (
              <span
                data-dfb-node={k.id}
                data-dfb-field="short_label"
                data-dfb-source="ref"
                data-dfb-table="ksa"
              >
                {k.short_label}
              </span>
            ) : (
              k.code
            )}
          </label>
          <p
            className="ksa-cue"
            style={{ marginTop: 2 }}
            data-dfb-node={k.id}
            data-dfb-field="evaluator_facing_prompt"
            data-dfb-source="ref"
            data-dfb-table="ksa"
          >
            {k.evaluator_facing_prompt}
          </p>
          {k.guiding_questions && k.guiding_questions.length > 0 && (
            <ul className="muted small" style={{ marginTop: 4 }}>
              {k.guiding_questions.map((q, i) => (
                <li
                  key={q}
                  data-dfb-node={k.id}
                  data-dfb-field={`guiding_questions.${i}`}
                  data-dfb-source="ref"
                  data-dfb-table="ksa"
                >
                  {q}
                </li>
              ))}
            </ul>
          )}
          <textarea
            id={`ksa-${k.id}`}
            value={answers[k.id] ?? ''}
            onChange={(e) => onAnswerChange(k.id, e.target.value)}
            placeholder={c('capture.answer-placeholder')}
          />
          <QuickRating
            ksaId={k.id}
            levels={k.evidence_levels}
            value={quickRatings[k.id]}
            onChange={(level) => onRatingChange(k.id, level)}
          />
        </div>
      ))}

      <div className="card">
        <Copy id="capture.before-submit" as="h2" />
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
          <Copy id="capture.attestation" />
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!attested || !hasContent} onClick={submit}>
            {alreadySubmitted ? c('capture.save-changes') : c('capture.submit')}
          </button>
          {record.edit_history.length > 0 && (
            <button className="ghost" onClick={onUndo}>
              {c('capture.undo')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
