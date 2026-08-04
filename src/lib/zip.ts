/**
 * The smallest zip WRITER that can produce a readable archive (tl-15).
 *
 * tl-10 wrote a zip reader rather than taking a dependency, and its reasoning applies
 * here in the same direction: an archive is well-specified structure, the pack is a
 * handful of markdown and JSON files, and the alternative was a package in the
 * supply chain of a signed-in administrator's session. About eighty lines against a
 * dependency is the same trade `src/roster/unzip.ts` already made, and this half is
 * the easier one because writing needs no inflater.
 *
 * STORED, NOT DEFLATED, and the choice is deliberate rather than lazy. `CompressionStream`
 * exists in every browser this app supports, so deflate was available; what it would buy
 * is a smaller download of text an operator unzips within seconds of receiving it, and
 * what it costs is a byte stream that is no longer a function of its inputs. A stored
 * archive is reproducible, so `test/pack.test.ts` can assert on the actual bytes and a
 * harness can unzip what the browser produced and compare it to what the renderer said.
 *
 * DETERMINISTIC BY CONTRACT: the modification time is passed in rather than read from the
 * clock. Two packs generated from the same workshop at the same recorded instant are the
 * same bytes, which is what makes the round-trip in this spec's acceptance checkable at
 * all.
 */

export interface ZipFile {
  /** Forward-slash path inside the archive. No leading slash, no `..`. */
  name: string
  text: string
}

const encoder = new TextEncoder()

/** CRC-32 (IEEE 802.3), table built once on first use. */
let crcTable: Uint32Array | null = null

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32Table()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS date and time, which is what a zip header carries.
 *
 * Seconds have two-second resolution and the epoch is 1980, both of which are facts
 * about the format rather than approximations chosen here. A date before 1980 is
 * clamped rather than wrapped, because a negative year field produces an archive some
 * tools refuse to open and none of them explains why.
 *
 * READ IN UTC, which is what makes the determinism claim above true. The first draft used
 * the local-time getters, so the same `generatedAt` wrote 17:00 into the header in Bali and
 * 04:00 in Dallas: the archive's bytes depended on the machine rather than on its inputs,
 * and the round-trip test could not see it because both calls ran in one process. A zip has
 * no timezone field, so a reader shows this stamp as local time wherever it is opened; UTC
 * is therefore the only choice that is the same everywhere, and being an hour off in a
 * file listing is worth more than being reproducible nowhere.
 */
export function dosDateTime(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getUTCFullYear())
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2)
  return { date, time }
}

/** A path a zip may hold: relative, forward slashes, nothing climbing out. */
export function isSafeZipPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\')) return false
  if (name.includes('//') || name.endsWith('/')) return false
  return !name.split('/').some((part) => part === '' || part === '.' || part === '..')
}

/**
 * Build a stored (uncompressed) zip archive.
 *
 * Throws on an unsafe path rather than sanitizing it: every caller here builds its own
 * names from a fixed set of folders plus a capture id, so an unsafe one means a bug
 * upstream and silently rewriting it would hide that.
 */
export function buildZip(files: ZipFile[], modifiedAt: Date): Uint8Array {
  const { date, time } = dosDateTime(modifiedAt)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    if (!isSafeZipPath(file.name)) throw new Error(`unsafe path in archive: ${file.name}`)
    const nameBytes = encoder.encode(file.name)
    const data = encoder.encode(file.text)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed: 2.0
    lv.setUint16(6, 0x0800, true) // flags: UTF-8 names
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra field length
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attributes
    cv.setUint32(38, 0, true) // external attributes
    cv.setUint32(42, offset, true) // relative offset of local header
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true) // this disk
  ev.setUint16(6, 0, true) // disk with central directory
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true) // comment length

  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
