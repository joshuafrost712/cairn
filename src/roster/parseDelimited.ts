/**
 * CSV and TSV, parsed here rather than by a dependency (tl-10).
 *
 * The spec's call, and it is the right one: quoted fields, embedded separators and
 * newlines, a BOM, and CRLF are a known-shaped problem with a known-shaped answer,
 * and every one of them is in the acceptance list below. What a library would buy
 * is edge cases this app will never meet, at the price of a dependency in the path
 * of an UNTRUSTED FILE — which is what a registration spreadsheet is, whoever sent
 * it.
 *
 * Pure: a string in, a rectangle of strings out. No File, no fetch, no Dexie, so
 * every case in the acceptance list is a unit test rather than a click.
 *
 * The output is deliberately NOT objects keyed by header. Header detection is a
 * separate decision (mapColumns.ts) because a file may not have one, and a parser
 * that assumes row 0 is a header cannot represent the file that isn't.
 */

/** A rectangle of cells, exactly as the file holds them, before any interpretation. */
export type Grid = string[][]

/** The separators worth guessing between. */
export type Delimiter = ',' | '\t' | ';'

/**
 * Guess the separator from the first line, counting only OUTSIDE quotes.
 *
 * Counting inside quotes is the mistake this exists to avoid: one address field
 * reading `"Jakarta, Indonesia"` puts two commas in a tab-separated line and makes
 * a TSV parse as a CSV, which silently shreds every row rather than failing.
 *
 * Semicolon is in the list because a Sheets or Excel export made under a
 * comma-decimal locale uses it, and that file looks like a single-column CSV
 * otherwise — an import of twenty-eight rows all reading "Name;Email;Team".
 */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, '\t': 0, ';': 0 }
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (quoted && text[i + 1] === '"') i++
      else quoted = !quoted
      continue
    }
    if (quoted) continue
    if (ch === '\n') break
    if (ch === ',' || ch === '\t' || ch === ';') counts[ch]++
  }
  const best = (Object.keys(counts) as Delimiter[]).reduce((a, b) =>
    counts[b] > counts[a] ? b : a,
  )
  // Nothing found: one column is a legitimate file (a list of names), and comma is
  // the harmless assumption because there is nothing to split on either way.
  return counts[best] === 0 ? ',' : best
}

/**
 * Parse delimited text into a grid.
 *
 * Five behaviours worth stating, because each is an acceptance case:
 *
 *  * A UTF-8 BOM is stripped. Left in place it becomes an invisible first
 *    character of the first header cell, so the header `Name` no longer equals
 *    the string "Name", and the fuzzy header match misses the one column the
 *    import cannot proceed without.
 *  * CRLF and lone CR both end a line. Excel writes CRLF; an older Mac export can
 *    still write CR.
 *  * A quoted field may contain the delimiter, a newline, and doubled quotes.
 *  * A trailing empty line produces no row. A file ending in a newline is the
 *    normal case, not a twenty-ninth participant with no name.
 *  * Rows are RAGGED as the file made them. Squaring them off is mapColumns'
 *    business, and padding here would hide a genuinely malformed file.
 */
export function parseDelimited(text: string, delimiter?: Delimiter): Grid {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const sep = delimiter ?? detectDelimiter(src)

  const rows: Grid = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let sawAnyChar = false

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A line that is exactly one empty field is a blank line, which is not a row.
    // A line of `,,,` IS a row: it has four fields, and reporting it as an error
    // row with no name is more honest than dropping it silently.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    sawAnyChar = true

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"' && field === '') {
      quoted = true
      continue
    }
    if (ch === '"') {
      // A quote mid-field, as in `Ada "Tuan" Rahman`. Not standards-legal, and a
      // parser that threw here would reject a file a human typed by hand. Kept.
      field += ch
      continue
    }
    if (ch === sep) {
      endField()
      continue
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++
      endRow()
      continue
    }
    if (ch === '\n') {
      endRow()
      continue
    }
    field += ch
  }

  // The last line, if the file did not end with a newline. An unterminated quoted
  // field ends here too rather than throwing: the field's content is what was
  // read, which is recoverable, and a thrown parse is not.
  if (sawAnyChar && (field !== '' || row.length > 0)) endRow()

  return rows
}
