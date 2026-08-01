import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { detectDelimiter, parseDelimited } from '../src/roster/parseDelimited'
import {
  decodeXmlText,
  firstSheetPath,
  parseSharedStrings,
  parseSheet,
  parseSpreadsheet,
} from '../src/roster/parseSpreadsheet'
import {
  columnLabel,
  ignoredColumns,
  matchScore,
  readHeaders,
  suggestMapping,
} from '../src/roster/mapColumns'
import { planCounts, planImport, type PlanInput } from '../src/roster/planImport'
import type { Participant, Team } from '../src/lib/types'

/**
 * tl-10's parser and planner, which are the two places this feature can be wrong
 * without anybody noticing.
 *
 * A parse failure is loud. A MIS-PARSE is not: a column read one place to the left
 * imports twenty-eight plausible-looking rows with everybody's email belonging to
 * somebody else. So the cases here are the ones that shift or drop a cell, plus
 * every row verdict the preview can show, because the preview is the only thing
 * standing between a wrong file and a wrong roster.
 */

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

describe('parseDelimited', () => {
  it('keeps a comma and a newline inside a quoted field', () => {
    const grid = parseDelimited('Name,Note\n"Amos, Jr.","line one\nline two"\n')
    expect(grid).toEqual([
      ['Name', 'Note'],
      ['Amos, Jr.', 'line one\nline two'],
    ])
  })

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('Name\n"Ada ""Tuan"" Rahman"\n')).toEqual([['Name'], ['Ada "Tuan" Rahman']])
  })

  it('strips a UTF-8 BOM, so the first header still matches', () => {
    const grid = parseDelimited('﻿Name,Email\nAmos,amos@example.org\n')
    expect(grid[0][0]).toBe('Name')
    expect(matchScore(grid[0][0], 'name')).toBeGreaterThan(0)
  })

  it('handles CRLF and a lone CR', () => {
    expect(parseDelimited('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseDelimited('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('drops a trailing empty line rather than reporting a nameless row', () => {
    expect(parseDelimited('Name\nAmos\n\n')).toEqual([['Name'], ['Amos']])
  })

  it('keeps a row of empty fields, because that is a malformed row and not a blank line', () => {
    expect(parseDelimited('Name,Email\n,,\n')).toEqual([['Name', 'Email'], ['', '', '']])
  })

  it('round-trips non-ASCII names intact', () => {
    const grid = parseDelimited('Name\nJosé Álvarez\n김민준\nمحمد\n')
    expect(grid.slice(1)).toEqual([['José Álvarez'], ['김민준'], ['محمد']])
  })

  it('detects a tab separator even when a quoted field holds commas', () => {
    const text = 'Name\tCity\n"Amos, Jr."\t"Jakarta, Indonesia"\n'
    expect(detectDelimiter(text)).toBe('\t')
    expect(parseDelimited(text)[1]).toEqual(['Amos, Jr.', 'Jakarta, Indonesia'])
  })

  it('detects a semicolon separator, which a comma-decimal locale export uses', () => {
    expect(detectDelimiter('Name;Email\n')).toBe(';')
  })

  it('treats a single column with no separator as one column', () => {
    expect(parseDelimited('Name\nAmos\nBudi')).toEqual([['Name'], ['Amos'], ['Budi']])
  })
})

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

describe('parseSpreadsheet', () => {
  it('reads a real .xlsx end to end, through the zip and the inflater', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/roster-sample.xlsx', import.meta.url)))
    const grid = await parseSpreadsheet(bytes)
    // Written by openpyxl, so this exercises a third-party writer rather than a
    // file this repo produced: an empty LEADING column, non-ASCII names, a styled
    // empty cell mid-row, and a trailing empty row.
    expect(grid[0].slice(1, 6)).toEqual([
      'Full Name',
      'E-Mail',
      'Team Name',
      'Preferred Language',
      'Notes',
    ])
    expect(grid.map((row) => row[1]).slice(1)).toEqual([
      'Ayu Ningsih',
      'José Álvarez',
      '김민준',
      'Amos, Jr.',
    ])
    // The trailing empty row is gone, and the styled empty cell did not eat its
    // neighbour: the language is still in column E.
    expect(grid).toHaveLength(5)
    expect(grid[4][3]).toBe('')
    expect(grid[4][4]).toBe('English')
  })

  it('reads the header of that file into a usable mapping', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/roster-sample.xlsx', import.meta.url)))
    const reading = readHeaders(await parseSpreadsheet(bytes))
    expect(reading.headerRow).toBe(0)
    expect(reading.mapping).toEqual({
      name: 1,
      registered_email: 2,
      team: 3,
      preferred_language: 4,
    })
    // rawHeaders, not headers: the blank leading column is nameless in the file
    // and must not be reported as a column the import ignored.
    expect(ignoredColumns(reading.rawHeaders, reading.mapping)).toEqual(['Notes'])
  })
})

describe('the sheet scanner', () => {
  const shared = ['Ayu', 'ayu@example.org', 'Team A']

  it('resolves shared strings by index', () => {
    const xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    </sheetData></worksheet>`
    expect(parseSheet(xml, shared)).toEqual([['Ayu', 'ayu@example.org']])
  })

  /**
   * The regression that a real Google Sheets export found, pinned.
   *
   * A greedy attribute group matches the slash of `<c r="D2" s="3"/>` and then runs
   * on to the NEXT `</c>`, so the empty cell takes its neighbour's value and the
   * neighbour vanishes. Everything to the right shifts one column left, which in a
   * roster means everybody's email belongs to the person above.
   */
  it('does not let a self-closing empty cell swallow the next one', () => {
    const xml = `<sheetData>
      <row r="2"><c r="C2"><v>45</v></c><c r="D2" s="3"/><c r="E2" t="s"><v>2</v></c></row>
    </sheetData>`
    expect(parseSheet(xml, shared)).toEqual([[], ['', '', '45', '', 'Team A']])
  })

  it('places cells by their own reference, so a gap stays a gap', () => {
    const xml = `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row></sheetData>`
    expect(parseSheet(xml, [])).toEqual([['1', '', '', '4']])
  })

  it('joins rich-text runs, so a part-italic name is not truncated', () => {
    const sharedXml = `<sst><si><r><t>Ayu</t></r><r><t xml:space="preserve"> Ningsih</t></r></si></sst>`
    expect(parseSharedStrings(sharedXml)).toEqual(['Ayu Ningsih'])
  })

  it('drops phonetic annotations rather than concatenating them into the name', () => {
    const sharedXml = `<sst><si><t>山田</t><rPh sb="0" eb="2"><t>やまだ</t></rPh></si></sst>`
    expect(parseSharedStrings(sharedXml)).toEqual(['山田'])
  })

  it('reads an inline string', () => {
    const xml = `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Amos</t></is></c></row></sheetData>`
    expect(parseSheet(xml, [])).toEqual([['Amos']])
  })

  it('decodes XML entities, including numeric references', () => {
    expect(decodeXmlText('Smith &amp; Sons &lt;a&gt; &#65; &#x42;')).toBe('Smith & Sons <a> A B')
  })

  it('follows the workbook relationship rather than guessing sheet1.xml', () => {
    const workbook = `<workbook><sheets><sheet name="Roster" sheetId="2" r:id="rId7"/></sheets></workbook>`
    const rels = `<Relationships>
      <Relationship Id="rId7" Target="worksheets/sheet3.xml"/>
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    </Relationships>`
    const names = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']
    expect(firstSheetPath(workbook, rels, names)).toBe('xl/worksheets/sheet3.xml')
  })

  it('falls back to the lowest-numbered worksheet when there are no relationships', () => {
    expect(firstSheetPath('', '', ['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet1.xml'])).toBe(
      'xl/worksheets/sheet1.xml',
    )
  })
})

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

describe('column mapping', () => {
  it('maps the common header wordings', () => {
    expect(suggestMapping(['Full Name', 'E-Mail Address', 'Group', 'Preferred Language'])).toEqual({
      name: 0,
      registered_email: 1,
      team: 2,
      preferred_language: 3,
    })
  })

  /** The case a contains-match gets wrong every time. */
  it('does not read "Team Name" as the participant name', () => {
    expect(suggestMapping(['Team Name', 'Participant'])).toEqual({
      name: 1,
      registered_email: null,
      team: 0,
      preferred_language: null,
    })
  })

  it('never gives one column to two fields', () => {
    const mapping = suggestMapping(['Name'])
    const used = Object.values(mapping).filter((v) => v !== null)
    expect(new Set(used).size).toBe(used.length)
  })

  it('recognizes a headerless file and maps the first column to the name', () => {
    const reading = readHeaders([['Amos'], ['Budi']])
    expect(reading.headerRow).toBeNull()
    expect(reading.headers).toEqual(['A'])
    expect(reading.dataRows).toHaveLength(2)
    expect(reading.mapping.name).toBe(0)
  })

  it('names columns A, Z, AA for a file with no header', () => {
    expect([0, 25, 26].map(columnLabel)).toEqual(['A', 'Z', 'AA'])
  })

  it('reports the columns it will not read', () => {
    const reading = readHeaders([['Name', 'Email', 'Dietary needs', 'Passport']])
    expect(ignoredColumns(reading.rawHeaders, reading.mapping)).toEqual([
      'Dietary needs',
      'Passport',
    ])
  })
})

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

const team = (id: string, name: string): Team => ({ id, workshop_id: 'w1', name })
const person = (over: Partial<Participant> & { id: string; name: string }): Participant => ({
  workshop_id: 'w1',
  registered_email: null,
  team_id: null,
  preferred_language: 'English',
  ...over,
})

function plan(csv: string, over: Partial<PlanInput> = {}) {
  const grid = parseDelimited(csv)
  const reading = readHeaders(grid)
  return planImport({
    dataRows: reading.dataRows,
    mapping: over.mapping ?? reading.mapping,
    participants: over.participants ?? [],
    teams: over.teams ?? [],
    firstDataLine: (reading.headerRow ?? -1) + 2,
  })
}

describe('planImport', () => {
  it('creates everybody when the roster is empty', () => {
    const result = plan('Name,Email\nAmos,amos@example.org\nBudi,budi@example.org\n')
    expect(result.summary).toMatchObject({ create: 2, update: 0, error: 0, duplicate: 0 })
    expect(result.rows.every((r) => r.selected)).toBe(true)
    expect(result.rows[0].line).toBe(2)
  })

  it('matches on email and shows the name change in the preview', () => {
    const result = plan('Name,Email\nAmos Situmorang,AMOS@example.org\n', {
      participants: [person({ id: 'p1', name: 'Amos', registered_email: 'amos@example.org' })],
    })
    expect(result.summary.update).toBe(1)
    expect(result.rows[0].changes).toEqual([
      { field: 'name', before: 'Amos', after: 'Amos Situmorang' },
    ])
  })

  it('flags the same email twice in one file and imports it once', () => {
    const result = plan('Name,Email\nAmos,amos@example.org\nAmos again,AMOS@EXAMPLE.ORG\n')
    expect(result.summary).toMatchObject({ create: 1, duplicate: 1 })
    expect(result.rows[1].warnings).toContain('duplicate-email')
    expect(result.rows[1].selected).toBe(false)
  })

  it('flags two rows resolving to the same existing person', () => {
    const result = plan('Name\nAmos\nAmos\n', {
      participants: [person({ id: 'p1', name: 'Amos' })],
    })
    expect(result.rows[1].warnings).toContain('duplicate-target')
    expect(result.rows[1].selected).toBe(false)
  })

  it('blocks only the row that is missing a name', () => {
    const result = plan('Name,Email\n,orphan@example.org\nBudi,budi@example.org\n')
    expect(result.rows[0].verdict).toBe('error')
    expect(result.rows[0].errors).toEqual(['missing-name'])
    expect(result.rows[1].verdict).toBe('create')
    expect(result.rows[1].selected).toBe(true)
  })

  it('rejects a malformed email', () => {
    const result = plan('Name,Email\nAmos,amos at example dot org\n')
    expect(result.rows[0].errors).toEqual(['malformed-email'])
    expect(result.rows[0].selected).toBe(false)
  })

  it('warns that a team would be created, and lists it once', () => {
    const result = plan('Name,Team\nAmos,Team C\nBudi,team c\n')
    expect(result.newTeams).toEqual(['Team C'])
    expect(result.rows[0].warnings).toContain('new-team')
  })

  it('resolves an existing team without warning', () => {
    const result = plan('Name,Team\nAmos,team a\n', { teams: [team('t1', 'Team A')] })
    expect(result.newTeams).toEqual([])
    expect(result.rows[0].warnings).toEqual([])
  })

  it('permits two people sharing a name, with a warning', () => {
    // The stored Amos has an address and the file's Amos has a different one, so
    // they are two people rather than one who moved.
    const shared = plan('Name,Email\nAmos,new@example.org\n', {
      participants: [person({ id: 'p1', name: 'Amos', registered_email: 'amos@sil.org' })],
    })
    expect(shared.rows[0].verdict).toBe('create')
    expect(shared.rows[0].warnings).toContain('duplicate-name')
  })

  /**
   * The commonest import there is: a roster typed in by name, then the sheet that
   * finally has everybody's address. Matching on email alone would create a second
   * copy of every person on it.
   */
  it('fills in an address by name when the person on file has none', () => {
    const result = plan('Name,Email\nAmos,amos@example.org\n', {
      participants: [person({ id: 'p1', name: 'Amos' })],
    })
    expect(result.rows[0].verdict).toBe('update')
    expect(result.rows[0].participantId).toBe('p1')
    expect(result.rows[0].changes).toEqual([
      { field: 'registered_email', before: null, after: 'amos@example.org' },
    ])
  })

  /** Never fuzzy-match a person, and never guess between two of them. */
  it('creates rather than choosing when two existing people share the name', () => {
    const result = plan('Name\nAmos\n', {
      participants: [person({ id: 'p1', name: 'Amos' }), person({ id: 'p2', name: 'amos' })],
    })
    expect(result.rows[0].verdict).toBe('create')
    expect(result.rows[0].warnings).toContain('duplicate-name')
  })

  it('never clears a field from a blank cell', () => {
    const result = plan('Name,Email,Team\nAmos,,\n', {
      participants: [
        person({ id: 'p1', name: 'Amos', registered_email: 'amos@example.org', team_id: 't1' }),
      ],
      teams: [team('t1', 'Team A')],
    })
    expect(result.rows[0].verdict).toBe('unchanged')
    expect(result.rows[0].changes).toEqual([])
  })

  it('is idempotent: the same file twice reports every row unchanged', () => {
    const csv = 'Name,Email,Team\nAmos,amos@example.org,Team A\nBudi,budi@example.org,Team A\n'
    const first = plan(csv)
    expect(first.summary.create).toBe(2)
    const committed = [
      person({ id: 'p1', name: 'Amos', registered_email: 'amos@example.org', team_id: 't1' }),
      person({ id: 'p2', name: 'Budi', registered_email: 'budi@example.org', team_id: 't1' }),
    ]
    const second = plan(csv, { participants: committed, teams: [team('t1', 'Team A')] })
    expect(second.summary).toMatchObject({ create: 0, update: 0, unchanged: 2 })
    expect(second.newTeams).toEqual([])
  })

  it('skips a row whose every mapped cell is blank', () => {
    const result = plan('Name,Email\nAmos,amos@example.org\n,,\n')
    expect(result.rows).toHaveLength(1)
  })

  it('counts what the dialog quotes, from the selected rows only', () => {
    const result = plan('Name,Email,Team\nAmos,amos@example.org,Team C\nBudi,budi@example.org,\n', {
      participants: [person({ id: 'p1', name: 'Amos', registered_email: 'AMOS@example.org' })],
      mapping: { name: 0, registered_email: 1, team: 2, preferred_language: null },
    })
    const counts = planCounts(result)
    expect(counts).toMatchObject({
      created: 1,
      updated: 1,
      emailChanges: 0,
      teamChanges: 1,
      newTeams: 1,
    })
    const deselected = { ...result, rows: result.rows.map((r) => ({ ...r, selected: false })) }
    expect(planCounts(deselected)).toMatchObject({ created: 0, updated: 0, emailChanges: 0 })
  })
})
