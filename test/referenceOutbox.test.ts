import { describe, it, expect } from 'vitest'
import {
  isAuthorizationRefusal,
  isSetAside,
  matchFromRowKey,
  MAX_PUSH_ATTEMPTS,
  referenceKeyFields,
  toKsaRow,
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
 * Giving up on an entry that can never succeed.
 *
 * `isAuthorizationRefusal` catches permanent errors of ONE kind. A `23503`
 * foreign-key violation is correctly classified as retryable, because the parent
 * row may still be ahead of it in the queue, and yet it can be permanently
 * unsatisfiable: assign a reviewer while offline, have somebody else delete that
 * participant, come back online, and the upsert fails forever.
 *
 * That was survivable when only the Scenario Builder used this queue. Wave 2
 * puts every assignment click and every settings change through it, and one
 * stuck entry holds `pending` above zero forever, which stops
 * `loadReferenceData()` from ever refreshing that device again with nothing but
 * a console warning to show for it.
 */
describe('isSetAside', () => {
  const entry = (over = {}) => ({
    id: 'participant:p1',
    table: 'participant' as const,
    op: 'upsert' as const,
    rowKey: 'p1',
    payload: {},
    at: '2026-07-28T00:00:00.000Z',
    ...over,
  })

  it('keeps retrying an entry that has failed only a few times', () => {
    expect(isSetAside(entry())).toBe(false)
    expect(isSetAside(entry({ attempts: 1 }))).toBe(false)
    expect(isSetAside(entry({ attempts: MAX_PUSH_ATTEMPTS - 1 }))).toBe(false)
  })

  it('gives up once the attempts run out', () => {
    expect(isSetAside(entry({ attempts: MAX_PUSH_ATTEMPTS }))).toBe(true)
    expect(isSetAside(entry({ attempts: MAX_PUSH_ATTEMPTS + 3 }))).toBe(true)
  })

  it('still sets aside an outright refusal immediately, whatever the count', () => {
    expect(isSetAside(entry({ rejected: true }))).toBe(true)
    expect(isSetAside(entry({ rejected: true, attempts: 0 }))).toBe(true)
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

describe('toKsaRow (tl-08)', () => {
  /**
   * The bug this pins was found by the browser harness, not by a type, and could not
   * have been found by one: `ResolvedKsa extends Ksa`, so a resolved question satisfies
   * every signature in referenceWrite.ts while carrying two fields that are not
   * columns. PostgREST refused the whole write ("could not find the 'goal_sort' column
   * of 'ksa'"), the outbox retried five times and set it aside, and the edit looked
   * saved on the device while reaching nobody.
   */
  it('drops the computed goal fields the editors now carry', () => {
    const resolved = {
      id: 'k1',
      workshop_id: 'w1',
      goal_id: 'g1',
      code: 'Q1',
      short_label: 'Q1',
      description: '',
      evaluator_facing_prompt: 'how?',
      ai_facing_rubric: null,
      evidence_levels: null,
      cbc_subpoint_refs: [],
      guiding_questions: [],
      goal_title: 'Exegesis',
      goal_sort: 3,
    }
    const row = toKsaRow(resolved as never) as unknown as Record<string, unknown>
    expect('goal_title' in row).toBe(false)
    expect('goal_sort' in row).toBe(false)
    expect(row.goal_id).toBe('g1')
    expect(row.workshop_id).toBe('w1')
  })

  it('drops the legacy area column rather than writing it back', () => {
    const row = toKsaRow({
      id: 'k1',
      workshop_id: 'w1',
      goal_id: null,
      code: 'Q1',
      area: 'the old free-text area',
      short_label: 'Q1',
      description: '',
      evaluator_facing_prompt: 'how?',
      ai_facing_rubric: null,
      evidence_levels: null,
      cbc_subpoint_refs: [],
      guiding_questions: [],
    }) as unknown as Record<string, unknown>
    expect('area' in row).toBe(false)
  })

  it('is an allow-list, so a field nobody added here cannot leak to Postgres', () => {
    const row = toKsaRow({ id: 'k1', invented_later: true } as never) as unknown as Record<
      string,
      unknown
    >
    expect('invented_later' in row).toBe(false)
    expect(Object.keys(row)).toEqual(['id'])
  })
})
