/**
 * XLSX, read in-repo rather than through SheetJS (tl-10).
 *
 * THE DEPENDENCY CALL, AND WHY IT WENT THE OTHER WAY. The spec said XLSX needs
 * SheetJS, dynamically imported, and named "CSV and TSV only" as the acceptable
 * fallback if the bundle cost was too high. Neither of those is what shipped, and
 * the reason is not bundle size:
 *
 *   * The `xlsx` package ON NPM is 0.18.5 and carries two published advisories
 *     (prototype pollution, and a ReDoS). The vendor's supported builds moved to
 *     their own CDN, so taking a patched SheetJS means a package.json dependency
 *     on a URL outside the npm registry, and an `npm ci` that fails when that host
 *     is unreachable.
 *   * The input is an UNTRUSTED FILE. A registration spreadsheet arrives by email
 *     from whoever is organizing the workshop, and it is parsed on an
 *     administrator's device inside a signed-in session. That is precisely the
 *     place not to run a parser with known advisories against it.
 *   * The platform already has the hard part. `DecompressionStream('deflate-raw')`
 *     is the inflater, so what remains is zip structure (unzip.ts) and a scan over
 *     two well-specified XML files, which is this module.
 *
 * So XLSX support is real rather than dropped, and the main bundle grows by
 * nothing: the whole reader is behind a dynamic import and only loads when
 * somebody actually chooses a spreadsheet.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No formulas (the cached value is read, which is
 * what a roster file holds), no number formats, and therefore no date
 * reconstruction: a date cell arrives as its serial number. None of the four fields
 * this importer maps is a date, and inventing an epoch-guessing layer for a column
 * nobody imports is how a small reader becomes a library. If a date column is ever
 * mapped, that limitation has to be fixed here first.
 *
 * Text scanning rather than DOMParser, for one concrete reason: DOMParser does not
 * exist in Node, and a parser that cannot be unit-tested is a parser whose
 * acceptance cases are clicks.
 */
import type { Grid } from './parseDelimited'
import { readZipDirectory, readZipEntry, ZipError, type ZipEntry } from './unzip'

export { ZipError, canReadSpreadsheets } from './unzip'

/** Undo the five XML entities plus numeric references. */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = body.startsWith('#x') || body.startsWith('#X')
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
    }
  })
}

/** `A` -> 0, `Z` -> 25, `AA` -> 26. The column half of a cell reference. */
export function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64
    if (v < 1 || v > 26) break
    n = n * 26 + v
  }
  return n - 1
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

/**
 * The shared string table, in index order.
 *
 * A rich-text string is several `<r><t>` runs and must be joined, or a name typed
 * with one italic syllable imports as its first fragment. Phonetic guides (`<rPh>`,
 * which Excel writes for Japanese) are dropped rather than joined, because they are
 * an annotation on the text and not part of it.
 */
/**
 * THE ATTRIBUTE GROUP IS LAZY IN EVERY REGEX HERE, AND THAT IS A BUG FIX.
 *
 * Written greedily as `<c\b([^>]*)(?:\/>|>…<\/c>)`, the attribute group happily
 * eats the slash of a SELF-CLOSING tag — `<c r="D2" s="3"/>` matches with attrs
 * `r="D2" s="3"/` — and the match then falls through to the second branch, which
 * runs on to the NEXT `</c>`. The empty cell silently takes the following cell's
 * value and the following cell disappears.
 *
 * That is not hypothetical: it was found by diffing this reader against openpyxl
 * on a real Google Sheets export, where exactly one row had an empty styled cell
 * mid-row, and the symptom was one participant's answer appearing one column to
 * the left. A shifted column in a roster import is a whole roster of wrong emails.
 */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const items = xml.matchAll(/<si\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/si>)/g)
  for (const item of items) {
    out.push(textOf(item[2] ?? ''))
  }
  return out
}

/** The concatenated `<t>` runs of an `<si>` or an `<is>`, phonetics dropped. */
function textOf(body: string): string {
  if (!body) return ''
  const withoutPhonetic = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let text = ''
  for (const t of withoutPhonetic.matchAll(/<t\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += decodeXmlText(t[2] ?? '')
  }
  return text
}

/**
 * One worksheet as a rectangle.
 *
 * Positions are taken from each cell's own `r` reference rather than from its
 * order, which is what makes "a sheet with an empty leading column" and a row with
 * a gap in the middle come out aligned. A writer that omits `r` (rare, but legal)
 * falls back to sequence.
 */
export function parseSheet(xml: string, sharedStrings: string[]): Grid {
  const rows = new Map<number, string[]>()
  let maxRow = 0
  let fallbackRow = 0

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = rowMatch[1] ?? ''
    const body = rowMatch[2] ?? ''
    const declared = Number.parseInt(attr(rowAttrs, 'r') ?? '', 10)
    const rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : fallbackRow
    fallbackRow = rowIndex + 1
    maxRow = Math.max(maxRow, rowIndex + 1)

    const cells: string[] = []
    let fallbackCol = 0
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = cellMatch[1] ?? ''
      const cellBody = cellMatch[2] ?? ''
      const ref = attr(cellAttrs, 'r')
      const col = ref ? columnIndex(ref) : fallbackCol
      fallbackCol = col + 1
      while (cells.length < col) cells.push('')
      cells[col] = cellValue(attr(cellAttrs, 't'), cellBody, sharedStrings)
    }
    rows.set(rowIndex, cells)
  }

  const grid: Grid = []
  for (let i = 0; i < maxRow; i++) grid.push(rows.get(i) ?? [])
  // A trailing run of empty rows is formatting, not data: Excel keeps a styled
  // empty row long after its content is deleted, and each one would arrive in the
  // preview as a nameless row flagged as an error.
  while (grid.length > 0 && grid[grid.length - 1].every((cell) => cell.trim() === '')) grid.pop()
  return grid
}

function cellValue(type: string | null, body: string, sharedStrings: string[]): string {
  if (type === 'inlineStr') return textOf(body)
  const v = /<v\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/v>)/.exec(body)
  const raw = decodeXmlText(v?.[2] ?? '')
  if (type === 's') {
    const index = Number.parseInt(raw, 10)
    return sharedStrings[index] ?? ''
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  // 'str' (a formula's cached string), 'e' (an error like #N/A, kept verbatim so a
  // broken formula is visible in the preview), and the numeric default.
  return raw
}

/**
 * Which worksheet part holds the first sheet, resolved through the workbook's
 * relationships.
 *
 * Guessing `xl/worksheets/sheet1.xml` is right most of the time and wrong exactly
 * when it matters: a workbook whose first TAB is not the first FILE imports
 * somebody else's sheet without saying so. The rels path is authoritative, and the
 * guess is the fallback for a writer that omits it.
 */
export function firstSheetPath(workbookXml: string, relsXml: string, entryNames: string[]): string {
  const sheet = /<sheet\b[^>]*>/.exec(workbookXml)?.[0] ?? ''
  const relId = attr(sheet, 'r:id') ?? attr(sheet, 'id')
  if (relId) {
    for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(rel[0], 'Id') !== relId) continue
      const target = attr(rel[0], 'Target')
      if (!target) break
      const path = target.startsWith('/')
        ? target.slice(1)
        : target.startsWith('xl/')
          ? target
          : `xl/${target.replace(/^\.\//, '')}`
      if (entryNames.includes(path)) return path
      break
    }
  }
  const worksheets = entryNames.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()
  if (worksheets.length === 0) throw new ZipError('this .xlsx contains no worksheet')
  return worksheets[0]
}

/**
 * Read the first worksheet of an .xlsx into a grid.
 *
 * Takes bytes rather than a File so it stays testable and so the caller decides
 * where the bytes came from.
 */
export async function parseSpreadsheet(bytes: Uint8Array): Promise<Grid> {
  const entries = readZipDirectory(bytes)
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]))
  const read = async (name: string): Promise<string> => {
    const entry = byName.get(name)
    return entry ? readZipEntry(bytes, entry) : ''
  }

  const [workbook, rels, shared] = await Promise.all([
    read('xl/workbook.xml'),
    read('xl/_rels/workbook.xml.rels'),
    read('xl/sharedStrings.xml'),
  ])
  const path = firstSheetPath(workbook, rels, [...byName.keys()])
  const sheetXml = await read(path)
  if (!sheetXml) throw new ZipError(`this .xlsx is missing ${path}`)
  return parseSheet(sheetXml, shared ? parseSharedStrings(shared) : [])
}
