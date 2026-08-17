import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext'
import { db } from '../../db/local'
import { ASSIGNABLE_ROLES } from '../../db/directory'
import { getSettings, saveSetting } from '../../db/settings'
import { c } from '../../lib/content/chrome'
import { fairShare, quotaFor } from '../../lib/assignment'
import { resolveSettings, SETTINGS_DEFAULTS } from '../../lib/settings'
import type { AssignmentKind, Workshop, WorkshopPerson } from '../../lib/types'
import { useSetupSave } from '../useSetupSave'
import { PeopleDirectory } from './PeopleDirectory'
import { PersonMergePanel } from './PersonMergePanel'
import { InstructorReviewers } from './InstructorReviewers'

/**
 * People and roles: who is in this workshop, and how much each of them carries.
 *
 * The workload editor moved here from Settings. Who is a MEMBER was operator SQL
 * until tl-11, which put `PeopleDirectory` above this: invitations by email, role
 * changes and removals through tl-02's RPCs, and chief-admin transfer. This file
 * keeps the workload half, which is a different question about the same people —
 * the directory decides who may work, the quotas decide how much.
 *
 * The quota fields save on change, and that is allowed because the classifier calls a
 * quota `safe`: assignments already made stand, and only future auto-assignment reads
 * the number. If a future setting here can invalidate recorded work, it needs its own
 * entity in the classifier and an explicit Save.
 */
export function PeopleSection({ workshop }: { workshop: Workshop }) {
  const workshopId = workshop.id
  const { request } = useSetupSave()
  const { identity } = useAuth()
  const overrideChain = useRef<Promise<void>>(Promise.resolve())

  const settings = useLiveQuery(
    async () =>
      resolveSettings(await db.workshopSettings.where('workshop_id').equals(workshopId).toArray()),
    [workshopId],
    SETTINGS_DEFAULTS,
  )
  const people = useLiveQuery(
    () => db.workshopPeople.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as WorkshopPerson[],
  )
  const participantCount = useLiveQuery(
    () => db.participants.where('workshop_id').equals(workshopId).count(),
    [workshopId],
    0,
  )

  const evaluators = (people ?? [])
    .filter((p) => ASSIGNABLE_ROLES.includes(p.role))
    .sort((a, b) => a.name.localeCompare(b.name))
  const share = fairShare(participantCount ?? 0, evaluators.length, settings.requiredConfirmations)

  const write = (key: Parameters<typeof saveSetting>[1], label: string, value: unknown) =>
    request({
      change: { entity: 'setting', operation: 'update', entityId: key, label },
      commit: async () => {
        await saveSetting(workshopId, key, value, identity?.email ?? null)
      },
    })

  /**
   * One evaluator's quota override, or removed when the field is cleared.
   *
   * Serialized through `overrideChain`, because this is a read-modify-write over the
   * whole override map: two quick edits to two adjacent fields would otherwise both
   * read the same `current`, and the second write would drop the first person's
   * number. Chaining costs nothing at typing speed and removes the interleave.
   *
   * Two ADMINS on two devices editing different evaluators can still clobber each
   * other, since the map is one jsonb value. That needs a row per evaluator, which is
   * a schema change; noted rather than hidden.
   */
  const setOverride = (kind: AssignmentKind, email: string, raw: string) => {
    overrideChain.current = overrideChain.current.then(() => writeOverride(kind, email, raw))
    return overrideChain.current
  }

  const writeOverride = async (kind: AssignmentKind, email: string, raw: string) => {
    const current = await getSettings(workshopId)
    const map = {
      ...(kind === 'review' ? current.reviewQuotaOverrides : current.observationQuotaOverrides),
    }
    const n = Number(raw)
    // An empty or nonsensical field REMOVES the override rather than storing a zero.
    // A quota of zero would silently exclude the person from every future
    // auto-assignment, which is not what clearing a box means.
    if (!raw.trim() || !Number.isFinite(n) || n < 1) delete map[email]
    else map[email] = Math.floor(n)
    await write(
      kind === 'review' ? 'review_quota_overrides' : 'observation_quota_overrides',
      c('setup.people.quota-label', 'label', { email }),
      map,
    )
  }

  return (
    <>
      <PeopleDirectory workshop={workshop} />

      <PersonMergePanel workshop={workshop} />

      {/* tl-30. Below the directory rather than above it, because it is a
          question about a subset of the people that page lists, and it renders
          nothing at all in a workshop with no instructors authored. */}
      <InstructorReviewers workshop={workshop} />

      <div className="card form-col">
        <p className="small muted">
          {c('setup.people.board-link-help')}{' '}
          <Link to="/admin/evaluators">{c('setup.people.board-link')}</Link>.
        </p>
      </div>

      <div className="card form-col">
        <h2>{c('setup.people.workload-title')}</h2>
        <p className="small muted">
          {c('setup.people.workload-help', 'label', {
            share: share === null ? c('setup.people.share-unknown') : share,
            evaluators: evaluators.length,
          })}
        </p>

        <div className="row">
          <span>
            <label htmlFor="revdef" className="small muted">
              {c('setup.people.review-default')}
            </label>
            <input
              id="revdef"
              type="number"
              min={1}
              value={settings.reviewQuotaDefault ?? ''}
              placeholder={share === null ? 'even split' : String(share)}
              onChange={(e) => {
                const n = Number(e.target.value)
                void write(
                  'review_quota_default',
                  c('setup.people.review-default'),
                  Number.isFinite(n) && n >= 1 ? Math.floor(n) : null,
                )
              }}
              style={{ width: '5rem', margin: 0 }}
            />
          </span>
          <span>
            <label htmlFor="obsdef" className="small muted">
              {c('setup.people.observation-default')}
            </label>
            <input
              id="obsdef"
              type="number"
              min={1}
              value={settings.observationQuotaDefault ?? ''}
              placeholder={share === null ? 'even split' : String(share)}
              onChange={(e) => {
                const n = Number(e.target.value)
                void write(
                  'observation_quota_default',
                  c('setup.people.observation-default'),
                  Number.isFinite(n) && n >= 1 ? Math.floor(n) : null,
                )
              }}
              style={{ width: '5rem', margin: 0 }}
            />
          </span>
        </div>

        {evaluators.length > 0 && (
          <>
            <h3 style={{ marginTop: 'var(--s-4)' }}>{c('setup.people.per-evaluator')}</h3>
            {evaluators.map((e) => (
              <div className="row" key={e.email} style={{ padding: 'var(--s-1) 0' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{e.name}</strong>
                  <span className="small muted"> · {e.role.replace(/_/g, ' ')}</span>
                </span>
                <input
                  type="number"
                  min={1}
                  aria-label={`Review quota for ${e.name}`}
                  value={settings.reviewQuotaOverrides[e.email] ?? ''}
                  placeholder={String(quotaFor(e.email, 'review', settings, share) ?? '—')}
                  onChange={(ev) => void setOverride('review', e.email, ev.target.value)}
                  style={{ width: '4.5rem', margin: 0 }}
                />
                <input
                  type="number"
                  min={1}
                  aria-label={`Observation quota for ${e.name}`}
                  value={settings.observationQuotaOverrides[e.email] ?? ''}
                  placeholder={String(quotaFor(e.email, 'observation', settings, share) ?? '—')}
                  onChange={(ev) => void setOverride('observation', e.email, ev.target.value)}
                  style={{ width: '4.5rem', margin: 0 }}
                />
              </div>
            ))}
            <p className="small muted">{c('setup.people.two-boxes')}</p>
          </>
        )}
      </div>
    </>
  )
}
