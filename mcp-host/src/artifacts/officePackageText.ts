/**
 * The text an Office package (DOCX, XLSX, PPTX) holds, read from the bytes
 * that are delivered rather than predicted from the arguments that produced
 * them: a generator may write a value in a form its arguments never spelled,
 * as a sheet stores the text "3,141,592,653" as the number 3141592653.
 */
import * as zlib from 'zlib'

/** Bounds on one inspection; a package past them is reported as unreadable. */
export const OFFICE_PACKAGE_LIMITS = {
  /** Entries in one package; an embedded package counts its own. */
  maxEntries: 4096,
  /** Bytes inflated across the package and every package inside it. */
  maxInflatedBytes: 64 * 1024 * 1024,
  /** Packages inside packages, such as the workbook behind a deck's chart. */
  maxDepth: 2,
}

export type OfficePackageLimits = typeof OFFICE_PACKAGE_LIMITS

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const TEXT_PART = /\.(?:xml|rels|vml)$/i
const EMBEDDED_PACKAGE = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm)$/i
const TAG = /<[^>]*>/g
const ATTRIBUTE_VALUE = /\s[^\s=<>"'/]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g
const NAMED_REFERENCES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  localHeaderOffset: number
}

/**
 * Whether any text in the package satisfies `matches`: per XML part, its text
 * nodes run together, so a value split across runs or cells reads whole, and
 * each attribute value on its own, with character references decoded.
 * Embedded packages are read too. Null when the bytes are not a package this
 * reader can read within `limits`; the caller then treats the file as unsafe.
 */
export function officePackageHasText(
  buffer: Buffer,
  matches: (text: string) => boolean,
  limits: OfficePackageLimits = OFFICE_PACKAGE_LIMITS
): boolean | null {
  return searchPackage(buffer, matches, limits, { inflated: 0 }, 0)
}

function searchPackage(
  buffer: Buffer,
  matches: (text: string) => boolean,
  limits: OfficePackageLimits,
  budget: { inflated: number },
  depth: number
): boolean | null {
  const entries = centralDirectory(buffer, limits.maxEntries)
  if (!entries) return null
  for (const entry of entries) {
    const embedded = EMBEDDED_PACKAGE.test(entry.name)
    if (!embedded && !TEXT_PART.test(entry.name)) continue
    if (embedded && depth >= limits.maxDepth) return null
    const data = entryData(buffer, entry, limits.maxInflatedBytes - budget.inflated)
    if (!data) return null
    budget.inflated += data.length
    const found = embedded
      ? searchPackage(data, matches, limits, budget, depth + 1)
      : xmlHasText(data.toString('utf8'), matches)
    if (found !== false) return found
  }
  return false
}

function xmlHasText(xml: string, matches: (text: string) => boolean): boolean {
  if (matches(decodeReferences(xml.replace(TAG, '')))) return true
  // One pass over the whole part: text that merely looks like an attribute is
  // text the first check already read, so reading it again costs nothing.
  for (const attribute of xml.matchAll(ATTRIBUTE_VALUE)) {
    if (matches(decodeReferences(attribute[1] ?? attribute[2] ?? ''))) return true
  }
  return false
}

function decodeReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (reference, decimal, hex, name) => {
    if (name) return NAMED_REFERENCES[name]
    const codePoint = decimal ? Number(decimal) : parseInt(hex, 16)
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : reference
  })
}

/** The entries the central directory lists; null for anything but a plain zip. */
function centralDirectory(buffer: Buffer, maxEntries: number): ZipEntry[] | null {
  // The end record is the last 22 bytes, followed by a comment of at most 65535.
  let end = -1
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) return null
  const count = buffer.readUInt16LE(end + 10)
  const size = buffer.readUInt32LE(end + 12)
  let at = buffer.readUInt32LE(end + 16)
  // ZIP64 markers: the generators never write one, so it is not read here.
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) return null
  if (count > maxEntries || at + size > end) return null
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) return null
    const nameLength = buffer.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32)
    if (next > end) return null
    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      flags: buffer.readUInt16LE(at + 8),
      method: buffer.readUInt16LE(at + 10),
      // From the central directory: writers that stream (ExcelJS) leave the
      // local header sizes zero.
      compressedSize: buffer.readUInt32LE(at + 20),
      localHeaderOffset: buffer.readUInt32LE(at + 42),
    })
    at = next
  }
  return entries
}

/** The entry's bytes, inflated within `remaining`; null when they cannot be read. */
function entryData(buffer: Buffer, entry: ZipEntry, remaining: number): Buffer | null {
  // Bit 0 marks an encrypted entry.
  if (entry.flags & 1 || remaining <= 0) return null
  const local = entry.localHeaderOffset
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_FILE_HEADER) return null
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const stop = start + entry.compressedSize
  if (stop > buffer.length) return null
  const data = buffer.subarray(start, stop)
  if (entry.method === 0) return data.length <= remaining ? data : null
  if (entry.method !== 8) return null
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: remaining })
  } catch {
    return null
  }
}
