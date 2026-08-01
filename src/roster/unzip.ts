/**
 * The smallest zip reader that can open an .xlsx (tl-10).
 *
 * An xlsx is a zip of XML. Reading one therefore needs an inflater, and the
 * platform has had one since `DecompressionStream('deflate-raw')` — Chrome 80,
 * Safari 16.4, Firefox 113, and Node 18. So the choice is not "a library or no
 * XLSX support"; it is "a library or about a hundred lines of well-specified
 * structure parsing", and the hundred lines win for the reasons in
 * parseSpreadsheet.ts.
 *
 * Central directory only. The local file headers are read for their variable-length
 * fields and nothing else, because the central directory is the authority on sizes
 * and a streaming zip writer is allowed to leave the local ones zeroed.
 */

export interface ZipEntry {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** The value every 32-bit zip field takes when the real one lives in a zip64 extra. */
const ZIP64_SENTINEL = 0xffffffff

export class ZipError extends Error {}

/**
 * Read the central directory.
 *
 * The end-of-central-directory record is found by scanning BACKWARDS, because it
 * is last and its position depends on a trailing comment of unknown length. 64 KiB
 * is the whole possible comment range, so a scan bounded at that cannot miss it.
 */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minEocd = 22
  if (bytes.byteLength < minEocd) throw new ZipError('not a zip file: too short')

  let eocd = -1
  const earliest = Math.max(0, bytes.byteLength - minEocd - 0xffff)
  for (let i = bytes.byteLength - minEocd; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file: no end-of-central-directory record')

  const entryCount = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (directoryOffset === ZIP64_SENTINEL) {
    throw new ZipError('zip64 archives are not supported; re-save the file as .xlsx or .csv')
  }

  const decoder = new TextDecoder('utf-8')
  const entries: ZipEntry[] = []
  let p = directoryOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`corrupt zip: central directory entry ${i} is malformed`)
    }
    const compressionMethod = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    const localHeaderOffset = view.getUint32(p + 42, true)
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength))
    if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new ZipError(`zip64 entry "${name}" is not supported`)
    }
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Inflate one entry to text.
 *
 * Only the two methods a spreadsheet writer actually emits are handled: stored (0)
 * and deflate (8). Anything else is named in the error rather than returning
 * plausible garbage, because an xlsx that half-parses produces an import preview
 * that looks real.
 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const p = entry.localHeaderOffset
  if (p + 30 > bytes.byteLength || view.getUint32(p, true) !== LOCAL_SIGNATURE) {
    throw new ZipError(`corrupt zip: no local header for "${entry.name}"`)
  }
  const nameLength = view.getUint16(p + 26, true)
  const extraLength = view.getUint16(p + 28, true)
  const start = p + 30 + nameLength + extraLength
  const data = bytes.subarray(start, start + entry.compressedSize)

  if (entry.compressionMethod === 0) return new TextDecoder('utf-8').decode(data)
  if (entry.compressionMethod !== 8) {
    throw new ZipError(
      `"${entry.name}" uses compression method ${entry.compressionMethod}, which this reader does not handle`,
    )
  }

  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const inflated = await new Response(stream).arrayBuffer()
  return new TextDecoder('utf-8').decode(inflated)
}

/** Whether this runtime can inflate at all, so the UI can say so instead of failing. */
export function canReadSpreadsheets(): boolean {
  return typeof DecompressionStream !== 'undefined'
}
