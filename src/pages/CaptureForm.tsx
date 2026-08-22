import { useEffect, useMemo, useRef, useState } from 'react'

import type { ActivityKsaResolved } from '../lib/goals'
import { useNavigate, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasForActivity } from '../db/reference'
import { coverageForActivity } from '../db/coverage'
import { createDraft, repointEvaluation, saveAnswers, submitEvaluation, undoLastEdit } from '../db/evaluations'
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
import { allReviewPairs } from '../db/instructors'
import { rosterForActivity } from '../lib/instructors'
import { captureControls, captureMode, classifyRepoint } from '../lib/capture'
import type { RepointDecision } from '../lib/capture'
import type {
  Activity,
  EvaluationRecord,
  Participant,
  ParticipantScopeEntry,
  QuickRatings,
} from '../lib/types'

/** Short initials for an evaluator email (local-part), e.g. "josh_frost@sil.org" -> "JF". */
function evaluatorInitials(email: string): string {
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const letters = (parts.length >= 2 ? [parts[0], parts[1]] : [local]).map((s) => s[0] ?? '')
  return letters.join('').toUpperCase().slice(0, 2) || '?'
}

/**
 * The capture form for ONE evaluation, handed the row it is about.
 *
 * It deliberately does not read `useParams`. CaptureActivity resolves the row and
 * mounts this keyed on `record.client_id`, so a different capture is a different
 * mount and the state initializers below cannot be holding another capture's
 * answers. That is the structural half of the fix for the Bali report: an
 * evaluator submitted one CIT's evaluation, went to do the next person in the same
 * session, and found the first one's words in the boxes. The route's id is not a
 * second source of truth about which capture this is; `record` is the only one.
 *
 * See lib/capture.ts for why the id has to be checked at all (useLiveQuery hands
 * back the previous row for a render after the id changes).
 */
export function CaptureForm({
  record,
  activity,
  instructorReview,
}: {
  record: EvaluationRecord
  activity: Activity | null
  instructorReview: boolean
}) {
  const navigate = useNavigate()
  const { identity } = useAuth()

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
      if (!record.workshop_id) return [] as Participant[]
      const [roster, pairs] = await Promise.all([
        db.participants.where('workshop_id').equals(record.workshop_id).toArray(),
        allReviewPairs(),
      ])
      return rosterForActivity(activity, roster, pairs, identity?.email, record.workshop_id)
    },
    [record.workshop_id, activity?.id, activity?.audience, identity?.email],
    [] as Participant[],
  )

  // Live evaluation coverage for this activity: who has already received an
  // evaluation, by whom, and how many. Fed by this device's submissions and, via
  // Supabase Realtime, other evaluators' devices (see db/coverage.ts). The
  // live-query repaints the selector automatically when a coverage row lands.
  const coverage = useLiveQuery(
    () => (record.activity_id ? coverageForActivity(record.activity_id) : undefined),
    [record.activity_id],
  )

  // Local working copy so typing is never clobbered by the live query. Seeded by
  // the initializers rather than by a render-phase setState, because the mount is
  // keyed on the record: there is no second capture for this component instance to
  // be reseeded from. `instructorReview` is also settled by now, which the old seed
  // could not rely on — it ran before the activity live query resolved, so a fresh
  // instructor review opened in multi-select against the tl-30 intent.
  const [answers, setAnswers] = useState<Record<string, string>>(record.answers ?? {})
  const [scope, setScope] = useState<ParticipantScopeEntry[]>(record.participant_scope ?? [])
  const [quickRatings, setQuickRatings] = useState<QuickRatings>(record.quick_ratings ?? {})
  const scale = useScale()
  const [focusParticipantId, setFocusParticipantId] = useState<string | null>(
    record.focus_participant_id ?? null,
  )
  const [focusMode, setFocusMode] = useState(
    Boolean(record.focus_participant_id) || instructorReview,
  )
  const [attested, setAttested] = useState(false)
  // A roster tap on a submitted capture waits here until it is confirmed.
  const [pending, setPending] = useState<RepointDecision | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const editRecorded = useRef(false)

  const controls = captureControls(captureMode(record.attestation, correcting))

  useEffect(() => {
    if (record.activity_id) void ksasForActivity(record.activity_id).then(setKsas)
  }, [record.activity_id])

  const persist = (
    next: Record<string, string>,
    overrides: {
      scope?: ParticipantScopeEntry[]
      quick_ratings?: QuickRatings
      focus_participant_id?: string | null
    } = {},
  ) => {
    // After submission, the first change in this correction records an undo snapshot.
    const recordEdit = record.attestation && !editRecorded.current
    if (recordEdit) editRecorded.current = true
    void saveAnswers(record.client_id, next, {
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

  /**
   * One roster handler for both modes. `classifyRepoint` owns the arithmetic AND
   * decides whether the change needs asking about first; this only applies it.
   * They used to be the same expression, which is how a submitted evaluation could
   * change who it was about with nobody deciding to.
   */
  const pick = (p: Participant) => {
    const decision = classifyRepoint({
      submitted: record.attestation,
      instructorReview,
      focusMode,
      scope,
      focusParticipantId,
      target: { id: p.id, name: p.name },
    })
    if (decision.change === 'unchanged') return
    if (decision.confirm) {
      setPending(decision)
      return
    }
    applyPick(decision)
  }

  const applyPick = (decision: RepointDecision) => {
    setScope(decision.nextScope)
    setFocusParticipantId(decision.nextFocusId)
    if (record.attestation) {
      // Not `persist`: a submitted row's coverage has to move with it, and
      // saveAnswers does not touch coverage. See repointEvaluation.
      void repointEvaluation(record.client_id, {
        participant_scope: decision.nextScope,
        focus_participant_id: decision.nextFocusId,
      })
    } else {
      persist(answers, { scope: decision.nextScope, focus_participant_id: decision.nextFocusId })
    }
    setPending(null)
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
    const restored = await undoLastEdit(record.client_id)
    if (restored) setAnswers(restored)
  }

  const hasContent = useMemo(
    () => Object.values(answers).some((v) => v.trim().length > 0),
    [answers],
  )

  /**
   * Submitting stays on this screen, locked, rather than landing on /evaluations.
   *
   * That list is a list of past work, headed by whatever was touched last, and
   * sending an evaluator there to start their NEXT evaluation is what produced the
   * defect: the top row was labelled with the session they were still sitting in,
   * so they opened it and typed over the capture they had just filed. The next
   * person now has a button of their own, right here.
   */
  const submit = async () => {
    const a = answers
    await submitEvaluation(record.client_id, {
      answers: a,
      source_text: composeSourceText(a, ksas, quickRatings),
      participant_scope: scope,
      source_language: record.source_language ?? 'English',
      quick_ratings: quickRatings,
      focus_participant_id: focusParticipantId,
    })
    setCorrecting(false)
    setAttested(false)
    setPending(null)
    editRecorded.current = false
    window.scrollTo({ top: 0 })
  }

  const unlock = () => {
    setCorrecting(true)
    setAttested(false)
    // Per correction, not per mount. Submit no longer unmounts this component, so
    // several corrections in a row would otherwise share one undo snapshot.
    editRecorded.current = false
  }

  const nextPerson = async () => {
    const draft = await createDraft({
      evaluatorEmail: identity?.email ?? null,
      workshopId: record.workshop_id,
      activityId: record.activity_id,
    })
    navigate(`/capture/${draft.client_id}`)
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
        <div className="banner info" role="status">
          <Copy id={controls.bannerId} />
        </div>
        {/* The next action sits in the top card, not under eight textareas. On a
            locked screen there is nothing below to read down to. */}
        {(controls.showUnlock || controls.showNextPerson) && (
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            {controls.showNextPerson && record.activity_id && (
              <Copy
                as="button"
                id={instructorReview ? 'capture.next-instructor' : 'capture.next-person'}
                className="primary"
                onClick={nextPerson}
              />
            )}
            {controls.showUnlock && (
              <Copy as="button" id="capture.unlock" className="ghost" onClick={unlock} />
            )}
          </div>
        )}
        {/* The help sits between the buttons and the link, not after both: on a
            phone the row wraps, and a sentence below the link reads as a
            description of the link. */}
        {controls.showNextPerson && record.activity_id && (
          <Copy id="capture.next-help" as="p" className="muted small" style={{ marginTop: 8 }} />
        )}
        {(controls.showUnlock || controls.showNextPerson) && (
          <div className="row" style={{ marginTop: 4 }}>
            <Link className="small" to="/evaluations">
              {c('capture.see-evaluations')}
            </Link>
          </div>
        )}
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
              then refusing the submit would be the worse of the two.

              Disabled on a submitted capture even while correcting: flipping it
              rewrites the scope wholesale, and there is no honest one-sentence
              confirm for "this drops four of the five people this is about". */}
          {!instructorReview && (
            <button
              type="button"
              className={`rubric-toggle ${focusMode ? 'primary' : ''}`}
              aria-pressed={focusMode}
              disabled={!controls.focusToggleEnabled}
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
                disabled={!controls.rosterEditable}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
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
        {/* Confirmed inline, not in window.confirm and not in a modal: the whole
            value of this sentence is that it names two real people, which a
            browser dialog cannot do (see components/data/ConfirmAction.tsx). */}
        {pending?.confirm && (
          <div className="banner warn" style={{ marginTop: 8 }}>
            <Copy id={pending.confirm.copyId} tokens={pending.confirm.tokens} as="p" style={{ marginTop: 0 }} />
            <div className="row">
              <Copy
                as="button"
                id="capture.repoint.confirm"
                className="primary"
                onClick={() => applyPick(pending)}
              />
              <Copy
                as="button"
                id="capture.repoint.cancel"
                className="ghost"
                onClick={() => setPending(null)}
              />
            </div>
          </div>
        )}
        <Copy
          id={
            !controls.rosterEditable
              ? 'capture.locked-roster-help'
              : instructorReview
                ? 'capture.instructor-help'
                : focusMode
                  ? 'capture.focus-help'
                  : 'capture.tag-help'
          }
          as="p"
          className="muted small"
          style={{ marginTop: 8 }}
        />
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
          {/* readOnly, not disabled: reading a submitted evaluation back, and
              copying a sentence out of it, are things the evaluator legitimately
              wants. A disabled textarea greys its text and refuses selection in
              some browsers, which turns "locked" into "broken".

              autoComplete is off because Chromium and WebKit both restore form
              values on a history navigation or a reload, and this PWA reloads
              itself when a new service worker activates. It is not the cause of
              anything observed here; a controlled input wins that race. */}
          <textarea
            id={`ksa-${k.id}`}
            value={answers[k.id] ?? ''}
            readOnly={!controls.textEditable}
            aria-readonly={!controls.textEditable}
            autoComplete="off"
            onChange={(e) => onAnswerChange(k.id, e.target.value)}
            placeholder={c('capture.answer-placeholder')}
          />
          <QuickRating
            ksaId={k.id}
            levels={k.evidence_levels}
            value={quickRatings[k.id]}
            disabled={!controls.ratingsEditable}
            onChange={(level) => onRatingChange(k.id, level)}
          />
        </div>
      ))}

      {(controls.showSubmit || controls.showUndo) && (
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
            {controls.showSubmit && (
              <button className="primary" disabled={!attested || !hasContent} onClick={submit}>
                {record.attestation ? c('capture.save-changes') : c('capture.submit')}
              </button>
            )}
            {controls.showUndo && record.edit_history.length > 0 && (
              <button className="ghost" onClick={onUndo}>
                {c('capture.undo')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
