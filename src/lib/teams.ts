// Team composition — pure, no IO, no React.
//
// The roster's teams panel needs to answer "how many, and what is the mix" for
// each team without opening it. That is a counting job over the participant list,
// so it lives here where it can be tested directly rather than inside a component
// that would need rendering to exercise.

import type { Participant } from './types'

export interface TeamBreakdown {
  total: number
  male: number
  female: number
  /** Members whose sex has not been recorded. Never folded into either count. */
  unspecified: number
}

export function teamBreakdown(members: Participant[]): TeamBreakdown {
  let male = 0
  let female = 0
  for (const m of members) {
    if (m.sex === 'male') male++
    else if (m.sex === 'female') female++
  }
  return { total: members.length, male, female, unspecified: members.length - male - female }
}

/**
 * The one-line composition read.
 *
 * An unrecorded sex is reported, not hidden. "4M / 3F" on a team of nine would be
 * a quietly wrong answer, and the roster is normally entered incomplete, so the
 * gap has to be visible or it never gets filled in.
 */
export function formatBreakdown(b: TeamBreakdown): string {
  if (b.total === 0) return 'no members'
  if (b.male === 0 && b.female === 0) return `${b.unspecified} unrecorded`
  const known = `${b.male}M / ${b.female}F`
  return b.unspecified > 0 ? `${known} · ${b.unspecified} unrecorded` : known
}

/** Members of one team, in roster order. `null` teamId means the unassigned pool. */
export function membersOf(participants: Participant[], teamId: string | null): Participant[] {
  return participants
    .filter((p) => (p.team_id ?? null) === teamId)
    .sort((a, b) => a.name.localeCompare(b.name))
}
