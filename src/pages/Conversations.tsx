import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import {
  reconcileMentoringConversations,
  scheduleConversation,
  completeConversation,
  dismissConversation,
} from '../db/mentoring'
import { useAuth } from '../auth/AuthContext'
import { Copy } from '../components/Copy'
import type { MentoringConversation } from '../lib/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  // Dates are stored as ISO date strings (YYYY-MM-DD) or ISO timestamps.
  const d = new Date(iso)
  return d.toLocaleDateString([], { dateStyle: 'medium' })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ScheduleFormProps {
  conv: MentoringConversation
  onDone: () => void
}

function ScheduleForm({ conv, onDone }: ScheduleFormProps) {
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
      <label htmlFor={`date-${conv.id}`}>Schedule date</label>
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
          {saving ? 'Saving…' : 'Set date'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

interface CompleteFormProps {
  conv: MentoringConversation
  defaultRecordedBy: string
  onDone: () => void
}

function CompleteForm({ conv, defaultRecordedBy, onDone }: CompleteFormProps) {
  const [summary, setSummary] = useState(conv.summary ?? '')
  const [response, setResponse] = useState(conv.participant_response ?? '')
  const [recordedBy, setRecordedBy] = useState(defaultRecordedBy)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    await completeConversation(conv.id, {
      summary,
      participant_response: response,
      recorded_by: recordedBy,
    })
    setSaving(false)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: '0.5rem' }}>
      <label htmlFor={`summary-${conv.id}`}>Summary</label>
      <textarea
        id={`summary-${conv.id}`}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="What was discussed?"
        required
        style={{ marginBottom: '0.5rem' }}
      />
      <label htmlFor={`response-${conv.id}`}>Participant response</label>
      <textarea
        id={`response-${conv.id}`}
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="How did they respond?"
        style={{ marginBottom: '0.5rem' }}
      />
      <label htmlFor={`recorded-${conv.id}`}>Recorded by</label>
      <input
        id={`recorded-${conv.id}`}
        type="text"
        value={recordedBy}
        onChange={(e) => setRecordedBy(e.target.value)}
        style={{ marginBottom: '0.5rem' }}
      />
      <div className="row">
        <button type="submit" className="primary" disabled={saving || !summary}>
          {saving ? 'Saving…' : 'Mark complete'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Conversation card
// ---------------------------------------------------------------------------

interface ConvCardProps {
  conv: MentoringConversation
  defaultRecordedBy: string
}

function ConvCard({ conv, defaultRecordedBy }: ConvCardProps) {
  const [action, setAction] = useState<'schedule' | 'complete' | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // tl-05 shows the guidance here in its plainest form so an assigned evaluator
  // is not asked to hold a hard conversation with less than the admin knew. The
  // full treatment — the triggering evidence beside it, and a stamp when the
  // guidance changed after they last looked — is tl-06's.

  const handleDismiss = async () => {
    setDismissing(true)
    await dismissConversation(conv.id)
    setDismissing(false)
  }

  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default' }}>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <span>
          <strong>{conv.participant_name}</strong>
          <span className="muted small"> · {conv.trigger_ksa_code ?? 'KSA'}</span>
          {conv.trigger_designation !== null && (
            <span className="pill" style={{ marginLeft: '0.4rem' }}>{conv.trigger_designation}/3</span>
          )}
        </span>
        <span className="spacer" />
        {conv.status === 'needed' && (
          <span className="pill queued">needed</span>
        )}
        {conv.status === 'scheduled' && (
          <span className="pill" style={{ color: 'var(--accent)', borderColor: '#bfdbfe', background: '#eff6ff' }}>
            scheduled {fmtDate(conv.scheduled_for)}
          </span>
        )}
        {conv.status === 'completed' && (
          <span className="pill synced">done</span>
        )}
        {conv.status === 'dismissed' && (
          <span className="pill local">dismissed</span>
        )}
      </div>

      {conv.admin_guidance && (
        <div className="banner info" style={{ margin: '0.5rem 0' }}>
          <div className="small" style={{ fontWeight: 600 }}>
            <Copy id="conversations.mine.guidance-title" />
          </div>
          <p className="small" style={{ margin: '0.25rem 0 0' }}>
            {conv.admin_guidance}
          </p>
        </div>
      )}

      {conv.status === 'completed' && conv.summary && (
        <p className="small muted" style={{ margin: '0.25rem 0' }}>{conv.summary}</p>
      )}
      {conv.status === 'completed' && conv.participant_response && (
        <p className="small muted" style={{ margin: '0.25rem 0' }}>
          <em>Response:</em> {conv.participant_response}
        </p>
      )}

      {(conv.status === 'needed' || conv.status === 'scheduled') && action === null && (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button className="primary" style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }} onClick={() => setAction('complete')}>
            Log conversation
          </button>
          <button style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }} onClick={() => setAction('schedule')}>
            {conv.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
          </button>
          <button
            style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem', color: 'var(--muted)' }}
            onClick={handleDismiss}
            disabled={dismissing}
          >
            Dismiss
          </button>
        </div>
      )}

      {action === 'schedule' && (
        <ScheduleForm conv={conv} onDone={() => setAction(null)} />
      )}
      {action === 'complete' && (
        <CompleteForm conv={conv} defaultRecordedBy={defaultRecordedBy} onDone={() => setAction(null)} />
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
  const [reconciling, setReconciling] = useState(false)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)

  // Derive 'needed' rows from confirmed-low observations once on mount.
  useEffect(() => {
    void reconcileMentoringConversations()
  }, [])

  // tl-05: yours, not everybody's.
  //
  // This page used to list every conversation on the device, which is what
  // Joshua's feedback objected to first — an evaluator opening it found the whole
  // workshop's follow-ups, including participants they had never met. RLS narrows
  // what the backend returns, but it cannot narrow this page on its own: every
  // device DERIVES conversations locally from the observations it holds, and an
  // evaluator holds the workshop's observations because they have to verify them.
  // So the filter is here as well as in the database, and the two agree.
  //
  // An admin sees their own assigned conversations here too, and the full queue at
  // /admin/conversations. One page per question rather than one page that changes
  // shape depending on who is looking at it.
  const conversations = useLiveQuery(
    () =>
      myEmail
        ? db.mentoringConversations
            .where('assigned_to')
            .equals(myEmail)
            .toArray()
            .then((rows) =>
              rows.sort((a, b) =>
                a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
              ),
            )
        : Promise.resolve([] as MentoringConversation[]),
    [myEmail],
    [] as MentoringConversation[],
  )

  const needed = (conversations ?? []).filter((c) => c.status === 'needed')
  const scheduled = (conversations ?? []).filter((c) => c.status === 'scheduled')
  const completed = (conversations ?? []).filter((c) => c.status === 'completed')
  const dismissed = (conversations ?? []).filter((c) => c.status === 'dismissed')

  const handleReconcile = async () => {
    setReconciling(true)
    setReconcileMsg(null)
    const { added } = await reconcileMentoringConversations()
    setReconcileMsg(added > 0 ? `Found ${added} new conversation${added === 1 ? '' : 's'}.` : 'No new conversations found.')
    setReconciling(false)
  }

  const defaultRecordedBy = identity?.email ?? ''

  return (
    <>
      <div className="card">
        <h1>
          <Copy id="conversations.mine.title" />
        </h1>
        <p className="small muted">
          <Copy id="conversations.mine.intro" />
        </p>
        <div className="row">
          <button onClick={handleReconcile} disabled={reconciling}>
            {reconciling ? 'Checking…' : 'Reconcile'}
          </button>
          {reconcileMsg && <span className="small muted">{reconcileMsg}</span>}
        </div>
      </div>

      {(conversations ?? []).length === 0 && (
        <div className="banner info">
          <Copy id="conversations.mine.empty" />
        </div>
      )}

      {needed.length > 0 && (
        <div className="card">
          <h2>Needed</h2>
          <p className="small muted" style={{ marginBottom: '0.5rem' }}>
            Confirmed low observations that need a follow-up conversation.
          </p>
          {needed.map((c) => (
            <ConvCard key={c.id} conv={c} defaultRecordedBy={defaultRecordedBy} />
          ))}
        </div>
      )}

      {scheduled.length > 0 && (
        <div className="card">
          <h2>Scheduled</h2>
          <p className="small muted" style={{ marginBottom: '0.5rem' }}>
            Conversations with a date set; not yet logged as completed.
          </p>
          {scheduled.map((c) => (
            <ConvCard key={c.id} conv={c} defaultRecordedBy={defaultRecordedBy} />
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div className="card">
          <h2>Completed</h2>
          {completed.map((c) => (
            <ConvCard key={c.id} conv={c} defaultRecordedBy={defaultRecordedBy} />
          ))}
        </div>
      )}

      {dismissed.length > 0 && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>Dismissed</h2>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setShowDismissed((v) => !v)}>
              {showDismissed ? 'hide' : `show dismissed (${dismissed.length})`}
            </button>
          </div>
          {showDismissed &&
            dismissed.map((c) => (
              <ConvCard key={c.id} conv={c} defaultRecordedBy={defaultRecordedBy} />
            ))}
        </div>
      )}

    </>
  )
}
