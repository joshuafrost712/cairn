import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAX_SCALE_POINTS, MIN_SCALE_POINTS, validateScalePoints } from '../src/lib/scale'
import { referenceKeyFields } from '../src/db/referenceWrite'
import { scalePointPk } from '../src/lib/scale'

/**
 * The contract between the client and the database, asserted against the SQL
 * itself rather than against a copy of it.
 *
 * tl-05 established the shape: read the migration, and fail if the two halves of
 * a rule that is written twice have drifted. The rules here are written twice
 * because they have to be — `validateScalePoints` decides whether the Save button
 * is enabled and `scale_points_are_legal` decides whether the write is accepted —
 * and two copies of a rule is exactly the thing that goes wrong silently.
 */
const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20260801000200_configurable_scale.sql', import.meta.url),
  'utf8',
)

describe('the scale bound is the same number in SQL and in TypeScript', () => {
  it('SQL refuses fewer than MIN_SCALE_POINTS and more than MAX_SCALE_POINTS', () => {
    expect(MIGRATION).toContain(`if _n < ${MIN_SCALE_POINTS} then return 'tl09.scale_needs_two_points'`)
    expect(MIGRATION).toContain(`if _n > ${MAX_SCALE_POINTS} then return 'tl09.scale_allows_six_points'`)
  })

  it('SQL refuses an all-trigger scale, which TypeScript also refuses', () => {
    expect(MIGRATION).toContain("tl09.scale_needs_a_non_trigger_point")
    expect(
      validateScalePoints([
        { value: 0, label: 'a', is_low_trigger: true },
        { value: 1, label: 'b', is_low_trigger: true },
      ]),
    ).toBe('setup.scale.error.all-triggers')
  })

  it('SQL refuses duplicate values and blank labels, which TypeScript also refuses', () => {
    expect(MIGRATION).toContain('tl09.scale_values_must_be_distinct')
    expect(MIGRATION).toContain('tl09.scale_points_need_labels')
    expect(MIGRATION).toContain('tl09.scale_values_must_be_integers')
  })
})

describe('the scale has exactly one write path', () => {
  it('has no insert, update or delete policy, so the RPC cannot be bypassed', () => {
    // The missing policies ARE the design: with none, a direct write is refused
    // whatever role the caller holds, which leaves the two-to-six rule with no
    // path around it. A future spec that adds one has to come here first.
    expect(MIGRATION).toMatch(/create policy scale_point_select on scale_point for select/)
    expect(MIGRATION).not.toMatch(/create policy \w+ on scale_point for (insert|update|delete)/)
    expect(MIGRATION).toContain('revoke insert, update, delete on scale_point from authenticated')
  })

  it('refuses to strand evidence without an explicit mapping', () => {
    // Never a silent remap: a number nobody chose is a number no report can
    // explain, and the participant reading it was never scored there.
    expect(MIGRATION).toContain('tl09.removed_point_still_holds_evidence')
    expect(MIGRATION).toContain('tl09.remap_target_is_not_on_the_new_scale')
  })

  it('records what a remapped observation originally carried, once only', () => {
    expect(MIGRATION).toContain('remapped_from = coalesce(o.remapped_from, _v)')
  })

  it('un-pins the three columns that froze 0-3 into the schema', () => {
    // The third is the important one: `trigger_designation in (0, 1)` was not a
    // range check but the MEANING of the number, written into a constraint.
    for (const table of ['observation', 'verification_verdict', 'mentoring_conversation']) {
      expect(MIGRATION).toContain(`c.relname = '${table}'`)
    }
  })

  it('gives every new workshop a scale by trigger, not by hoping the client does it', () => {
    expect(MIGRATION).toMatch(/create trigger workshop_seed_scale\s+after insert on workshop/)
  })
})

describe('the outbox key fields match the Dexie key', () => {
  it('joins workshop_id and value in the same order the pk does', () => {
    // The invariant referenceWrite.ts states for every composite-keyed table:
    // `rowKey.split('::')` is zipped against these fields, so an order mismatch
    // would build a Postgres `.match()` on the wrong columns.
    expect(referenceKeyFields('scale_point')).toEqual(['workshop_id', 'value'])
    expect(scalePointPk('w1', 3)).toBe('w1::3')
  })
})
