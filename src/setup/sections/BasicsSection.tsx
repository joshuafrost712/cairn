import { useState } from 'react'
import { Link } from 'react-router-dom'
import { updateWorkshop } from '../../db/admin'
import { deleteWorkshop, duplicateWorkshop, workshopReachedBackend } from '../../db/referenceWrite'
import { useAuth } from '../../auth/AuthContext'
import { mirrorActiveWorkshop } from '../../db/settings'
import { WorkshopSwitcher } from '../../components/WorkshopSwitcher'
import { setActiveWorkshopId } from '../../lib/activeWorkshop'
import { c } from '../../lib/content/chrome'
import { isSupabaseConfigured } from '../../lib/supabase'
import type { Workshop } from '../../lib/types'
import { countsForWorkshop } from '../counts'
import { diffFields } from '../impact'
import { useSetupSave } from '../useSetupSave'

/**
 * Workshop basics: what this workshop is, when it runs, and the duplicate/delete
 * operations on the workshop itself.
 *
 * tl-07 moved the scenario selector here from the Scenario Builder and said tl-17
 * would replace it. It has. Two changes, and both are about there being exactly one
 * of each thing:
 *
 *  - **The `<select>` is the shared `WorkshopSwitcher`**, the same component the
 *    header and the drawer render. Two switching controls can disagree; this one
 *    also lists memberships rather than every cached workshop, so it can no longer
 *    offer a workshop that `resolveActiveWorkshopId` will silently refuse.
 *  - **Create moved to `/workshops`**, where it asks for dates and lands the
 *    administrator in guided setup. Creating a nameless, dateless workshop from a
 *    text box on a settings page was the cheap version, and a workshop with no end
 *    date reads as `draft` forever.
 *
 * Duplicate and delete stay, because they are authoring acts ON this workshop rather
 * than navigation between workshops.
 *
 * Meta is saved by an explicit button, not on blur, because the dates are what decide
 * whether the workshop reads as closed — and that decides whether every OTHER save
 * gets the closed-workshop warning. A field with that reach should not commit because
 * somebody tabbed past it.
 */
export function BasicsSection({ workshop }: { workshop: Workshop | null }) {
  const { request, busy } = useSetupSave()
  const { reloadMemberships } = useAuth()
  const [queued, setQueued] = useState(false)

  /**
   * Duplicate, then wait for the copy to exist server-side before switching into it.
   *
   * The same sequence the create flow on /workshops uses, and for the same reason:
   * the copy's `chief_admin` row comes from a Postgres AFTER INSERT trigger, so
   * switching before the insert lands selects a workshop the memberships do not
   * support and `resolveActiveWorkshopId` throws the selection away.
   *
   * This was invisible until tl-17, because the old scenario `<select>` listed every
   * CACHED workshop: the copy appeared in it, the header changed, and the app looked
   * like it had switched while every workshop-scoped read still pointed at the
   * original. Listing memberships instead is what made the gap show, which is the
   * argument for listing memberships.
   */
  const duplicate = async () => {
    if (!workshop) return
    let created: Workshop | null = null
    const name = `${workshop.name} (copy)`
    setQueued(false)
    await request({
      change: { entity: 'workshop', operation: 'create', entityId: null, label: name },
      commit: async () => {
        created = await duplicateWorkshop(workshop.id, name)
      },
    })
    if (!created) return
    const id = (created as Workshop).id
    if (!(await workshopReachedBackend(id))) {
      setQueued(true)
      return
    }
    await reloadMemberships()
    setActiveWorkshopId(id)
    await mirrorActiveWorkshop(id)
  }

  const remove = async () => {
    if (!workshop) return
    const counts = await countsForWorkshop(workshop.id)
    await request({
      change: {
        entity: 'workshop',
        operation: 'delete',
        entityId: workshop.id,
        label: workshop.name,
        counts,
      },
      commit: async () => {
        await deleteWorkshop(workshop.id)
        setActiveWorkshopId(null)
      },
    })
  }

  return (
    <>
      <div className="card form-col">
        <h2>{c('setup.basics.title')}</h2>
        <p className="small muted">
          {c('setup.basics.help')}{' '}
          {isSupabaseConfigured ? c('setup.basics.backend-shared') : c('setup.basics.backend-local')}
        </p>
        {workshop ? (
          <MetaEditor workshop={workshop} />
        ) : (
          <p className="small muted">{c('setup.basics.none')}</p>
        )}
      </div>

      <div className="card form-col">
        <h2>{c('setup.basics.switch-title')}</h2>
        <p className="small muted">{c('setup.basics.switch-help')}</p>
        <div className="row">
          <WorkshopSwitcher className="switcher switcher--drawer" />
          {workshop && (
            <button className="ghost" disabled={busy} onClick={() => void duplicate()}>
              {c('setup.basics.duplicate')}
            </button>
          )}
        </div>
        {queued && <div className="banner warn">{c('workshops.create.queued')}</div>}
        <p className="small muted">
          <Link to="/workshops">{c('setup.basics.overview-link')}</Link>
        </p>
        {workshop && (
          <div className="row">
            <button className="ghost small" disabled={busy} onClick={() => void remove()}>
              {c('setup.basics.delete', 'label', { label: workshop.name })}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

function MetaEditor({ workshop }: { workshop: Workshop }) {
  const { request, busy } = useSetupSave()
  const [draft, setDraft] = useState<Workshop>(workshop)
  const dirty = JSON.stringify(draft) !== JSON.stringify(workshop)

  const save = () =>
    request({
      change: {
        entity: 'workshop',
        operation: 'update',
        entityId: workshop.id,
        label: workshop.name,
        fields: diffFields(workshop, draft),
      },
      commit: () => updateWorkshop(workshop.id, draft),
    })

  return (
    <>
      <label className="small muted" htmlFor="ws-name">
        Name
      </label>
      <input
        id="ws-name"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span>
          <label className="small muted" htmlFor="ws-start">
            Starts
          </label>
          <input
            id="ws-start"
            type="date"
            value={draft.start_date ?? ''}
            onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })}
          />
        </span>
        <span>
          <label className="small muted" htmlFor="ws-end">
            Ends
          </label>
          <input
            id="ws-end"
            type="date"
            value={draft.end_date ?? ''}
            onChange={(e) => setDraft({ ...draft, end_date: e.target.value || null })}
          />
        </span>
        <span style={{ flex: 1 }}>
          <label className="small muted" htmlFor="ws-location">
            Location
          </label>
          <input
            id="ws-location"
            value={draft.location ?? ''}
            onChange={(e) => setDraft({ ...draft, location: e.target.value || null })}
            style={{ width: '100%' }}
          />
        </span>
      </div>
      <label className="small muted" htmlFor="ws-langs">
        {c('setup.basics.languages')}
      </label>
      <input
        id="ws-langs"
        value={(draft.languages ?? []).join(', ')}
        onChange={(e) =>
          setDraft({
            ...draft,
            languages: e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
      <p className="small muted">{c('setup.basics.end-date-note')}</p>
      <div className="row">
        <button disabled={busy || !dirty} onClick={() => void save()}>
          {c('setup.basics.save')}
        </button>
        <button className="ghost small" disabled={!dirty} onClick={() => setDraft(workshop)}>
          {c('setup.action.reset')}
        </button>
      </div>
    </>
  )
}
