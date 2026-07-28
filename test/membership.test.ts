import { describe, it, expect } from 'vitest'
import {
  activeWorkshopNeedsCorrection,
  hasRoleInWorkshop,
  memberPk,
  resolveActiveWorkshopId,
  roleInWorkshop,
} from '../src/auth/membership'
import { CHIEF_ROLES, ADMIN_ROLES } from '../src/layout/roles'
import type { WorkshopMember, WorkshopRole } from '../src/lib/types'

const A = 'workshop-a'
const B = 'workshop-b'
const ME = 'user-me'

function member(workshopId: string, role: WorkshopRole, appUserId = ME): WorkshopMember {
  return {
    pk: memberPk(workshopId, appUserId),
    workshop_id: workshopId,
    app_user_id: appUserId,
    role,
  }
}

describe('roleInWorkshop', () => {
  it('returns the role held in that workshop and nothing else', () => {
    const rows = [member(A, 'admin'), member(B, 'evaluator')]
    expect(roleInWorkshop(rows, A)).toBe('admin')
    expect(roleInWorkshop(rows, B)).toBe('evaluator')
  })

  it('is null for a workshop with no membership, which is the whole point of tl-01', () => {
    // Being an admin somewhere must not read as being an admin everywhere. This is
    // the case that a single global role column could not express.
    expect(roleInWorkshop([member(A, 'admin')], B)).toBeNull()
  })

  it('is null with no active workshop selected', () => {
    expect(roleInWorkshop([member(A, 'admin')], null)).toBeNull()
  })
})

describe('hasRoleInWorkshop', () => {
  const rows = [member(A, 'chief_evaluator'), member(B, 'evaluator')]

  it('answers per workshop, not per person', () => {
    expect(hasRoleInWorkshop(rows, A, CHIEF_ROLES)).toBe(true)
    expect(hasRoleInWorkshop(rows, B, CHIEF_ROLES)).toBe(false)
  })

  it('separates the chief surfaces from the admin ones', () => {
    // chief_evaluator reaches the workbench and the dashboards; it does not reach
    // configuration. Roster/Settings/Data stay admin-only.
    expect(hasRoleInWorkshop(rows, A, CHIEF_ROLES)).toBe(true)
    expect(hasRoleInWorkshop(rows, A, ADMIN_ROLES)).toBe(false)
  })

  it('treats chief_admin as holding both', () => {
    const chiefAdmin = [member(A, 'chief_admin')]
    expect(hasRoleInWorkshop(chiefAdmin, A, CHIEF_ROLES)).toBe(true)
    expect(hasRoleInWorkshop(chiefAdmin, A, ADMIN_ROLES)).toBe(true)
  })

  it('grants nothing to a participant', () => {
    const p = [member(A, 'participant')]
    expect(hasRoleInWorkshop(p, A, CHIEF_ROLES)).toBe(false)
    expect(hasRoleInWorkshop(p, A, ADMIN_ROLES)).toBe(false)
  })
})

describe('resolveActiveWorkshopId', () => {
  it('honors a stored id backed by a real membership', () => {
    const rows = [member(A, 'evaluator'), member(B, 'admin')]
    expect(resolveActiveWorkshopId(B, rows)).toBe(B)
  })

  it('discards a stored id the user is not a member of', () => {
    // The forged-id case. localStorage is the device's hint, not its permission
    // slip: an id with no membership behind it falls back rather than sticking.
    expect(resolveActiveWorkshopId('workshop-somebody-elses', [member(A, 'evaluator')])).toBe(A)
  })

  it('falls back to the first membership when nothing is stored', () => {
    expect(resolveActiveWorkshopId(null, [member(A, 'evaluator'), member(B, 'admin')])).toBe(A)
  })

  it('is null when the user belongs to no workshop at all', () => {
    // Distinct from "no selection": there is nothing to select. The UI owes this
    // state an explicit screen rather than an empty dashboard.
    expect(resolveActiveWorkshopId(null, [])).toBeNull()
    expect(resolveActiveWorkshopId(A, [])).toBeNull()
  })
})

describe('activeWorkshopNeedsCorrection', () => {
  const rows = [member(A, 'evaluator')]

  it('leaves a valid selection alone', () => {
    expect(activeWorkshopNeedsCorrection(A, rows)).toBe(false)
  })

  it('corrects an unknown, deleted, or non-member id', () => {
    expect(activeWorkshopNeedsCorrection('gone', rows)).toBe(true)
  })

  it('corrects an absent selection when a membership exists', () => {
    expect(activeWorkshopNeedsCorrection(null, rows)).toBe(true)
  })

  it('clears a stale selection when every membership is gone', () => {
    // Removed from the workshop mid-session: the stored id has to be cleared, or
    // the next render still asks the database about a workshop that will now
    // answer with nothing.
    expect(activeWorkshopNeedsCorrection(A, [])).toBe(true)
  })

  it('has nothing to correct when there is neither a selection nor a membership', () => {
    expect(activeWorkshopNeedsCorrection(null, [])).toBe(false)
  })
})
