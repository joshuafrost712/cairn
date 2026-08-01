import { describe, it, expect } from 'vitest'
import {
  ADMIN_GRANTABLE,
  CHIEF_ADMIN_GRANTABLE,
  canGrant,
  canRemove,
  canRemoveSelf,
  canTransferChiefAdmin,
  grantableRoles,
} from '../src/lib/permissions'
import { WORKSHOP_ROLES } from '../src/lib/types'
import type { WorkshopRole } from '../src/lib/types'

/**
 * The matrix, walked cell by cell. The refusals are the point: a permission rule
 * verified only by "the right person can do it" has verified nothing.
 *
 * scripts/tl02-rls-tests.sql walks the same cells against the database, which is
 * where they are actually enforced. Both must agree, and a difference between them
 * is the failure this pair exists to catch.
 */

const OTHERS: WorkshopRole[] = ['chief_evaluator', 'consultant', 'evaluator', 'participant']

describe('canGrant — a chief admin', () => {
  it('grants every role below the chief admin slot', () => {
    for (const role of CHIEF_ADMIN_GRANTABLE) {
      expect(canGrant('chief_admin', null, role)).toBe(true)
    }
  })

  it('cannot grant chief_admin, because that is a transfer', () => {
    expect(canGrant('chief_admin', null, 'chief_admin')).toBe(false)
    expect(canGrant('chief_admin', 'admin', 'chief_admin')).toBe(false)
  })

  it('cannot touch the sitting chief admin at all, which is what keeps the slot filled', () => {
    for (const role of WORKSHOP_ROLES) {
      expect(canGrant('chief_admin', 'chief_admin', role)).toBe(false)
    }
    expect(canRemove('chief_admin', 'chief_admin')).toBe(false)
  })

  it('revokes any role it can grant', () => {
    for (const role of CHIEF_ADMIN_GRANTABLE) {
      expect(canRemove('chief_admin', role)).toBe(true)
    }
  })

  it('re-ranks an existing member as freely as it adds one', () => {
    expect(canGrant('chief_admin', 'evaluator', 'admin')).toBe(true)
    expect(canGrant('chief_admin', 'admin', 'evaluator')).toBe(true)
    expect(canGrant('chief_admin', 'participant', 'consultant')).toBe(true)
  })
})

describe('canGrant — an admin', () => {
  it('adds an evaluator who is not yet a member', () => {
    expect(canGrant('admin', null, 'evaluator')).toBe(true)
  })

  it('removes an evaluator', () => {
    expect(canRemove('admin', 'evaluator')).toBe(true)
  })

  it('grants nothing but evaluator', () => {
    for (const role of WORKSHOP_ROLES.filter((r) => r !== 'evaluator')) {
      expect(canGrant('admin', null, role)).toBe(false)
      expect(canGrant('admin', 'evaluator', role)).toBe(false)
    }
  })

  it('cannot act on another admin at all', () => {
    expect(canGrant('admin', 'admin', 'evaluator')).toBe(false)
    expect(canRemove('admin', 'admin')).toBe(false)
  })

  it('cannot act on the chief admin', () => {
    expect(canGrant('admin', 'chief_admin', 'evaluator')).toBe(false)
    expect(canRemove('admin', 'chief_admin')).toBe(false)
  })

  it('cannot reach a chief evaluator, a consultant, or a participant', () => {
    for (const role of ['chief_evaluator', 'consultant', 'participant'] as WorkshopRole[]) {
      expect(canGrant('admin', role, 'evaluator')).toBe(false)
      expect(canRemove('admin', role)).toBe(false)
    }
  })
})

describe('canGrant — everyone else', () => {
  it('changes nothing, whoever the target is', () => {
    for (const actor of [...OTHERS, null]) {
      for (const target of [...WORKSHOP_ROLES, null]) {
        for (const requested of [...WORKSHOP_ROLES, null]) {
          expect(canGrant(actor, target, requested)).toBe(false)
        }
      }
    }
  })
})

describe('the mirror covers the whole space', () => {
  it('agrees with the enumerated matrix on all 343 cells', () => {
    const actors: (WorkshopRole | null)[] = [...WORKSHOP_ROLES, null]
    const targets: (WorkshopRole | null)[] = [...WORKSHOP_ROLES, null]
    const requests: (WorkshopRole | null)[] = [...WORKSHOP_ROLES, null]

    // The matrix restated independently, so a typo in the implementation cannot
    // be reproduced by a test that calls the implementation to decide.
    const expected = (
      actor: WorkshopRole | null,
      target: WorkshopRole | null,
      requested: WorkshopRole | null,
    ): boolean => {
      if (requested === 'chief_admin') return false
      if (target === 'chief_admin') return false
      if (actor === 'chief_admin') {
        return (
          requested === null ||
          ['admin', 'chief_evaluator', 'consultant', 'evaluator', 'participant'].includes(requested)
        )
      }
      if (actor === 'admin') {
        return (
          (target === null || target === 'evaluator') &&
          (requested === null || requested === 'evaluator')
        )
      }
      return false
    }

    let cells = 0
    for (const actor of actors) {
      for (const target of targets) {
        for (const requested of requests) {
          cells += 1
          expect(
            canGrant(actor, target, requested),
            `actor=${actor} target=${target} requested=${requested}`,
          ).toBe(expected(actor, target, requested))
        }
      }
    }
    expect(cells).toBe(actors.length * targets.length * requests.length)
  })
})

describe('canRemoveSelf', () => {
  it('lets anyone but the chief admin leave a workshop they were added to', () => {
    for (const role of WORKSHOP_ROLES.filter((r) => r !== 'chief_admin')) {
      expect(canRemoveSelf(role)).toBe(true)
    }
  })

  it('refuses the chief admin, whose exit is a transfer', () => {
    expect(canRemoveSelf('chief_admin')).toBe(false)
  })

  it('refuses a non-member, who has nothing to leave', () => {
    expect(canRemoveSelf(null)).toBe(false)
  })
})

describe('canTransferChiefAdmin', () => {
  it('is the chief admin s own act', () => {
    expect(canTransferChiefAdmin('chief_admin', false)).toBe(true)
  })

  it('is refused to an admin, which is the whole asymmetry', () => {
    expect(canTransferChiefAdmin('admin', false)).toBe(false)
  })

  it('is open to a platform owner as the recovery path', () => {
    expect(canTransferChiefAdmin(null, true)).toBe(true)
    expect(canTransferChiefAdmin('evaluator', true)).toBe(true)
  })

  it('is refused to a non-member who is not the platform owner', () => {
    expect(canTransferChiefAdmin(null, false)).toBe(false)
  })
})

describe('grantableRoles', () => {
  it('offers a chief admin the five roles below the slot, and never the slot', () => {
    expect(grantableRoles('chief_admin', null)).toEqual([...CHIEF_ADMIN_GRANTABLE])
    expect(grantableRoles('chief_admin', null)).not.toContain('chief_admin')
  })

  it('offers an admin exactly one role', () => {
    expect(grantableRoles('admin', null)).toEqual([...ADMIN_GRANTABLE])
  })

  it('offers an admin nothing for a target out of reach', () => {
    expect(grantableRoles('admin', 'admin')).toEqual([])
    expect(grantableRoles('admin', 'chief_admin')).toEqual([])
  })

  it('offers a chief admin nothing for the sitting chief admin', () => {
    expect(grantableRoles('chief_admin', 'chief_admin')).toEqual([])
  })

  it('offers an evaluator nothing', () => {
    expect(grantableRoles('evaluator', null)).toEqual([])
  })
})