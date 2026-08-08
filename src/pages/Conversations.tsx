import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import {
  compareForAssignee,
  conversationEvidence,
  guidanceChangedSince,
  isOpenConversation,
  scheduleConversation,
  completeConversation,
} from '../db/mentoring'
import { annotateObservations } from '../reports/verification'
import type { AnnotatedObservation } from '../reports/verification'
import { useAuth } from '../auth/AuthContext'
import { Copy } from '../components/Copy'
import { c } from '../lib/content/chrome'
import { EvidenceList } from '../components/admin/EvidenceList'
import { DEFAULT_SCALE, buildScale, maxValue, type Scale, type ScalePoint } from '../lib/scale'
import { markConversationViewed, readConversationViews } from '../lib/conversationViews'
import type { ConversationViews } from '../lib/conversationViews'
import type { Activity, Ksa, MentoringConversation } from '../lib/types'

/**
 * The assigned evaluator's side of a follow-up conversation.
 *
 * tl-05 gave a conversation an owner and somewhere for the admin to say how it
 * should be opened. This page is the other end of that handover, and Joshua's
 * feedback names what it has to carry: the evidence that called for the
 * conversation, the admin's notes on approaching it, and somewhere to record how
 * it actually went.
 *
 * Three decisions are load-bearing enough to state here.
 *
 * NO RECONCILE. This page used to derive conversations on mount. Derivation is an
 * administrator's act now (tl-05 made insert admin-only in the database, so an
 * evaluator's derived rows were refused anyway), and a device quietly creating
 * queue rows nobody has seen is the wrong ownership even where it works.
 *
 * NO DISMISS. Dropping an assigned conversation is a decision by the person who
 * assigned it. An evaluator who thinks it should be dropped says so through the
 * follow-up note, which their admin actually reads.
 *
 * THE LIST IS "WHAT I OWE", NOT "WHAT EXISTS". Open conversations, unscheduled
 * first; everything finished is folded away. The predicate and the order are
 * imported from db/mentoring so the badge in the sidebar cannot say 2 above a
 * page listing 4.
 */

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { dateStyle: 'medium' })
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

function GuidancePanel({
  conv,
  changed,
}: {
  conv: MentoringConversation
  changed: boolean
}) {
  if (!conv.admin_guidance) {
    return (
      <p className="small muted">
        <Copy id="conversations.mine.guidance-none" />
      </p>
    )
  }
  return (
    <div className="banner info" style={{ margin: '0.5rem 0' }}>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <span className="small" style={{ fontWeight: 600 }}>
          <Copy id="conversations.mine.guidance-title" />
        </span>
        <span className="spacer" />
        {changed && (
          <span className="pill queued">{c('conversations.mine.guidance-changed')}</span>
        )}
      </div>
      {/* Verbatim, and pre-wrapped: an admin who wrote three short paragraphs
          about how to open a hard conversation should not have them collapsed
          into one by the renderer. */}
      <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {conv.admin_guidance}
      </p>
      <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
        {conv.assigned_by
          ? c('conversations.mine.guidance-stamp', 'label', {
              email: conv.assigned_by,
              date: fmtDate(conv.admin_guidance_updated_at) || '—',
            })
          : c('conversations.mine.guidance-stamp-anon', 'label', {
              date: fmtDate(conv.admin_guidance_updated_at) || '—',
            })}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * A question is identified by its workshop AND its code (tl-08 made codes
 * per-workshop, so two workshops may both define EXEG and mean different things).
 * Every lookup on this page goes through this, because the page shows conversations
 * from more than one workshop at a time.
 */
const ksaKey = (workshopId: string | null, code: string) => `${workshopId ?? 'none'}::${code}`

function EvidencePanel({
  conv,
  annotated,
  ksaByCode,
  activityById,
  workshopId,
}: {
  conv: MentoringConversation
  annotated: AnnotatedObservation[]
  ksaByCode: Map<string, Ksa>
  activityById: Map<string, Activity>
  /** THIS conversation's workshop, resolved through its participant when the row is null. */
  workshopId: string | null
}) {
  const { trigger, pattern } = useMemo(
    () => conversationEvidence(conv, annotated),
    [conv, annotated],
  )
  const ksa = conv.trigger_ksa_code
    ? ksaByCode.get(ksaKey(workshopId, conv.trigger_ksa_code))
    : undefined
  const activity = conv.trigger_activity_id ? activityById.get(conv.trigger_activity_id) : undefined

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <h3 className="small" style={{ margin: '0 0 0.25rem' }}>
        <Copy id="conversations.mine.evidence-title" />
      </h3>

      {ksa ? (
        <div className="small" style={{ marginBottom: '0.5rem' }}>
          <strong>
            {conv.trigger_ksa_code} — {ksa.short_label}
          </strong>
          <p className="muted" style={{ margin: '0.15rem 0 0' }}>
            {ksa.evaluator_facing_prompt}
          </p>
        </div>
      ) : (
        conv.trigger_ksa_code && (
          <p className="small" style={{ margin: '0 0 0.5rem' }}>
            <strong>{conv.trigger_ksa_code}</strong>
          </p>
        )
      )}

      <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
        {activity
          ? c('conversations.mine.evidence-activity', 'label', { activity: activity.title })
          : c('conversations.mine.evidence-activity-unknown')}
      </p>

      {/* The partial-sync state is real rather than defensive. tl-04 pushes and
          pulls observations and conversations in the same loop but not in the
          same transaction, so an assignment can land on a phone one cycle before
          the evidence behind it does. Saying that is better than a blank panel
          and much better than a crash. */}
      {trigger === null ? (
        <div className="banner warn">
          <Copy id="conversations.mine.evidence-pending" />
        </div>
      ) : (
        <EvidenceList observations={[trigger]} />
      )}

      <h3 className="small" style={{ margin: '0.75rem 0 0.25rem' }}>
        {c('conversations.mine.pattern-title', 'label', { name: conv.participant_name })}
      </h3>
      {pattern.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          <Copy id="conversations.mine.pattern-empty" />
        </p>
      ) : (
        <EvidenceList observations={pattern} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function ScheduleForm({ conv, onDone }: { conv: MentoringConversation; onDone: () => void }) {
  const [date, setDate] = useState(conv.scheduled_for ?? '')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!date) return
    setSaving(true)
    await scheduleConversation(conv.id, date)
    setSaving(false)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: '0.5rem' }}>
      <label htmlFor={`date-${conv.id}`}>
        <Copy id="conversations.mine.schedule.label" />
      </label>
      <input
        id={`date-${conv.id}`}
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        required
        style={{ marginBottom: '0.5rem' }}
      />
      <div className="row">
        <button type="submit" className="primary" disabled={saving || !date}>
          {saving ? c('conversations.mine.outcome.saving') : c('conversations.mine.schedule.save')}
        </button>
        <button type="button" onClick={onDone}>
          {c('conversations.mine.outcome.cancel')}
        </button>
      </div>
    </form>
  )
}

function OutcomeForm({
  conv,
  recordedBy,
  onDone,
}: {
  conv: MentoringConversation
  recordedBy: string
  onDone: () => void
}) {
  const [summary, setSummary] = useState(conv.summary ?? '')
  const [response, setResponse] = useState(conv.participant_response ?? '')
  const [followUp, setFollowUp] = useState(conv.follow_up_needed === true)
  const [followUpNote, setFollowUpNote] = useState(conv.follow_up_note ?? '')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    await completeConversation(conv.id, {
      summary,
      participant_response: response,
      // No longer a free text field. tl-05 knows who was given this conversation,
      // so asking them to type their own name was asking for a typo in the one
      // column that attributes the record.
      recorded_by: recordedBy || null,
      follow_up_needed: followUp,
      follow_up_note: followUp ? followUpNote : null,
    })
    setSaving(false)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: '0.5rem' }}>
      <h3 className="small" style={{ margin: '0 0 0.25rem' }}>
        <Copy id="conversations.mine.outcome.title" />
      </h3>

      <label htmlFor={`summary-${conv.id}`}>
        <Copy id="conversations.mine.outcome.summary-label" />
      </label>
      <textarea
        id={`summary-${conv.id}`}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={c('conversations.mine.outcome.summary-placeholder')}
        required
        style={{ marginBottom: '0.5rem' }}
      />

      <label htmlFor={`response-${conv.id}`}>
        <Copy id="conversations.mine.outcome.response-label" />
      </label>
      <p className="small muted" style={{ margin: '0 0 0.25rem' }}>
        <Copy id="conversations.mine.outcome.response-help" />
      </p>
      <textarea
        id={`response-${conv.id}`}
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder={c('conversations.mine.outcome.response-placeholder')}
        style={{ marginBottom: '0.5rem' }}
      />

      <label htmlFor={`followup-${conv.id}`} className="row" style={{ gap: '0.4rem' }}>
        <input
          id={`followup-${conv.id}`}
          type="checkbox"
          checked={followUp}
          onChange={(e) => setFollowUp(e.target.checked)}
          style={{ width: 'auto', margin: 0 }}
        />
        <span>{c('conversations.mine.outcome.followup-label')}</span>
      </label>
      <p className="small muted" style={{ margin: '0.15rem 0 0.25rem' }}>
        <Copy id="conversations.mine.outcome.followup-help" />
      </p>
      {followUp && (
        <textarea
          id={`followup-note-${conv.id}`}
          value={followUpNote}
          onChange={(e) => setFollowUpNote(e.target.value)}
          placeholder={c('conversations.mine.outcome.followup-note-placeholder')}
          aria-label={c('conversations.mine.outcome.followup-note-label')}
          style={{ marginBottom: '0.5rem' }}
        />
      )}

      <p className="small muted" style={{ margin: '0.25rem 0 0.5rem' }}>
        {c('conversations.mine.outcome.recorded-by', 'label', { email: recordedBy || '—' })}
      </p>

      <div className="row">
        <button type="submit" className="primary" disabled={saving || !summary}>
          {saving ? c('conversations.mine.outcome.saving') : c('conversations.mine.outcome.save')}
        </button>
        <button type="button" onClick={onDone}>
          {c('conversations.mine.outcome.cancel')}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function StatusPill({ conv }: { conv: MentoringConversation }) {
  if (conv.status === 'scheduled') {
    return (
      <span className="pill" style={{ color: 'var(--accent)', borderColor: '#bfdbfe', background: '#eff6ff' }}>
        {c('conversations.mine.status.scheduled', 'label', { date: fmtDate(conv.scheduled_for) })}
      </span>
    )
  }
  if (conv.status === 'completed') return <span className="pill synced">{c('conversations.mine.status.completed')}</span>
  if (conv.status === 'dismissed') return <span className="pill local">{c('conversations.mine.status.dismissed')}</span>
  return <span className="pill queued">{c('conversations.mine.status.needed')}</span>
}

function ConvCard({
  conv,
  annotated,
  ksaByCode,
  activityById,
  workshopId,
  scale,
  recordedBy,
  expanded,
  onToggle,
  guidanceChanged,
}: {
  conv: MentoringConversation
  annotated: AnnotatedObservation[]
  ksaByCode: Map<string, Ksa>
  activityById: Map<string, Activity>
  /** THIS conversation's workshop, resolved through its participant when the row is null. */
  workshopId: string | null
  /** THIS conversation's workshop's scale, not the active workshop's (tl-29). */
  scale: Scale
  recordedBy: string
  expanded: boolean
  onToggle: () => void
  guidanceChanged: boolean
}) {
  const [action, setAction] = useState<'schedule' | 'complete' | null>(null)
  const open = isOpenConversation(conv)

  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default' }}>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <span>
          <strong>{conv.participant_name}</strong>
          <span className="muted small"> · {conv.trigger_ksa_code ?? 'KSA'}</span>
          {conv.trigger_designation !== null && (
            <span className="pill" style={{ marginLeft: '0.4rem' }}>
              {conv.trigger_designation}/{maxValue(scale)}
            </span>
          )}
        </span>
        <span className="spacer" />
        {guidanceChanged && !expanded && (
          <span className="pill queued">{c('conversations.mine.guidance-changed')}</span>
        )}
        {conv.follow_up_needed === true && (
          <span className="pill error">{c('conversations.mine.followup.flag')}</span>
        )}
        <StatusPill conv={conv} />
        <button className="ghost small" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? c('conversations.mine.close') : c('conversations.mine.open')}
        </button>
      </div>

      {expanded && (
        <>
          <GuidancePanel conv={conv} changed={guidanceChanged} />
          <EvidencePanel
            conv={conv}
            annotated={annotated}
            ksaByCode={ksaByCode}
            activityById={activityById}
            workshopId={workshopId}
          />

          {conv.status === 'completed' && (
            <div style={{ marginTop: '0.75rem' }}>
              <h3 className="small" style={{ margin: '0 0 0.25rem' }}>
                <Copy id="conversations.mine.logged-title" />
              </h3>
              {conv.summary && <p className="small" style={{ margin: 0 }}>{conv.summary}</p>}
              {conv.participant_response && (
                <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
                  {c('conversations.mine.logged-response', 'label', {
                    response: conv.participant_response,
                  })}
                </p>
              )}
              {conv.follow_up_needed === true && (
                <p className="small" style={{ margin: '0.25rem 0 0' }}>
                  <strong>{c('conversations.mine.followup.flag')}.</strong>{' '}
                  {conv.follow_up_note ?? ''}
                </p>
              )}
            </div>
          )}

          {open && action === null && (
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button
                className="primary"
                style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
                onClick={() => setAction('complete')}
              >
                {c('conversations.mine.log')}
              </button>
              <button
                style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
                onClick={() => setAction('schedule')}
              >
                {conv.status === 'scheduled'
                  ? c('conversations.mine.reschedule')
                  : c('conversations.mine.schedule')}
              </button>
            </div>
          )}

          {action === 'schedule' && <ScheduleForm conv={conv} onDone={() => setAction(null)} />}
          {action === 'complete' && (
            // Remounted per conversation and per open, per the Web App Build
            // Protocol's second reliability invariant: a form that clears itself in
            // an effect leaks the previous conversation's summary into the next
            // one, and a summary is exactly the field where that would be believed.
            <OutcomeForm
              key={conv.id}
              conv={conv}
              recordedBy={recordedBy}
              onDone={() => setAction(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Conversations() {
  const { identity } = useAuth()
  const myEmail = identity?.email?.trim().toLowerCase() ?? null
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [views, setViews] = useState<ConversationViews>(() => readConversationViews())

  // Yours, not everybody's (tl-05). RLS narrows what the BACKEND returns, and it
  // cannot narrow this page on its own: every device derives conversations locally
  // from the observations it holds, and an evaluator holds the workshop's
  // observations because verifying them is their job.
  const conversations = useLiveQuery(
    () =>
      myEmail
        ? db.mentoringConversations.where('assigned_to').equals(myEmail).toArray()
        : Promise.resolve([] as MentoringConversation[]),
    [myEmail],
    [] as MentoringConversation[],
  )

  // DELIBERATELY UNSCOPED, and tl-29 tried the other way first (see below).
  //
  // This page is keyed on the evaluator's own assignments, which legitimately span the
  // workshops they work in: tl-25 put real people in two at once. So its labels have to
  // resolve across workshops too. Scoping the questions and events here — which looks
  // like the safe change and is the same one this spec made everywhere else — deleted
  // the question TEXT from every conversation belonging to the workshop the device was
  // not currently switched into, leaving an evaluator a bare code and no prompt on the
  // one screen whose job is to help them hold a hard conversation.
  //
  // Codes are per-workshop since tl-08 and can therefore collide, so the label maps are
  // keyed on `${workshop_id}::${code}` and resolved against each conversation's OWN
  // workshop rather than the active one. That is the honest version of the fix: not a
  // narrower read, a more specific key.
  const observations = useLiveQuery(() => db.observations.toArray(), [], [])
  const verdicts = useLiveQuery(() => db.verifications.toArray(), [], [])
  const ksas = useLiveQuery(() => db.ksas.toArray(), [], [])
  const activities = useLiveQuery(() => db.activities.toArray(), [], [])
  // Only to place a conversation whose own `workshop_id` is null, which is the same
  // third fallback `observationsForWorkshop` has and for the same reason: those rows are
  // real history, and without this one renders a bare question code with no prompt.
  const participants = useLiveQuery(() => db.participants.toArray(), [], [])

  const annotated = useMemo(
    () => annotateObservations(observations ?? [], verdicts ?? []),
    [observations, verdicts],
  )
  const ksaByCode = useMemo(
    () => new Map((ksas ?? []).map((k) => [ksaKey(k.workshop_id, k.code), k])),
    [ksas],
  )
  /**
   * A conversation's workshop, resolved rather than read.
   *
   * `MentoringConversation.workshop_id` is nullable while `Ksa.workshop_id` is not, so a
   * conversation derived from a stranded observation keyed to `none::CODE`, which no
   * question can match: a bare code with no prompt, and a designation printed against
   * the default scale. Its participant places it, exactly as the observation resolver's
   * third fallback does.
   */
  const workshopOfConversation = useMemo(() => {
    const byParticipant = new Map((participants ?? []).map((p) => [p.id, p.workshop_id]))
    return (conv: MentoringConversation): string | null =>
      conv.workshop_id ?? byParticipant.get(conv.participant_id) ?? null
  }, [participants])
  const activityById = useMemo(() => new Map((activities ?? []).map((a) => [a.id, a])), [activities])

  /**
   * A scale per workshop, for the same reason the question lookup is keyed on one: the
   * conversations on this page can come from more than one workshop, and a designation
   * printed against the active workshop's scale is a score labelled by a scale that did
   * not produce it (tl-26's sharpest finding). Falls back to the app default for a
   * workshop that has authored no points.
   */
  const scalePointRows = useLiveQuery(() => db.scalePoints.toArray(), [], [] as ScalePoint[])
  const scaleFor = useMemo(() => {
    const byWorkshop = new Map<string, ScalePoint[]>()
    for (const row of scalePointRows ?? []) {
      const list = byWorkshop.get(row.workshop_id) ?? []
      list.push(row)
      byWorkshop.set(row.workshop_id, list)
    }
    return (workshopId: string | null): Scale => {
      const rows = workshopId ? byWorkshop.get(workshopId) : undefined
      return rows && rows.length > 0 ? buildScale(workshopId, rows) : DEFAULT_SCALE
    }
  }, [scalePointRows])

  // Not `conversations ?? []`: useLiveQuery already carries a default, and the
  // fallback literal would be a new array on every render, so both memos below
  // would recompute forever.
  const mine = conversations
  const open = useMemo(() => mine.filter(isOpenConversation).sort(compareForAssignee), [mine])
  const closed = useMemo(
    () => mine.filter((x) => !isOpenConversation(x)).sort(compareForAssignee),
    [mine],
  )

  const handleToggle = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    // Stamped on open rather than on render, so a card that was never opened keeps
    // its "guidance changed" marker instead of quietly clearing it as the list
    // paints. Written in the handler, not an effect: the mark belongs to the act.
    setViews((v) => markConversationViewed(v, id, new Date().toISOString()))
  }

  const recordedBy = myEmail ?? ''

  const cardProps = (conv: MentoringConversation) => ({
    conv,
    annotated,
    ksaByCode,
    activityById,
    workshopId: workshopOfConversation(conv),
    scale: scaleFor(workshopOfConversation(conv)),
    recordedBy,
    expanded: expandedId === conv.id,
    onToggle: () => handleToggle(conv.id),
    guidanceChanged: guidanceChangedSince(conv, views[conv.id]),
  })

  return (
    <>
      <div className="card">
        <h1>
          <Copy id="conversations.mine.title" />
        </h1>
        <p className="small muted">
          <Copy id="conversations.mine.intro" />
        </p>
      </div>

      <div className="card">
        <h2>
          <Copy id="conversations.mine.open-title" />
        </h2>
        <p className="small muted" style={{ marginBottom: '0.5rem' }}>
          <Copy id="conversations.mine.open-intro" />
        </p>
        {open.length === 0 ? (
          // A finished list, not a broken page: nothing assigned is the ordinary
          // state for most evaluators most days.
          <p className="small muted" style={{ margin: 0 }}>
            <Copy id="conversations.mine.empty" />
          </p>
        ) : (
          open.map((conv) => <ConvCard key={conv.id} {...cardProps(conv)} />)
        )}
      </div>

      {closed.length > 0 && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>
              <Copy id="conversations.mine.closed-title" />
            </h2>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setShowClosed((v) => !v)}>
              {showClosed
                ? c('conversations.mine.closed-hide')
                : c('conversations.mine.closed-show', 'label', { count: closed.length })}
            </button>
          </div>
          {showClosed && closed.map((conv) => <ConvCard key={conv.id} {...cardProps(conv)} />)}
        </div>
      )}
    </>
  )
}
