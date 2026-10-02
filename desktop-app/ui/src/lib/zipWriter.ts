/**
 * Minimal ZIP writer used by the client-side folder export (BUG-175).
 *
 * Entries are written with the STORED method (no compression): the archived
 * GFS payloads are already-encoded documents and media, an in-memory writer in
 * the renderer must stay small and deterministic, and a stored archive remains
 * a fully valid ZIP for every standard extractor. No compression also means
 * the total size guard can reason about byte budgets exactly.
 *
 * Memory contract (review M2): entries stream into ONE growable buffer as they
 * arrive — `addFile` copies the caller's bytes in and hands ownership back, so
 * per-entry buffers are released immediately instead of being retained until
 * assembly. `build()` appends the central directory in place and returns a
 * VIEW over the buffer, never a second copy. Callers that know the planned
 * content size (the zip walk does) pass `initialCapacityBytes` so the buffer
 * is allocated once; without it the buffer grows by doubling, whose last
 * reallocation transiently holds old + new buffers.
 *
 * Format reference: APPNOTE.TXT (PKWARE) — local file header (4.3.7), central
 * directory (4.3.12), end-of-central-directory (4.3.19). Names are UTF-8 with
 * the general-purpose flag bit 11 set. DOS timestamps are zero (deterministic
 * output; the source of truth for content dates is the GFS listing).
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
const UTF8_FLAG = 0x0800
const STORED_METHOD = 0
const EOCD_SIZE = 22
const LOCAL_HEADER_FIXED_SIZE = 30
const CENTRAL_HEADER_FIXED_SIZE = 46
const DEFAULT_INITIAL_CAPACITY_BYTES = 64 * 1024

const CRC32_POLYNOMIAL = 0xedb88320

let crc32Table: Uint32Array | null = null

function crc32TableFor(): Uint32Array {
  if (crc32Table) return crc32Table
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ CRC32_POLYNOMIAL : value >>> 1
    }
    table[index] = value >>> 0
  }
  crc32Table = table
  return table
}

/** Standard CRC-32 (IEEE 802.3, reflected), as stored in ZIP headers. */
export function crc32(bytes: Uint8Array): number {
  const table = crc32TableFor()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[index]!) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface DirectoryEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  localHeaderOffset: number
}

export interface CreateZipWriterOptions {
  /** Expected final archive size, when the caller can compute it up front. */
  initialCapacityBytes?: number
}

export interface ZipWriter {
  /** Adds one entry; returns the path actually written (see `addFile`). */
  addFile(path: string, bytes: Uint8Array): string
  /** True once any entry with this exact path was added. */
  has(path: string): boolean
  entryCount(): number
  /** Finalizes the archive and returns its bytes (a view — do not mutate). */
  build(): Uint8Array<ArrayBuffer>
}

function encodeName(path: string): Uint8Array {
  return new TextEncoder().encode(path)
}

export function createZipWriter(options: CreateZipWriterOptions = {}): ZipWriter {
  const entries: DirectoryEntry[] = []
  const usedNames = new Set<string>()

  let capacity = Math.max(1, options.initialCapacityBytes ?? DEFAULT_INITIAL_CAPACITY_BYTES)
  let buffer = new Uint8Array(capacity)
  let length = 0

  const ensureCapacity = (extra: number) => {
    if (length + extra <= capacity) return
    let next = capacity
    while (next < length + extra) next *= 2
    const grown = new Uint8Array(next)
    grown.set(buffer.subarray(0, length))
    buffer = grown
    capacity = next
  }

  const write = (source: Uint8Array) => {
    ensureCapacity(source.length)
    buffer.set(source, length)
    length += source.length
  }

  return {
    addFile(path, bytes) {
      const writtenPath = ensureUniqueName(path, usedNames)
      usedNames.add(writtenPath)
      const nameBytes = encodeName(writtenPath)
      const crc = crc32(bytes)
      const localHeaderOffset = length

      const header = new Uint8Array(LOCAL_HEADER_FIXED_SIZE + nameBytes.length)
      const view = new DataView(header.buffer)
      view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true)
      view.setUint16(4, VERSION_NEEDED, true)
      view.setUint16(6, UTF8_FLAG, true)
      view.setUint16(8, STORED_METHOD, true)
      view.setUint16(10, 0, true) // mod time
      view.setUint16(12, 0, true) // mod date
      view.setUint32(14, crc, true)
      view.setUint32(18, bytes.length, true) // compressed size (stored)
      view.setUint32(22, bytes.length, true) // uncompressed size
      view.setUint16(26, nameBytes.length, true)
      view.setUint16(28, 0, true) // extra length
      header.set(nameBytes, LOCAL_HEADER_FIXED_SIZE)
      write(header)
      // Copy the payload into the archive buffer; after this returns the
      // caller's per-entry buffer is no longer referenced (M2).
      write(bytes)

      entries.push({ nameBytes, crc, size: bytes.length, localHeaderOffset })
      return writtenPath
    },

    has(path) {
      return usedNames.has(path)
    },

    entryCount() {
      return entries.length
    },

    build() {
      const centralDirectoryOffset = length
      for (const entry of entries) {
        const record = new Uint8Array(CENTRAL_HEADER_FIXED_SIZE + entry.nameBytes.length)
        const view = new DataView(record.buffer)
        view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true)
        view.setUint16(4, VERSION_NEEDED, true) // made by
        view.setUint16(6, VERSION_NEEDED, true) // needed
        view.setUint16(8, UTF8_FLAG, true)
        view.setUint16(10, STORED_METHOD, true)
        view.setUint16(12, 0, true) // mod time
        view.setUint16(14, 0, true) // mod date
        view.setUint32(16, entry.crc, true)
        view.setUint32(20, entry.size, true)
        view.setUint32(24, entry.size, true)
        view.setUint16(28, entry.nameBytes.length, true)
        view.setUint16(30, 0, true) // extra length
        view.setUint16(32, 0, true) // comment length
        view.setUint16(34, 0, true) // disk start
        view.setUint16(36, 0, true) // internal attributes
        view.setUint32(38, 0, true) // external attributes
        view.setUint32(42, entry.localHeaderOffset, true)
        record.set(entry.nameBytes, CENTRAL_HEADER_FIXED_SIZE)
        write(record)
      }
      const centralDirectorySize = length - centralDirectoryOffset

      const eocd = new Uint8Array(EOCD_SIZE)
      const view = new DataView(eocd.buffer)
      view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true)
      view.setUint16(4, 0, true) // this disk
      view.setUint16(6, 0, true) // central directory disk
      view.setUint16(8, entries.length, true)
      view.setUint16(10, entries.length, true)
      view.setUint32(12, centralDirectorySize, true)
      view.setUint32(16, centralDirectoryOffset, true)
      view.setUint16(20, 0, true) // comment length
      write(eocd)
      return buffer.subarray(0, length)
    },
  }
}

/** `a/b.txt` → `a/b (2).txt` style de-duplication for repeated zip names. */
function ensureUniqueName(path: string, usedNames: Set<string>): string {
  if (!usedNames.has(path)) return path
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const extension = dot > 0 ? base.slice(dot) : ''
  let counter = 2
  let candidate = `${directory}${stem} (${counter})${extension}`
  while (usedNames.has(candidate)) {
    counter += 1
    candidate = `${directory}${stem} (${counter})${extension}`
  }
  return candidate
}
