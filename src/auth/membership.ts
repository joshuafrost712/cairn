import type { WorkshopMember, WorkshopRole } from '../lib/types'

/**
 * Membership resolution, as pure functions.
 *
 * Deliberately free of React and of Supabase so the rules can be tested directly
 * (test/membership.test.ts). The hooks in ../layout/roles.ts and the loader in
 * ./AuthContext.tsx are thin wrappers over these.
 *
 * None of this is a security boundary. RLS is
 * (supabase/migrations/20260728000700_workshop_membership.sql). What these
 * functions decide is what the app offers to render; what the user can actually
 * read or write is re-derived server-side from auth.uid() on every request. That
 * separation is why a tampered cache is a cosmetic problem rather than an
 * escalation.
 */

export const memberPk = (workshopId: string, appUserId: string) => `${workshopId}::${appUserId}`

/** The caller's role in one workshop, or null when they hold no membership in it. */
export function roleInWorkshop(
  memberships: WorkshopMember[],
  workshopId: string | null,
): WorkshopRole | null {
  if (!workshopId) return null
  return memberships.find((m) => m.workshop_id === workshopId)?.role ?? null
}

/** Whether the caller's role in `workshopId` is one of `roles`. */
export function hasRoleInWorkshop(
  memberships: WorkshopMember[],
  workshopId: string | null,
  roles: readonly WorkshopRole[],
): boolean {
  const role = roleInWorkshop(memberships, workshopId)
  return role != null && roles.includes(role)
}

/**
 * Which workshop the app should be pointed at, given what the device remembers
 * and what the server says the user actually belongs to.
 *
 * The stored id is per-device `localStorage` (src/lib/activeWorkshop.ts). While
 * roles were global that was harmless; now that roles are per-workshop, an
 * unvalidated stored id would be the client naming its own privileges. So it is
 * treated as a hint: honored when it matches a real membership, discarded
 * otherwise.
 *
 * Returns null when the user has no memberships at all, which is a state the UI
 * must name explicitly rather than render as an empty dashboard.
 */
export function resolveActiveWorkshopId(
  storedId: string | null,
  memberships: WorkshopMember[],
): string | null {
  if (memberships.length === 0) return null
  if (storedId && memberships.some((m) => m.workshop_id === storedId)) return storedId
  return memberships[0].workshop_id
}

/**
 * Whether the stored selection needs correcting. Kept separate from
 * `resolveActiveWorkshopId` so the caller writes to localStorage only when the
 * value actually changes, instead of on every render.
 */
export function activeWorkshopNeedsCorrection(
  storedId: string | null,
  memberships: WorkshopMember[],
): boolean {
  if (memberships.length === 0) return storedId != null
  return resolveActiveWorkshopId(storedId, memberships) !== storedId
}
