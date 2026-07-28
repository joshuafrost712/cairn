import { describe, it, expect } from 'vitest'
import {
  isAuthorizationRefusal,
  matchFromRowKey,
  referenceKeyFields,
} from '../src/db/referenceWrite'
import { activityKsaPk, assignmentPk, workshopSettingPk } from '../src/db/local'

/**
 * The classification that decides whether a queued reference write is retried
 * forever or set aside.
 *
 * Getting it wrong in the "transient" direction is the expensive mistake: a
 * permanently refused entry that keeps counting as pending blocks
 * loadReferenceData() from ever refreshing that device again, silently. So the
 * refusal shapes Postgres and PostgREST actually emit are pinned here.
 */
describe('isAuthorizationRefusal', () => {
  it('recognizes Postgres insufficient_privilege by code', () => {
    expect(isAuthorizationRefusal({ code: '42501', message: 'anything' })).toBe(true)
  })

  it('recognizes an RLS policy violation by message when no code comes through', () => {
    expect(
      isAuthorizationRefusal({
        message: 'new row violates row-level security policy for table "workshop"',
      }),
    ).toBe(true)
  })

  it('recognizes a missing table grant, which is how workshop_member refuses', () => {
    expect(isAuthorizationRefusal({ message: 'permission denied for table workshop_member' })).toBe(
      true,
    )
  })

  it('treats a network or server failure as retryable', () => {
    // These must stay queued: the write is still valid, it just did not arrive.
    expect(isAuthorizationRefusal({ message: 'Failed to fetch' })).toBe(false)
    expect(isAuthorizationRefusal({ code: '08006', message: 'connection failure' })).toBe(false)
    expect(isAuthorizationRefusal({ code: '503', message: 'Service Unavailable' })).toBe(false)
  })

  it('treats a constraint violation as retryable rather than refused', () => {
    // A foreign key that is not satisfied yet often resolves once the parent
    // entry ahead of it in the queue lands, so it is not a permanent refusal.
    expect(
      isAuthorizationRefusal({
        code: '23503',
        message: 'insert or update on table "activity" violates foreign key constraint',
      }),
    ).toBe(false)
  })

  it('does not choke on an error with no message at all', () => {
    expect(isAuthorizationRefusal({})).toBe(false)
  })
})

/**
 * The composite-key round trip.
 *
 * A delete rebuilds the Postgres row's identity by splitting the outbox
 * `rowKey` against the table's declared key fields, which is correct only while
 * the `*Pk()` helpers in db/local.ts join those fields in exactly that order.
 * The two live in different files, so nothing but this suite stops them
 * drifting, and the failure mode if they do is a delete that silently matches
 * zero rows.
 *
 * Wave 2 generalized what used to be a hard-coded special case for
 * `activity_ksa`. The first test here is the regression guard for that: the
 * table that already worked must keep producing the identical `.match()`.
 */
describe('matchFromRowKey', () => {
  it('still round-trips activity_ksa, the case that predates the generalization', () => {
    const pk = activityKsaPk('act-1', 'ksa-1')
    expect(matchFromRowKey('activity_ksa', pk)).toEqual({ activity_id: 'act-1', ksa_id: 'ksa-1' })
  })

  it('round-trips a single-column key unchanged', () => {
    expect(matchFromRowKey('participant', 'p-1')).toEqual({ id: 'p-1' })
  })

  it('round-trips a workshop setting', () => {
    const pk = workshopSettingPk('w-1', 'required_confirmations')
    expect(matchFromRowKey('workshop_setting', pk)).toEqual({
      workshop_id: 'w-1',
      key: 'required_confirmations',
    })
  })

  it('round-trips a four-column assignment key, email and all', () => {
    const pk = assignmentPk('w-1', 'p-1', 'Viji@SIL.org', 'review')
    expect(matchFromRowKey('report_assignment', pk)).toEqual({
      workshop_id: 'w-1',
      participant_id: 'p-1',
      // Lowercased by the pk helper, which is what makes the key stable when the
      // same address arrives capitalized differently from two devices.
      evaluator_email: 'viji@sil.org',
      kind: 'review',
    })
  })

  it('produces one value per declared key field for every table', () => {
    const tables = [
      'workshop',
      'team',
      'participant',
      'activity',
      'ksa',
      'activity_ksa',
      'workshop_setting',
      'report_assignment',
    ] as const
    for (const t of tables) {
      const fields = referenceKeyFields(t)
      const fake = fields.map((_, i) => `v${i}`).join('::')
      const match = matchFromRowKey(t, fake)
      expect(Object.keys(match)).toEqual(fields)
      expect(Object.values(match).every((v) => v !== undefined)).toBe(true)
    }
  })
})
