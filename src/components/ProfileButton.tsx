import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { PersonProfileDrawer } from './PersonProfileDrawer'
import { db } from '../db/local'
import { useAuth } from '../auth/AuthContext'
import { ensurePersonForParticipant, myWorkshopRoles } from '../db/people'
import { normalizeEmail, PROFILE_ADMIN_ROLES } from '../lib/people'
import { c } from '../lib/content/chrome'

/**
 * "Background" beside somebody's name, and the drawer it opens (tl-12).
 *
 * One component for all six surfaces the spec names, because the alternative is
 * six copies of the same person-id resolution and six chances to get it subtly
 * different. Two ways in, matching how the app already identifies people:
 *
 *  - `participantId` — the roster and report surfaces, which hold participant rows
 *  - `email` — the evaluator surfaces, which hold only an address, since
 *    `evaluator_email` is the join every evaluator-facing record uses
 *
 * The email path resolves through `person.primary_email` rather than through
 * `app_user`, because `app_user_select` only shows you people you already share a
 * workshop with while `person_select` is scoped by the person's own workshops —
 * and an evaluator whose account row this device cannot read still has a name on a
 * report that somebody wants the background for.
 */
export function ProfileButton({
  participantId,
  email,
  name,
  workshopId,
  compact = false,
  className = 'ghost btn--sm',
  label,
}: {
  participantId?: string | null
  email?: string | null
  name: string
  workshopId?: string | null
  compact?: boolean
  className?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const { identity } = useAuth()
  const appUserId = identity?.appUserId ?? null

  const resolved = useLiveQuery(async () => {
    if (participantId) {
      const p = await db.participants.get(participantId)
      if (!p) return { personId: null, canCreate: false }
      if (p.person_id) return { personId: p.person_id, canCreate: false }
      // No person row yet. Offering "create their record" to somebody the policy
      // will refuse is worse than not offering it, so the affordance is gated on
      // the same role `person_insert` names — checked against THIS participant's
      // workshop rather than against "an admin somewhere".
      const roles = await myWorkshopRoles(appUserId)
      const role = roles.get(p.workshop_id)
      return { personId: null, canCreate: Boolean(role && PROFILE_ADMIN_ROLES.includes(role)) }
    }
    const key = normalizeEmail(email)
    if (!key) return { personId: null, canCreate: false }
    const person = await db.persons.where('primary_email').equals(key).first()
    return { personId: person?.id ?? null, canCreate: false }
  }, [participantId, email, appUserId])

  const createPerson = async () => {
    if (!participantId) return
    const participant = await db.participants.get(participantId)
    if (participant) await ensurePersonForParticipant(participant)
  }

  return (
    <>
      <button
        className={className}
        title={c('profile.open-help')}
        onClick={(e) => {
          // A control inside a DataTable row with `onRowClick` must stop
          // propagation or opening the drawer navigates out from under itself.
          // Wave 1 learned this on a delete confirm; the shape is identical.
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {label ?? c('profile.open')}
      </button>
      {/*
        Two things, and BOTH are needed. This button lives in a `DataTable` cell,
        and `/admin/participants` gives every row an `onRowClick` that navigates.
        Rendered in place, the drawer is a descendant of that row, so every click
        inside it — Edit, Save, the visibility select — bubbled to the row handler
        and navigated away from the panel being typed into. Stopping propagation on
        the TRIGGER, which is what Wave 1 needed, does nothing for a subtree opened
        by it.

        The portal is the first half: a dialog has no business inside a table cell,
        for stacking reasons as much as anything. It is NOT sufficient on its own,
        and the reason is worth remembering — **a React portal still propagates
        events through the React tree, not the DOM tree**, so the row handler fires
        exactly as before. Verified in a browser: with the portal alone, clicking
        Edit navigated to /admin/participants/<id> and the drawer vanished.

        So the wrapper below is the half that actually fixes it.
      */}
      {open &&
        createPortal(
          <div onClick={(e) => e.stopPropagation()}>
            <PersonProfileDrawer
              open={open}
              onClose={() => setOpen(false)}
              personId={resolved?.personId ?? null}
              name={name}
              workshopId={workshopId}
              compact={compact}
              onCreatePerson={resolved?.canCreate ? createPerson : undefined}
            />
          </div>,
          document.body,
        )}
    </>
  )
}
