import { useLiveQuery } from 'dexie-react-hooks'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { db } from '../db/local'
import { mirrorActiveWorkshop } from '../db/settings'
import { c } from '../lib/content/chrome'
import { setActiveWorkshopId } from '../lib/activeWorkshop'
import { switchDestination } from '../lib/workshopSwitch'
import { useScopedWorkshopId } from '../layout/roles'
import { workshopOptions } from '../reports/workshopOverview'
import type { Workshop } from '../lib/types'

/**
 * The one control in the app that changes which workshop you are working in.
 *
 * Three decisions worth keeping:
 *
 * **It renders nothing on a single membership.** An evaluator who belongs to one
 * workshop should see the frame exactly as it was before this spec: multi-workshop
 * is an administrator's problem, and putting a switcher on the evaluator's header
 * would teach the narrow surface a vocabulary tl-03 spent a whole spec removing.
 *
 * **It lists MEMBERSHIPS, not cached workshops**, which is a real behaviour change
 * from the selector it replaces. tl-02 widened `workshop_select` so a platform
 * owner reads every workshop row in the deployment; the old Setup selector listed
 * `db.workshops` and would therefore offer one to switch to, at which point
 * `resolveActiveWorkshopId` would refuse the id and snap silently back. Offering
 * only what the caller holds a membership in makes the control honest.
 *
 * **Switching moves the settings mirror with it.** The verification threshold is a
 * workshop fact cached in one device-level slot (see db/settings.ts), so a switch
 * that skipped the mirror would run the new workshop's gate at the old workshop's
 * threshold until the next reference pull.
 */
export function WorkshopSwitcher({ id, className }: { id?: string; className?: string }) {
  const { memberships } = useAuth()
  const activeId = useScopedWorkshopId()
  const workshops = useLiveQuery(() => db.workshops.toArray(), [], [] as Workshop[])
  const navigate = useNavigate()
  const loc = useLocation()

  const options = workshopOptions(memberships, workshops ?? [])
  if (options.length < 2) return null

  const switchTo = (next: string) => {
    if (!next || next === activeId) return
    setActiveWorkshopId(next)
    // Fire-and-forget: the mirror is a cache correction, and awaiting it would
    // hold the frame on the previous workshop's chrome for a Dexie round trip.
    void mirrorActiveWorkshop(next)
    const to = switchDestination(loc.pathname)
    if (to) navigate(to, { replace: true })
  }

  return (
    <select
      id={id}
      className={className ?? 'switcher'}
      value={activeId ?? ''}
      aria-label={c('switcher.aria')}
      onChange={(e) => switchTo(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.workshop_id} value={o.workshop_id}>
          {(o.name ?? c('switcher.unnamed')) + ` (${c(`role.${o.role}`)})`}
        </option>
      ))}
    </select>
  )
}
