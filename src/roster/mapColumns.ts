/**
 * Which column in the file is which field of a participant (tl-10).
 *
 * Pure, and separate from both the parsers and the planner, because the three
 * failures are different: a parse failure is loud, a mapping failure is silent and
 * catastrophic (every email becomes a team name), and a plan failure is a row-level
 * verdict the admin can read. Keeping the mapping here means the guess can be
 * unit-tested against real header wordings and, more importantly, that the guess is
 * only ever a SUGGESTION the administrator confirms.
 *
 * That last point is the design. The importer never acts on a fuzzy match; it
 * pre-fills a dropdown with one and shows the admin what it chose. A wrong guess is
 * then a visible wrong guess rather than a wrong roster.
 */
import type { Grid } from './parseDelimited'

/** The four fields this importer can fill. `name` is the only required one. */
export type RosterField = 'name' | 'registered_email' | 'team' | 'preferred_language'

export const ROSTER_FIELDS: RosterField[] = [
  'name',
  'registered_email',
  'team',
  'preferred_language',
]

export const REQUIRED_FIELDS: RosterField[] = ['name']

/** Column index per field; null means "not in this file". */
export type ColumnMapping = Record<RosterField, number | null>

export const EMPTY_MAPPING: ColumnMapping = {
  name: null,
  registered_email: null,
  team: null,
  preferred_language: null,
}

/**
 * Header wordings seen in the wild, per field.
 *
 * Not an attempt at every possible spelling: an unmatched header simply leaves the
 * dropdown unset, which the admin fixes in one click. The list exists to make the
 * common file work without any clicks at all.
 */
const SYNONYMS: Record<RosterField, string[]> = {
  name: ['name', 'fullname', 'participant', 'participantname', 'person', 'learner', 'student', 'trainee', 'attendee'],
  registered_email: ['email', 'emailaddress', 'mail', 'address', 'registeredemail', 'contact', 'contactemail'],
  team: ['team', 'group', 'cohort', 'table', 'teamname', 'groupname'],
  preferred_language: ['language', 'lang', 'preferredlanguage', 'mothertongue', 'heartlanguage'],
}

/** Lowercase, strip everything that is not a letter or digit. `E-Mail` -> `email`. */
export function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * How well one header matches one field, 0 for not at all.
 *
 * The scoring exists for one case that a naive `includes` gets wrong every time:
 * **"Team Name" contains "name"**, so a contains-match would map the team column to
 * the participant's name and then leave the real name column unmapped. Position and
 * synonym length break that tie in favour of the word the header LEADS with, which
 * is how a human reads it too.
 */
export function matchScore(header: string, field: RosterField): number {
  const h = normalizeHeader(header)
  if (!h) return 0
  let best = 0
  for (const synonym of SYNONYMS[field]) {
    if (h === synonym) {
      best = Math.max(best, 100 + synonym.length)
      continue
    }
    const at = h.indexOf(synonym)
    if (at >= 0) best = Math.max(best, 80 + synonym.length - at)
  }
  return best
}

/**
 * Best-match assignment across all four fields at once.
 *
 * Globally greedy rather than field-by-field, because field-by-field lets the first
 * field claim a column a later field wanted more. One column is never assigned to
 * two fields: importing the same column as both name and team is never what somebody
 * meant, and silently doing it is worse than leaving one unset.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const candidates: { field: RosterField; column: number; score: number }[] = []
  for (const field of ROSTER_FIELDS) {
    headers.forEach((header, column) => {
      const score = matchScore(header, field)
      if (score > 0) candidates.push({ field, column, score })
    })
  }
  candidates.sort((a, b) => b.score - a.score || a.column - b.column)

  const mapping: ColumnMapping = { ...EMPTY_MAPPING }
  const takenColumns = new Set<number>()
  for (const candidate of candidates) {
    if (mapping[candidate.field] !== null) continue
    if (takenColumns.has(candidate.column)) continue
    mapping[candidate.field] = candidate.column
    takenColumns.add(candidate.column)
  }
  return mapping
}

export interface HeaderReading {
  /** Index of the header row in the grid, or null when the file has none. */
  headerRow: number | null
  /** What to show in the column dropdown: the header cell, or `A`, `B`, `C`. */
  headers: string[]
  /**
   * The header cells exactly as the file holds them, blanks included.
   *
   * Kept apart from `headers` for one reason: a column with no header still needs a
   * name in the dropdown, and it must NOT be reported as "a column this import
   * ignored". A spreadsheet with an empty leading column would otherwise tell the
   * admin it was ignoring a column called "A", which is true and useless.
   */
  rawHeaders: string[]
  /** Rows that are data, in file order. */
  dataRows: Grid
  mapping: ColumnMapping
}

/** `0` -> `A`, `26` -> `AA`. For naming the columns of a file with no header. */
export function columnLabel(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Read a grid as headers plus data.
 *
 * A file HAS a header when its first non-empty row matches at least one known field
 * wording. The alternative rules were both worse: "assume row 0 is a header" eats a
 * participant on a headerless file, and "the row is a header if no cell looks like
 * an email" calls a header row of `Nama, Surel` data. Matching against the same
 * synonyms the mapping uses means the two decisions cannot disagree.
 *
 * A headerless file still gets a mapping suggestion of `name` -> first non-empty
 * column, because a one-column list of names is the commonest headerless file there
 * is and it should import without ceremony.
 */
export function readHeaders(grid: Grid): HeaderReading {
  const firstContentIndex = grid.findIndex((row) => row.some((cell) => cell.trim() !== ''))
  if (firstContentIndex < 0) {
    return {
      headerRow: null,
      headers: [],
      rawHeaders: [],
      dataRows: [],
      mapping: { ...EMPTY_MAPPING },
    }
  }

  const width = grid.reduce((w, row) => Math.max(w, row.length), 0)
  const candidate = grid[firstContentIndex]
  const looksLikeHeader = ROSTER_FIELDS.some((field) =>
    candidate.some((cell) => matchScore(cell, field) > 0),
  )

  if (!looksLikeHeader) {
    const headers = Array.from({ length: width }, (_, i) => columnLabel(i))
    const firstUsed = candidate.findIndex((cell) => cell.trim() !== '')
    return {
      headerRow: null,
      headers,
      // Every column is unnamed, so nothing here can be reported as ignored.
      rawHeaders: Array.from({ length: width }, () => ''),
      dataRows: grid.slice(firstContentIndex),
      mapping: { ...EMPTY_MAPPING, name: firstUsed < 0 ? null : firstUsed },
    }
  }

  const rawHeaders = Array.from({ length: width }, (_, i) => candidate[i]?.trim() ?? '')
  return {
    headerRow: firstContentIndex,
    headers: rawHeaders.map((header, i) => header || columnLabel(i)),
    rawHeaders,
    dataRows: grid.slice(firstContentIndex + 1),
    mapping: suggestMapping(rawHeaders),
  }
}

/**
 * Columns the import will not read, named so an admin can see it did not silently
 * swallow the one they cared about.
 */
export function ignoredColumns(headers: string[], mapping: ColumnMapping): string[] {
  const used = new Set(Object.values(mapping).filter((v): v is number => v !== null))
  return headers
    .map((header, index) => ({ header, index }))
    .filter(({ index, header }) => !used.has(index) && header.trim() !== '')
    .map(({ header }) => header)
}
