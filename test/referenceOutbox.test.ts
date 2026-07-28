import { describe, it, expect } from 'vitest'
import { isAuthorizationRefusal } from '../src/db/referenceWrite'

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
