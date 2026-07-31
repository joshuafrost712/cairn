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
import type { AssignmentKind, WorkshopPerson } from '../../lib/types'
import { useSetupSave } from '../useSetupSave'

/**
 * People and roles: who is in this workshop, and how much each of them carries.
 *
 * The workload editor moved here from Settings. Who is a MEMBER is still operator
 * SQL — `workshop_member` has no client write path at all (tl-01), by design, and
 * tl-11 is the spec that gives it security-definer RPCs and an invitation flow. So
 * this section shows the real roster and says plainly that adding somebody is not yet
 * something the app can do, rather than offering a control that silently fails.
 *
 * The quota fields save on change, and that is allowed because the classifier calls a
 * quota `safe`: assignments already made stand, and only future auto-assignment reads
 * the number. If a future setting here can invalidate recorded work, it needs its own
 * entity in the classifier and an explicit Save.
 */
export function PeopleSection({ workshopId }: { workshopId: string }) {
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
      <div className="card form-col">
        <h2>{c('setup.people.title')}</h2>
        <p className="small muted">{c('setup.people.membership-pending')}</p>
        {evaluators.length === 0 ? (
          <p className="small muted">{c('setup.people.none')}</p>
        ) : (
          <ul className="small">
            {evaluators.map((e) => (
              <li key={e.email}>
                <strong>{e.name}</strong> · {e.role.replace(/_/g, ' ')} · {e.email}
              </li>
            ))}
          </ul>
        )}
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
