import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthContext'
import { db } from '../db/local'
import {
  cachedCard,
  myWorkshopRoles,
  personWorkshopIds,
  refreshPersonCard,
  trackHistoryFor,
} from '../db/people'
import { canEditProfile, denialFromCardState, viewerFor } from '../lib/people'
import type { ProfileDenial, ProfileViewer } from '../lib/people'
import type { PersonProfile, TrackTraining } from '../lib/types'

export interface ProfileView {
  loading: boolean
  profile: PersonProfile | null
  trainings: TrackTraining[]
  viewer: ProfileViewer
  canEdit: boolean
  /** Set when the viewer may not read it, so the drawer can say why rather than render blank. */
  denial: ProfileDenial | null
}

const NOBODY: ProfileViewer = { isSelf: false, isAdmin: false, sharesWorkshop: false }
const EMPTY: ProfileView = {
  loading: false,
  profile: null,
  trainings: [],
  viewer: NOBODY,
  canEdit: false,
  denial: null,
}

/**
 * One person's background, resolved for the person looking at it (tl-12).
 *
 * ## The denial comes from the server, and it has to
 *
 * The first version of this hook computed the denial from the cached profile's
 * own `visibility`, which is unreachable by exactly the reader who needs it: RLS
 * FILTERS rather than refuses, so a withheld profile arrives as NO ROW. With no
 * row there is no visibility, the default read as `workshop`, and the drawer
 * cheerfully reported "no background has been recorded for this person" about a
 * profile that plainly had one. The browser walkthrough caught it; no unit test
 * could, because the fixture in a unit test always has the row.
 *
 * So `person_card()` — a security-definer RPC — answers the two questions a
 * non-reader cannot answer for themselves: what state is this profile in, and
 * which workshops in this deployment has this person attended. Both are cached in
 * Dexie, which is what lets the drawer open on a phone with no signal.
 *
 * The client's `viewerFor`/`canEditProfile` still exist and still decide what
 * controls to offer. They decide nothing about what is returned.
 */
export function usePersonProfile(
  personId: string | null | undefined,
  excludeWorkshopId?: string | null,
): ProfileView {
  const { identity } = useAuth()
  const appUserId = identity?.appUserId ?? null
  const myPersonId = identity?.personId ?? null

  /**
   * Whose card has finished being asked about. Not a boolean, because the drawer
   * is reused across people and a stale `true` from the previous person would
   * un-gate the render for the next one.
   *
   * This exists because "the card has not arrived yet" and "there is no card" have
   * to look different on screen. Without it the drawer renders "no background has
   * been recorded for this person" for the few hundred milliseconds before the
   * server answers — and then replaces it with "administrators only". An evaluator
   * who glances and looks away has been told something false, which is the same
   * failure as the blank drawer, arriving faster.
   */
  const [settledFor, setSettledFor] = useState<string | null>(null)

  useEffect(() => {
    if (!personId) return
    let live = true
    void refreshPersonCard(personId).finally(() => {
      if (live) setSettledFor(personId)
    })
    return () => {
      live = false
    }
  }, [personId])

  const data = useLiveQuery(async () => {
    if (!personId) return null
    const [profile, card, workshopIds, roles, trainings] = await Promise.all([
      db.personProfiles.get(personId),
      cachedCard(personId),
      personWorkshopIds(personId),
      myWorkshopRoles(appUserId),
      trackHistoryFor(personId, excludeWorkshopId),
    ])
    return { profile: profile ?? null, card, workshopIds, roles, trainings }
  }, [personId, appUserId, excludeWorkshopId])

  if (!personId) return EMPTY
  if (!data) return { ...EMPTY, loading: true }
  // A cached card means this device has heard before and can render immediately,
  // offline included. Only a person nobody has asked about waits.
  if (!data.card && settledFor !== personId) return { ...EMPTY, loading: true }

  const viewer = viewerFor({
    personId,
    myPersonId,
    personWorkshopIds: data.workshopIds,
    myRoles: data.roles,
  })

  // No card yet (offline, first ever open, or an RPC that failed) means we cannot
  // say a profile is withheld. Falling back to "readable" is the right direction:
  // the worst case is an empty drawer, and the server has already withheld the row
  // itself, so nothing leaks either way.
  const denial = denialFromCardState(data.card?.state ?? null)

  return {
    loading: false,
    profile: denial ? null : data.profile,
    // Withheld on the same rule as the profile. `person_card()` already returns no
    // trainings when it withholds, so this is belt and braces rather than the
    // enforcement — but a cached card from before a visibility change would
    // otherwise keep showing a track history that is now admin-only.
    trainings: denial ? [] : data.trainings,
    viewer,
    canEdit: canEditProfile(viewer),
    denial,
  }
}
