import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newId } from '../../db/local'
import { deleteActivity, upsertActivity } from '../../db/referenceWrite'
import { c } from '../../lib/content/chrome'
import type { Activity, Workshop } from '../../lib/types'
import { countsForEvent } from '../counts'
import { diffFields } from '../impact'
import { useSetupSave } from '../useSetupSave'
import { fromLocalInput, toLocalInput } from './datetime'

/**
 * The calendar: the events an evaluator picks from.
 *
 * Moved here from the Scenario Builder rather than reimplemented — one editor per
 * entity, or the two diverge and reconciling them becomes somebody's afternoon.
 * What changed in the move is the save path: every write now goes through
 * useSetupSave(), so it is classified and logged.
 *
 * The fields still save on blur, and that is legitimate: the classifier calls every
 * field on an event `safe`, because none of them is a value an observation was
 * scored against. Deleting an event is the change that costs, and it is the one
 * with an explicit confirm in front of it.
 */
export function EventsSection({ workshop }: { workshop: Workshop }) {
  const { request, busy } = useSetupSave()
  const activities = useLiveQuery(
    () => db.activities.where('workshop_id').equals(workshop.id).sortBy('sort_order'),
    [workshop.id],
    [] as Activity[],
  )

  const addEvent = async () => {
    const maxSort = (activities ?? []).reduce((m, a) => Math.max(m, a.sort_order), -1)
    const event: Activity = {
      id: newId(),
      workshop_id: workshop.id,
      title: 'New event',
      day: workshop.start_date,
      start_time: null,
      end_time: null,
      sort_order: maxSort + 1,
      genre_group: null,
    }
    await request({
      change: {
        entity: 'event',
        operation: 'create',
        entityId: event.id,
        label: event.title,
      },
      commit: () => upsertActivity(event),
    })
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{c('setup.events.title', 'label', { count: (activities ?? []).length })}</h2>
        <button disabled={busy} onClick={() => void addEvent()}>
          {c('setup.events.add')}
        </button>
      </div>
      <p className="small muted">{c('setup.events.help')}</p>
      {(activities ?? []).length === 0 && <p className="small muted">{c('setup.events.empty')}</p>}
      {(activities ?? []).map((a) => (
        <EventEditor key={a.id} activity={a} workshopId={workshop.id} />
      ))}
    </div>
  )
}

function EventEditor({ activity, workshopId }: { activity: Activity; workshopId: string }) {
  const { request, busy } = useSetupSave()
  const [confirmArmed, setConfirmArmed] = useState(false)

  // Save on blur, but through the classifier. A field whose class ever rises above
  // `safe` must move to an explicit Save button; the classifier is what tells you,
  // and routing even the safe saves through here means there is exactly one write
  // path to audit rather than two.
  const save = (patch: Partial<Activity>) =>
    request({
      change: {
        entity: 'event',
        operation: 'update',
        entityId: activity.id,
        label: activity.title,
        fields: diffFields(activity, { ...activity, ...patch }),
      },
      commit: () => upsertActivity({ ...activity, ...patch }),
    })

  const remove = async () => {
    setConfirmArmed(false)
    const counts = await countsForEvent(activity.id, workshopId)
    await request({
      change: {
        entity: 'event',
        operation: 'delete',
        entityId: activity.id,
        label: activity.title,
        counts,
      },
      commit: () => deleteActivity(activity.id),
    })
  }

  return (
    <div
      className="activity-item"
      style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}
    >
      <div className="row">
        <input
          defaultValue={activity.title}
          onBlur={(e) => void save({ title: e.target.value })}
          style={{ flex: 1 }}
          aria-label="Event title"
        />
        {!confirmArmed ? (
          <button className="ghost small" disabled={busy} onClick={() => setConfirmArmed(true)}>
            {c('setup.action.delete')}
          </button>
        ) : (
          <>
            <button className="small" disabled={busy} onClick={() => void remove()}>
              {c('setup.action.delete-continue')}
            </button>
            <button className="ghost small" onClick={() => setConfirmArmed(false)}>
              {c('setup.action.cancel')}
            </button>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: '0.3rem', flexWrap: 'wrap' }}>
        <span>
          <label className="small muted">Day</label>
          <input
            type="date"
            defaultValue={activity.day ?? ''}
            onBlur={(e) => void save({ day: e.target.value || null })}
          />
        </span>
        <span>
          <label className="small muted">Start</label>
          <input
            type="datetime-local"
            defaultValue={toLocalInput(activity.start_time)}
            onBlur={(e) => void save({ start_time: fromLocalInput(e.target.value) })}
          />
        </span>
        <span>
          <label className="small muted">End</label>
          <input
            type="datetime-local"
            defaultValue={toLocalInput(activity.end_time)}
            onBlur={(e) => void save({ end_time: fromLocalInput(e.target.value) })}
          />
        </span>
      </div>
      <div className="row" style={{ marginTop: '0.3rem' }}>
        <span>
          <label className="small muted">Genre / group</label>
          <input
            defaultValue={activity.genre_group ?? ''}
            onBlur={(e) => void save({ genre_group: e.target.value || null })}
          />
        </span>
        <span>
          <label className="small muted">Order</label>
          <input
            type="number"
            defaultValue={activity.sort_order}
            onBlur={(e) => void save({ sort_order: Number(e.target.value) || 0 })}
            style={{ width: '5rem' }}
          />
        </span>
      </div>
    </div>
  )
}
