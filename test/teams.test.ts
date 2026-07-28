import { describe, expect, it } from 'vitest'
import { formatBreakdown, membersOf, teamBreakdown } from '../src/lib/teams'
import { participant } from './factories'

describe('teamBreakdown', () => {
  it('counts the mix and keeps the unrecorded separate', () => {
    const members = [
      participant({ id: 'a', name: 'Ada', sex: 'female' }),
      participant({ id: 'b', name: 'Ben', sex: 'male' }),
      participant({ id: 'c', name: 'Cai', sex: 'male' }),
      participant({ id: 'd', name: 'Dee' }),
    ]
    expect(teamBreakdown(members)).toEqual({ total: 4, male: 2, female: 1, unspecified: 1 })
  })

  it('treats an explicit null the same as an absent field', () => {
    const absent = teamBreakdown([participant({ id: 'a' })])
    const explicitNull = teamBreakdown([participant({ id: 'a', sex: null })])
    expect(explicitNull).toEqual(absent)
    expect(explicitNull.unspecified).toBe(1)
  })

  it('is all zeroes on an empty team', () => {
    expect(teamBreakdown([])).toEqual({ total: 0, male: 0, female: 0, unspecified: 0 })
  })
})

describe('formatBreakdown', () => {
  it('reads as a mix when the data is there', () => {
    expect(formatBreakdown({ total: 7, male: 4, female: 3, unspecified: 0 })).toBe('4M / 3F')
  })

  // The point of the field: a gap has to be visible, or "4M / 3F" on a team of
  // nine is a quietly wrong answer that nobody goes back to fix.
  it('names the gap when some members are unrecorded', () => {
    expect(formatBreakdown({ total: 9, male: 4, female: 3, unspecified: 2 })).toBe(
      '4M / 3F · 2 unrecorded',
    )
  })

  it('does not pretend to a mix when nothing is recorded', () => {
    expect(formatBreakdown({ total: 5, male: 0, female: 0, unspecified: 5 })).toBe('5 unrecorded')
  })

  it('says so when the team is empty', () => {
    expect(formatBreakdown({ total: 0, male: 0, female: 0, unspecified: 0 })).toBe('no members')
  })
})

describe('membersOf', () => {
  const roster = [
    participant({ id: 'c', name: 'Cai', team_id: 't-1' }),
    participant({ id: 'a', name: 'Ada', team_id: 't-1' }),
    participant({ id: 'b', name: 'Ben', team_id: 't-2' }),
    participant({ id: 'u', name: 'Uma', team_id: null }),
  ]

  it('returns one team, name-sorted', () => {
    expect(membersOf(roster, 't-1').map((p) => p.name)).toEqual(['Ada', 'Cai'])
  })

  it('treats null as the unassigned pool', () => {
    expect(membersOf(roster, null).map((p) => p.name)).toEqual(['Uma'])
  })

  it('returns nothing for a team with no members', () => {
    expect(membersOf(roster, 't-9')).toEqual([])
  })
})
