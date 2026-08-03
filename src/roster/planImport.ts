/**
 * The dry run (tl-10). This module is the spec's whole point.
 *
 * Nothing here writes. It takes the file's rows, the confirmed column mapping, and
 * the roster as it stands, and returns a verdict per row: new, an update (with the
 * fields that would change), an in-file duplicate, or an error with a reason. The
 * commit path then executes exactly the plan the administrator saw, so what they
 * approved and what happens are the same object rather than two code paths that
 * agree today.
 *
 * Four rules that are decisions rather than mechanics:
 *
 *  1. **A blank cell never clears a field.** A half-filled Email column would
 *     otherwise delete the addresses of everybody it left blank, which is the
 *     silent destruction this whole spec exists to avoid. Absent means "not
 *     stated", not "empty".
 *  2. **Never fuzzy-match a person.** Email, exactly, case-folded and trimmed; or
 *     the name, exactly, case-folded and whitespace-collapsed. A near-match on a
 *     name is precisely where an importer merges two real people, and merging two
 *     people is not undoable in any useful sense.
 *  3. **Two people may share a name.** It is warned, not blocked. The Bali roster
 *     has repeated given names, and an importer that refuses them is an importer
 *     that gets abandoned for retyping.
 *  4. **A row that matches with nothing to change is not an error and not a
 *     no-op.** It is `unchanged`, counted separately, which is what makes the
 *     idempotence claim checkable: importing the same file twice must report
 *     twenty-eight unchanged and create nothing.
 */
import type { Grid } from './parseDelimited'
import type { ColumnMapping, RosterField } from './mapColumns'
import type { Participant, Team } from '../lib/types'

export type RowVerdict = 'create' | 'update' | 'unchanged' | 'duplicate' | 'error'

/** A reason, as a stable code. The wording lives in chrome.json, keyed on the code. */
export type RowIssue =
  | 'missing-name'
  | 'malformed-email'
  | 'duplicate-email'
  | 'duplicate-target'
  | 'duplicate-name'
  | 'new-team'

export interface PlannedChange {
  field: 'name' | 'registered_email' | 'team_id' | 'preferred_language'
  before: string | null
  after: string | null
  /** For team_id, the names, since an id means nothing in a preview. */
  beforeLabel?: string | null
  afterLabel?: string | null
}

export interface PlannedRow {
  /** 1-based row number as the admin sees it in their spreadsheet. */
  line: number
  values: Partial<Record<RosterField, string>>
  verdict: RowVerdict
  errors: RowIssue[]
  warnings: RowIssue[]
  /** The participant this row resolves to, for an update or an unchanged match. */
  participantId?: string
  /** The name shown in the preview: the file's, or the existing person's. */
  label: string
  changes: PlannedChange[]
  /** A team named in this row that does not exist yet. */
  newTeamName?: string
  selected: boolean
}

export interface ImportPlan {
  rows: PlannedRow[]
  /** Distinct team names the commit would create, in first-seen order. */
  newTeams: string[]
  summary: Record<RowVerdict, number>
}

export interface PlanInput {
  dataRows: Grid
  mapping: ColumnMapping
  participants: Participant[]
  teams: Team[]
  /** Row offset so `line` matches the spreadsheet: the header row's index plus one. */
  firstDataLine: number
}

/** Trimmed, case-folded, inner whitespace collapsed. Used for name equality only. */
export const normalizeName = (raw: string): string => raw.trim().replace(/\s+/g, ' ').toLowerCase()

/** Trimmed and lower-cased. `auth.users.email` is lowercase, so this matches it. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase()

/**
 * Deliberately permissive: one @, something either side, a dot in the domain, no
 * spaces. Not RFC 5322, which accepts things no registration form ever produces and
 * whose full grammar would reject nothing a human typos.
 */
export const isEmailLike = (raw: string): boolean =>
  /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(raw.trim())

const cell = (row: string[], index: number | null): string =>
  index === null ? '' : (row[index] ?? '').trim()

/**
 * Build the plan. Pure: no Dexie, no network, no clock.
 */
export function planImport(input: PlanInput): ImportPlan {
  const { dataRows, mapping, participants, teams, firstDataLine } = input

  const byEmail = new Map<string, Participant>()
  for (const p of participants) {
    if (p.registered_email) byEmail.set(normalizeEmail(p.registered_email), p)
  }
  const byName = new Map<string, Participant[]>()
  for (const p of participants) {
    const key = normalizeName(p.name)
    byName.set(key, [...(byName.get(key) ?? []), p])
  }
  const teamByName = new Map<string, Team>()
  for (const t of teams) teamByName.set(normalizeName(t.name), t)

  const seenEmails = new Set<string>()
  const seenTargets = new Set<string>()
  const newTeams: string[] = []
  const newTeamKeys = new Set<string>()
  const rows: PlannedRow[] = []

  dataRows.forEach((raw, i) => {
    const line = firstDataLine + i
    const values: Partial<Record<RosterField, string>> = {}
    const name = cell(raw, mapping.name)
    const email = cell(raw, mapping.registered_email)
    const team = cell(raw, mapping.team)
    const language = cell(raw, mapping.preferred_language)
    if (mapping.name !== null) values.name = name
    if (mapping.registered_email !== null) values.registered_email = email
    if (mapping.team !== null) values.team = team
    if (mapping.preferred_language !== null) values.preferred_language = language

    // A row where every mapped cell is blank is the spreadsheet's own padding, not
    // a person. Skipped entirely rather than reported as an error row, because a
    // preview listing nine blank errors is a preview nobody reads to the end.
    if (!name && !email && !team && !language) return

    const errors: RowIssue[] = []
    const warnings: RowIssue[] = []
    if (!name) errors.push('missing-name')
    if (email && !isEmailLike(email)) errors.push('malformed-email')

    const emailKey = email && !errors.includes('malformed-email') ? normalizeEmail(email) : ''
    if (emailKey && seenEmails.has(emailKey)) {
      rows.push({
        line,
        values,
        verdict: 'duplicate',
        errors: [],
        warnings: ['duplicate-email'],
        label: name || email,
        changes: [],
        selected: false,
      })
      return
    }
    if (emailKey) seenEmails.add(emailKey)

    if (errors.length > 0) {
      rows.push({
        line,
        values,
        verdict: 'error',
        errors,
        warnings,
        label: name || email || `row ${line}`,
        changes: [],
        selected: false,
      })
      return
    }

    const existing = resolveExisting(byEmail, byName, name, emailKey)
    if (existing && seenTargets.has(existing.id)) {
      rows.push({
        line,
        values,
        verdict: 'duplicate',
        errors: [],
        warnings: ['duplicate-target'],
        label: name,
        changes: [],
        participantId: existing.id,
        selected: false,
      })
      return
    }
    if (existing) seenTargets.add(existing.id)

    // Resolve the team, and note it as a creation rather than performing one.
    let teamId: string | null = null
    let newTeamName: string | undefined
    if (team) {
      const key = normalizeName(team)
      const found = teamByName.get(key)
      if (found) {
        teamId = found.id
      } else {
        newTeamName = team
        warnings.push('new-team')
        if (!newTeamKeys.has(key)) {
          newTeamKeys.add(key)
          newTeams.push(team)
        }
      }
    }

    if (!existing) {
      // A new person whose name is already on the roster: allowed, and said out
      // loud, because two people can share a name and the admin is the only one who
      // knows whether this is one of those times.
      if (byName.has(normalizeName(name))) warnings.push('duplicate-name')
      rows.push({
        line,
        values,
        verdict: 'create',
        errors: [],
        warnings,
        label: name,
        changes: [],
        newTeamName,
        selected: true,
      })
      return
    }

    const changes: PlannedChange[] = []
    if (name && normalizeName(name) !== normalizeName(existing.name)) {
      changes.push({ field: 'name', before: existing.name, after: name })
    }
    if (email && normalizeEmail(email) !== normalizeEmail(existing.registered_email ?? '')) {
      changes.push({ field: 'registered_email', before: existing.registered_email, after: email })
    }
    if (team) {
      const currentTeam = teams.find((t) => t.id === existing.team_id) ?? null
      const sameTeam = currentTeam != null && normalizeName(currentTeam.name) === normalizeName(team)
      if (!sameTeam) {
        changes.push({
          field: 'team_id',
          before: existing.team_id,
          after: teamId,
          beforeLabel: currentTeam?.name ?? null,
          afterLabel: team,
        })
      }
    }
    if (language && language !== (existing.preferred_language ?? '')) {
      changes.push({
        field: 'preferred_language',
        before: existing.preferred_language,
        after: language,
      })
    }

    rows.push({
      line,
      values,
      verdict: changes.length === 0 ? 'unchanged' : 'update',
      errors: [],
      warnings,
      label: existing.name,
      participantId: existing.id,
      changes,
      newTeamName,
      selected: true,
    })
  })

  const summary: Record<RowVerdict, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    duplicate: 0,
    error: 0,
  }
  for (const row of rows) summary[row.verdict]++

  return { rows, newTeams, summary }
}

/**
 * Which person, if any, this row is about.
 *
 * Email first, exactly. Then the name, and the name fallback has a condition that
 * the spec's one-line version does not, because writing it without the condition
 * produced the wrong answer on the commonest import there is.
 *
 *   * "Match on email WHEN PRESENT, else the name" reads naturally and means that a
 *     roster typed in by name, then imported from the sheet that finally has
 *     everybody's address, matches NOBODY: every row carries an email, every stored
 *     person has none, so all twenty-eight are created a second time. The import
 *     that most needs to work is the one that doubles the roster.
 *   * Falling back to the name unconditionally is wrong the other way: an existing
 *     Amos at amos@sil.org and a file row for Amos at a.budi@example.org are more
 *     likely two people than one person with a new address, and merging two people
 *     is the one mistake here that undo cannot really fix.
 *
 * So the name fallback applies when the two cannot CONTRADICT each other: the row
 * has no email, or the person on file has none. A stored address that differs from
 * the file's is treated as a different person, warned as a shared name, and left for
 * the administrator, who is the only one who knows.
 *
 * Either way the name match must be unambiguous. Two people already on the roster
 * sharing a name means this row cannot say which, so it matches NEITHER; picking the
 * first would overwrite one of two real people on an alphabetical accident.
 */
function resolveExisting(
  byEmail: Map<string, Participant>,
  byName: Map<string, Participant[]>,
  name: string,
  emailKey: string,
): Participant | undefined {
  if (emailKey) {
    const byAddress = byEmail.get(emailKey)
    if (byAddress) return byAddress
  }
  const hits = byName.get(normalizeName(name))
  if (!hits || hits.length !== 1) return undefined
  const candidate = hits[0]
  if (!emailKey) return candidate
  return candidate.registered_email ? undefined : candidate
}

/**
 * The counts the change dialog quotes, derived from the plan the admin is looking
 * at rather than recomputed from the store.
 */
export function planCounts(plan: ImportPlan, selectedOnly = true): {
  created: number
  updated: number
  unchanged: number
  emailChanges: number
  teamChanges: number
  newTeams: number
} {
  const rows = selectedOnly ? plan.rows.filter((r) => r.selected) : plan.rows
  const has = (row: PlannedRow, field: PlannedChange['field']) =>
    row.changes.some((c) => c.field === field)
  return {
    created: rows.filter((r) => r.verdict === 'create').length,
    updated: rows.filter((r) => r.verdict === 'update').length,
    unchanged: rows.filter((r) => r.verdict === 'unchanged').length,
    emailChanges: rows.filter((r) => r.verdict === 'update' && has(r, 'registered_email')).length,
    teamChanges: rows.filter((r) => r.verdict === 'update' && has(r, 'team_id')).length,
    newTeams: new Set(
      rows.filter((r) => r.newTeamName).map((r) => normalizeName(r.newTeamName as string)),
    ).size,
  }
}
