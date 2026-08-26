import { useEffect, useRef, useState } from 'react'

import { useNavigate, useParams, Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { ksasInScopeFor, type CaptureScope } from '../db/reference'
import { coverageForActivity, coverageForWorkshop } from '../db/coverage'
import { createDraft, saveAnswers, submitEvaluation, undoLastEdit } from '../db/evaluations'
import {
  canSubmitCapture,
  captureScopeView,
  composeFreeWriteSourceText,
  composeSourceText,
  freeWriteText,
  somebodyLeftToEvaluate,
  FREE_WRITE_KEY,
} from '../lib/compose'
import { FREE_WRITE_INPUT_RULES, INPUT_RULES } from '../lib/ruleset'
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
  // Resolved by ksasInScopeFor: the per-event prompt override is already applied,
  // so this screen shows exactly what the Setup preview and the routing capture file
  // show. That is the point of there being one resolution site (tl-08, tl-36).
  //
  // UNRESOLVED IS ITS OWN STATE, and the distinction is load-bearing in both
  // directions. Free-write mode means "this capture has no questions of its own",
  // and an empty list is also what the first paint holds, so treating the two the
  // same flashes the free-write box onto a per-event capture and the per-event
  // chrome onto a free-write one. That is the flashing refusal tl-30's review had
  // to fix, twice over.
  //
  // KEYED, rather than reset when the inputs change, which is the same fix the
  // vault's `uselivequery-stale-across-dep-change` note prescribes and the one the
  // lint rule against setState-in-an-effect leaves available. A resolution is
  // stored with the exact inputs that produced it, so a stale one is simply not
  // "resolved" and there is no window in which this screen renders a mode that
  // belongs to a different capture. Clearing it in the effect would have been a
  // synchronous setState in an effect body, and would still have painted one frame
  // of the old mode first.
  //
  // 'error' is a THIRD state, not a resolved scope: see the resolver's catch.
  const [resolvedScope, setResolvedScope] = useState<{
    key: string
    scope: CaptureScope | 'error'
  } | null>(null)
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
  /**
   * Who has already been evaluated, and by whom.
   *
   * TWO SCOPES, because a free-write capture has no session to be counted against
   * (tl-36, from the review). `coverageForActivity` keys on `activity_id`, and a
   * free-write capture's coverage row carries null there, which IndexedDB does not
   * index at all — so on the free-write screen the per-session query returns
   * nothing and every name in the grid would read as never evaluated. Worse, if
   * free-write becomes the path people actually use, which is this spec's whole
   * purpose, the cue that spreads twenty-four participants' attention evenly goes
   * dark.
   *
   * So the free-write screen asks the question it can actually answer: has this
   * person been evaluated in this workshop at all. That is also the more useful
   * question on a capture that is not about one session. The per-session screens
   * keep their own scope unchanged, and a free-write capture correctly does not
   * count toward any session's quota.
   */
  const coverage = useLiveQuery(
    () =>
      record?.activity_id
        ? coverageForActivity(record.activity_id)
        : record?.workshop_id
          ? coverageForWorkshop(record.workshop_id)
          : undefined,
    [record?.activity_id, record?.workshop_id],
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
  /**
   * What just happened on this screen, and whether there is anybody left here.
   *
   * Null until this evaluator submits or saves; the submit row is showing then.
   * Set afterwards, which is what replaced `navigate('/evaluations')`: the old
   * behaviour threw somebody who had just written something onto a list of what
   * they had already written, which is the one screen with no way onward.
   *
   * `more` is decided ONCE, inside `submit`, and that is not laziness.
   * `submitEvaluation` fires `upsertCoverage` as a `void` call, so a value
   * recomputed on render would paint "evaluate someone else" and then take it away
   * a tick later, under the thumb about to tap it. This is also why the state is
   * one object rather than two: the kind and the offer are decided together, from
   * the same instant.
   *
   * Local, so it does not survive a remount. The capture route is keyed on the
   * client id (App.tsx), so opening another capture starts with the panel gone,
   * which is correct: the choice belongs to the submit that produced it.
   */
  const [done, setDone] = useState<{ kind: 'submitted' | 'saved'; more: boolean } | null>(null)

  // Keyed on the record's own ids rather than on the record, so typing (which
  // rewrites the row on every keystroke through `persist`) does not re-resolve the
  // question set underneath the person writing.
  const recordId = record?.client_id
  const recordActivityId = record?.activity_id ?? null
  const recordWorkshopId = record?.workshop_id ?? null
  // The stored marker, so a submitted free-write capture stays one however the
  // wiring is edited afterwards. Read off the record inside the resolver; see the
  // note on `scopeKey` for why the prose itself is not part of the key.
  const recordRuleset = record?.ruleset_version ?? null
  // Whether the box already holds prose is deliberately NOT in this key, and the second review
  // is why. It flips false to true on the first keystroke into the box, which would
  // re-run the resolver mid-sentence for an answer that cannot change: the screen is
  // already free-write, and the marker exists to KEEP that mode at the next mount,
  // where it is read at first paint anyway. Its only effect here would be to give a
  // settled screen one way to fall into the error banner while somebody is typing.
  const scopeKey = `${recordId ?? ''}|${recordActivityId ?? ''}|${recordWorkshopId ?? ''}|${recordRuleset ?? ''}`
  const { resolved, scopeError, ksas, freeWrite } = captureScopeView(resolvedScope, scopeKey)
  useEffect(() => {
    if (!recordId) return
    let live = true
    void ksasInScopeFor({
      activity_id: recordActivityId,
      workshop_id: recordWorkshopId,
      answers: record?.answers,
      ruleset_version: recordRuleset,
    })
      .then((s) => {
        if (live) setResolvedScope({ key: scopeKey, scope: s })
      })
      .catch((e) => {
        /**
         * FAILING IS ITS OWN STATE, and the re-review of this spec is why.
         *
         * The first version of this handler resolved to `{ksas: [], freeWrite:
         * false}` so that the screen could never sit blank. On a per-session
         * capture that reads as "resolved, and this session has no questions",
         * which renders no question cards while `hasContent` still counts the
         * stored answers, so submit was ENABLED and "Save changes" would have
         * written `composeSourceText`'s empty string over a real `source_text`.
         * `listPendingCaptures` filters on `source_text.trim()`, so the capture
         * would then never route and nothing would say why. A rescue that permits
         * a destructive write is worse than the blank screen it replaced, and this
         * one landed on the path everybody is using this week.
         */
        console.error('[honest-eval] could not resolve the capture question set', e)
        if (live) setResolvedScope({ key: scopeKey, scope: 'error' })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, recordId, recordActivityId, recordWorkshopId])

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
    // Changing anything is a decision to keep working on THIS capture, so the
    // "what next" panel gives way and the save button comes back. Every content
    // mutation on this screen funnels through here, which is why the clear lives
    // here and not in each of the six handlers.
    setDone(null)
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
    // Same reading as any other change: they are still working on this one.
    setDone(null)
  }

  /**
   * Enough to submit.
   *
   * Free-write has its own check because it has its own promise (tl-36). The
   * printed sentence is "write what you saw, name the people it is about", and
   * both halves are load-bearing: prose with nobody named routes into
   * observations attributed to nobody, which is the shape `audit-mistagged.mjs`
   * found three submitted captures already in. Per-question capture keeps its old
   * rule, unchanged, because a whole-group remark under a named question is a
   * legitimate thing an evaluator has been doing all week.
   */
  const hasContent = freeWrite
    ? freeWriteText(answers).trim().length > 0
    : Object.values(answers).some((v) => v.trim().length > 0)
  const namedSomebody = scope.length > 0
  /**
   * Submit waits for the question set, and that is not caution.
   *
   * Before it resolves, `freeWrite` reads false, so a REOPENED free-write capture
   * would take the per-question compose path over text stored under a key no
   * question owns, and write an empty `source_text` over real prose. The write
   * would succeed, `listPendingCaptures` filters on `source_text.trim()`, and the
   * capture would simply never route. Nothing would report an error.
   */
  const canSubmit = canSubmitCapture({
    resolved,
    scopeError,
    hasContent,
    freeWrite,
    namedSomebody,
    hasQuestions: ksas.length > 0,
  })

  const submit = async () => {
    // Both decisions are read BEFORE the await, and both have to be.
    //
    // `alreadySubmitted` comes off a live query that flips to true the moment the
    // write lands, so afterwards every submit would look like a save and the panel
    // would never once say "Submitted".
    //
    // `more` is frozen for the same reason from the other direction: the write
    // fires `upsertCoverage` as a `void` call, so a value recomputed on render
    // would paint "evaluate someone else in this session" and then take it away a
    // tick later, under the thumb already moving toward it.
    const wasSubmitted = alreadySubmitted
    const more = somebodyLeftToEvaluate({
      freeWrite,
      evaluatorEmail: identity?.email ?? null,
      participantIds: (participants ?? []).map((p) => p.id),
      // Filtered, not asserted: a scope entry may name somebody with no roster id
      // at all, which is the same guard `coverageRowFromEvaluation` applies.
      justCovered: [
        ...scope.map((s) => s.participant_id).filter((id): id is string => Boolean(id)),
        ...(focusParticipantId ? [focusParticipantId] : []),
      ],
      coverage,
    })
    const a = answers
    await submitEvaluation(clientId, {
      answers: a,
      source_text: freeWrite ? composeFreeWriteSourceText(a) : composeSourceText(a, ksas, quickRatings),
      participant_scope: scope,
      source_language: record?.source_language ?? 'English',
      quick_ratings: quickRatings,
      focus_participant_id: focusParticipantId,
      freeWrite,
    })
    setDone({ kind: wasSubmitted ? 'saved' : 'submitted', more })
  }

  /**
   * Another capture for the session they never left.
   *
   * The same two lines as `EvaluatorHome.start`, carrying this record's activity
   * and workshop rather than making somebody re-pick the session they are sitting
   * in. `createDraft` re-resolves `subject_kind` from the activity, so an
   * instructor review produces another instructor review and `evaluation_insert`
   * accepts it; a free-write capture carries a null activity and produces another
   * free-write.
   */
  const another = async () => {
    const draft = await createDraft({
      evaluatorEmail: identity?.email ?? null,
      workshopId: record?.workshop_id ?? null,
      activityId: record?.activity_id ?? null,
    })
    navigate(`/capture/${draft.client_id}`)
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

  /**
   * The mirror of the flash this spec already fixed, found by its review.
   *
   * Until the question set resolves, `freeWrite` reads false, so a free-write
   * capture would paint the per-session chrome for a frame or two: the coverage
   * line this commit removed, the focus toggle it hides, and the per-question
   * input rules including "one activity per capture", which is the rule the box
   * exists to break. The one-frame version of a screen is still a screen.
   *
   * Safe to return null: the effect always settles, and a settlement that FAILED
   * is handled by the branch directly above rather than by this one. So the only
   * way to sit here is the moment before the two Dexie reads come back.
   */
  if (scopeError) {
    return (
      <div className="banner warn">
        <Copy id="capture.scope-error" /> <Link to="/">{c('capture.not-found.link')}</Link>
      </div>
    )
  }

  if (!resolved) {
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
            c(freeWrite ? 'capture.free-write-title' : 'capture.activity-fallback')
          )}
        </h1>
        <div className="banner info">
          <Copy id={alreadySubmitted ? 'capture.submitted-banner' : 'capture.dictation-hint'} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Copy
            id={freeWrite ? 'capture.free-write-rules-short' : 'capture.input-rules-short'}
            className="muted small"
          />
          <Glossary />
        </div>
      </div>

      {/* ORDER MATTERS HERE, and the phone screenshot is what showed it. The
          promise reads "write what you saw, name the people it is about", in that
          sequence, and on a 390px screen the roster of twenty-six names pushed the
          box about eleven hundred pixels down the page. An evaluator who has just
          watched something and opened the app to get it down would meet a wall of
          buttons first, which is the shape of the intimidation this spec exists to
          remove. The per-session capture keeps its original order, where the grid
          before the questions is right: there you are picking a person to answer
          questions about. */}
      {/* tl-36. One box, and a printed promise about what happens to it. No
          per-question prompt, no guiding-question list, no rating chips: the whole
          finding was that an evaluator watching a room cannot recall, classify,
          phrase and score in one sitting, so the classifying moves to the router.
          The questions themselves are unchanged and still in Setup; what changed
          is where the work of matching prose to them happens.

          Rendered only once `questionScope` has resolved, so a per-event capture
          never flashes this box on its first paint. */}
      {freeWrite && (
        <div className="card">
          <Copy id="capture.free-write-promise" as="p" className="free-write-promise" />
          <textarea
            id="free-write"
            className="free-write-box"
            value={freeWriteText(answers)}
            onChange={(e) => onAnswerChange(FREE_WRITE_KEY, e.target.value)}
            placeholder={c('capture.free-write-placeholder')}
            rows={12}
          />
          {/* The question set is stated rather than asked. An evaluator who wants
              to know what the app will try to file their words against can see it;
              it is not a form to fill in. */}
          {ksas.length > 0 && (
            <details className="day-fold" style={{ marginTop: 8 }}>
              <summary>
                {c('capture.free-write-questions')} <span className="n-badge">{ksas.length}</span>
              </summary>
              <ul className="muted small" style={{ marginTop: 8 }}>
                {ksas.map((k) => (
                  <li key={k.id}>
                    <strong>{k.short_label || k.code}</strong>
                    {k.evaluator_facing_prompt ? ` — ${k.evaluator_facing_prompt}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {ksas.length === 0 && (
            <Copy id="capture.free-write-no-questions" as="p" className="muted small" />
          )}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Copy
            id={
              instructorReview
                ? 'capture.instructor-prompt'
                : freeWrite
                  ? 'capture.free-write-watching'
                  : 'capture.watching-prompt'
            }
            as="label"
            style={{ margin: 0 }}
          />
          {/* No focus toggle on an instructor review: focus is not a preference
              there, it is the shape the record must have. Offering the button and
              then refusing the submit would be the worse of the two.

              None on a free-write either (tl-36), for the opposite reason: the
              printed promise is "name the people it is about", plural, and one
              box of prose about four people is the case the spec exists for. A
              free-write about one person is that box with one name ticked. */}
          {!instructorReview && !freeWrite && (
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
          // And it is a PER-SESSION idea (tl-36). `coverageForActivity` needs an
          // activity id, so on a free-write capture it resolves to nothing and the
          // arithmetic below printed "26 of 26 still need evaluation" over no data
          // at all — a whole-workshop claim derived from an empty map, on a screen
          // where every one of the 26 may in fact have been evaluated today. Found
          // by opening the screenshot, which is the only thing that could see it.
          if (freeWrite) return null
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
              : c(freeWrite ? 'capture.coverage-none-workshop' : 'capture.coverage-none')
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
              : freeWrite
                ? 'capture.free-write-tag-help'
                : focusMode
                  ? 'capture.focus-help'
                  : 'capture.tag-help'
          }
          as="p"
          className="muted small"
          style={{ marginTop: 8 }}
        />
      </div>

      {!freeWrite && ksas.map((k) => (
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
        {/* tl-36. The free-write list, not a filtered copy of the other one.
            Two of the four per-question rules are false of this capture and one is
            its exact opposite ("one activity per capture" is what the box exists to
            stop asking for), so printing them here would have every evaluator
            attesting to a rule the same screen had just told them to break. Caught
            by rendering the screen, not by reading the code. */}
        <ul className="small muted">
          {(freeWrite ? FREE_WRITE_INPUT_RULES : INPUT_RULES).map((r) => (
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
        {/* tl-36: a disabled primary button with no explanation is how the app
            teaches an evaluator that it is broken. Say which half is missing. */}
        {freeWrite && hasContent && !namedSomebody && (
          <Copy id="capture.free-write-needs-name" as="p" className="muted small" />
        )}
        {/* The choice lands WHERE THE BUTTON WAS, and that is the whole point of
            doing it inline rather than as a screen of its own. The submit button
            sits at the bottom of a form that is eleven hundred pixels long on a
            phone; a confirmation anywhere else is a confirmation nobody scrolls
            back up to read. The thumb is already here.

            Two lines, not three. The card at the top of the screen has already
            said the capture can be edited and corrected, and the first draft of
            this banner said it again — plus "below", pointing down at the end of
            the page. Found by rendering it at 390px. This one says what happened
            and lets the buttons say what is on offer. */}
        {done ? (
          <div role="status" aria-live="polite" style={{ marginTop: 12 }}>
            <div className="banner info">
              <Copy id={done.kind === 'saved' ? 'capture.done.saved' : 'capture.done.submitted'} />
            </div>
            <div className="row">
              {done.more && (
                <button className="primary" onClick={another}>
                  {c(freeWrite ? 'capture.done.another-free-write' : 'capture.done.another')}
                </button>
              )}
              <button className="ghost" onClick={() => navigate('/')}>
                {c('capture.done.home')}
              </button>
              {/* Undo survives into this state on purpose: "I have just saved a
                  change I regret" is a thing somebody thinks while reading the
                  panel, and it does not go through `persist`, so nothing else
                  would bring the button back. */}
              {record.edit_history.length > 0 && (
                <button className="ghost" onClick={onUndo}>
                  {c('capture.undo')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!attested || !canSubmit} onClick={submit}>
              {alreadySubmitted ? c('capture.save-changes') : c('capture.submit')}
            </button>
            {record.edit_history.length > 0 && (
              <button className="ghost" onClick={onUndo}>
                {c('capture.undo')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
