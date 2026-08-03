import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { updateWorkshop } from '../../db/admin'
import { createWorkshop, deleteWorkshop, duplicateWorkshop } from '../../db/referenceWrite'
import { setActiveWorkshopId } from '../../lib/activeWorkshop'
import { c } from '../../lib/content/chrome'
import { isSupabaseConfigured } from '../../lib/supabase'
import type { Workshop } from '../../lib/types'
import { countsForWorkshop } from '../counts'
import { diffFields } from '../impact'
import { useSetupSave } from '../useSetupSave'

/**
 * Workshop basics: what this workshop is, when it runs, and the create/duplicate/
 * delete operations on the workshop itself.
 *
 * The scenario selector moved here from the Scenario Builder. tl-17 replaces it with
 * a proper switcher and a create flow across several workshops; until then this is
 * the only way to make a second one, so it moves rather than disappearing.
 *
 * Meta is saved by an explicit button, not on blur, because the dates are what decide
 * whether the workshop reads as closed — and that decides whether every OTHER save
 * gets the closed-workshop warning. A field with that reach should not commit because
 * somebody tabbed past it.
 */
export function BasicsSection({ workshop }: { workshop: Workshop | null }) {
  const { request, busy } = useSetupSave()
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const [newName, setNewName] = useState('')

  const create = async (name: string) => {
    let created: Workshop | null = null
    await request({
      change: { entity: 'workshop', operation: 'create', entityId: null, label: name },
      commit: async () => {
        created = await createWorkshop(name)
      },
    })
    if (created) setActiveWorkshopId((created as Workshop).id)
  }

  const duplicate = async () => {
    if (!workshop) return
    let created: Workshop | null = null
    const name = `${workshop.name} (copy)`
    await request({
      change: { entity: 'workshop', operation: 'create', entityId: null, label: name },
      commit: async () => {
        created = await duplicateWorkshop(workshop.id, name)
      },
    })
    if (created) setActiveWorkshopId((created as Workshop).id)
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
          <select
            value={workshop?.id ?? ''}
            onChange={(e) => setActiveWorkshopId(e.target.value)}
            disabled={busy || (workshops ?? []).length === 0}
            style={{ flex: 1 }}
            aria-label={c('setup.basics.switch-title')}
          >
            {(workshops ?? []).length === 0 && <option value="">(none)</option>}
            {(workshops ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {workshop && (
            <button className="ghost" disabled={busy} onClick={() => void duplicate()}>
              {c('setup.basics.duplicate')}
            </button>
          )}
        </div>
        <div className="row">
          <input
            placeholder={c('setup.basics.new-placeholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            disabled={busy || !newName.trim()}
            onClick={() => {
              const name = newName.trim()
              setNewName('')
              void create(name)
            }}
          >
            {c('setup.basics.create')}
          </button>
        </div>
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
