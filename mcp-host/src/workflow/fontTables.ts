/**
 * Reads the tables of a TrueType or OpenType face, or of a face in a
 * collection: PostScript name, covered code points and metrics. Imports
 * nothing from fonts.ts, which builds COURIER_INFO with it at load.
 */
import * as fs from 'fs'

/**
 * One face for pdfmake: an embedded buffer, a path to a standalone file, or a
 * `[path, postScriptName]` pair addressing a face inside a collection.
 * pdfmake spreads an array descriptor into `pdfKitDoc.font(...)`, which is the
 * only way to open one face of a `.ttc`.
 */
export type PdfFace = Buffer | string | [string, string]

/** PostScript names read from each collection, by file. */
const faceNamesByFile = new Map<string, string[]>()

/**
 * PostScript names of the faces inside a TrueType Collection.
 *
 * Debian packages Noto CJK only as collections, and a collection cannot be
 * embedded in a PDF without naming which face to take — so without this, a
 * Chinese, Japanese or Korean document loses its text entirely. Parsed here
 * rather than through a font library because the only consumer of one is
 * pdfkit, reached through pdfmake.
 */
export function collectionFaceNames(file: string): string[] {
  const known = faceNamesByFile.get(file)
  if (known) return known
  const names =
    withFileReader(file, read => {
      const found: string[] = []
      for (const dirOffset of (collectionOffsets(read) ?? []).slice(0, 64)) {
        const name = postScriptName(read, tableDirectory(read, dirOffset))
        if (name && !found.includes(name)) found.push(name)
      }
      return found
    }) ?? []
  // Kept once read, so the faces a PDF names never hang on reading the file
  // again; a read that failed is tried again next time.
  if (names.length > 0) faceNamesByFile.set(file, names)
  return names
}

// What a face can draw is read from its cmap, which is exactly what pdfkit
// consults when it embeds text, instead of being inferred from a rendering.

/** `length` bytes at `offset`, or undefined when that runs past the end. */
type ByteReader = (offset: number, length: number) => Buffer | undefined

function bufferReader(buf: Buffer): ByteReader {
  return (offset, length) =>
    offset >= 0 && length >= 0 && offset + length <= buf.length
      ? buf.subarray(offset, offset + length)
      : undefined
}

/** Run `use` over `file`, reading only the byte ranges it asks for. */
function withFileReader<T>(file: string, use: (read: ByteReader) => T): T | undefined {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fs.fstatSync(fd).size
    return use((offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) return undefined
      const out = Buffer.alloc(length)
      fs.readSync(fd, out, 0, length, offset)
      return out
    })
  } catch {
    return undefined
  } finally {
    fs.closeSync(fd)
  }
}

/** Table-directory offsets of the faces in a collection; undefined for a single face. */
function collectionOffsets(read: ByteReader): number[] | undefined {
  const head = read(0, 12)
  if (!head || head.toString('latin1', 0, 4) !== 'ttcf') return undefined
  const count = head.readUInt32BE(8)
  const table = read(12, count * 4)
  if (!table) return []
  return Array.from({ length: count }, (_, i) => table.readUInt32BE(i * 4))
}

interface TableEntry {
  offset: number
  length: number
}

function tableDirectory(read: ByteReader, dirOffset: number): Map<string, TableEntry> {
  const tables = new Map<string, TableEntry>()
  const head = read(dirOffset, 12)
  if (!head) return tables
  const count = head.readUInt16BE(4)
  const records = read(dirOffset + 12, count * 16)
  if (!records) return tables
  for (let t = 0; t < count; t++) {
    const at = t * 16
    tables.set(records.toString('latin1', at, at + 4), {
      offset: records.readUInt32BE(at + 8),
      length: records.readUInt32BE(at + 12),
    })
  }
  return tables
}

function postScriptName(read: ByteReader, tables: Map<string, TableEntry>): string | undefined {
  const entry = tables.get('name')
  const table = entry && read(entry.offset, entry.length)
  if (!table || table.length < 6) return undefined
  const count = table.readUInt16BE(2)
  const stringOffset = table.readUInt16BE(4)
  for (let r = 0; r < count; r++) {
    const rec = 6 + r * 12
    if (rec + 12 > table.length) break
    // nameID 6 is the PostScript name, which is what pdfkit looks up.
    if (table.readUInt16BE(rec + 6) !== 6) continue
    const platformId = table.readUInt16BE(rec)
    const len = table.readUInt16BE(rec + 8)
    const off = stringOffset + table.readUInt16BE(rec + 10)
    if (off + len > table.length) continue
    const raw = Buffer.from(table.subarray(off, off + len))
    // Platforms 0 (Unicode) and 3 (Windows) store UTF-16BE; platform 1 is
    // single-byte. A record of odd length is malformed and read byte by byte.
    const wide = (platformId === 0 || platformId === 3) && raw.length % 2 === 0
    const text = wide ? raw.swap16().toString('utf16le') : raw.toString('latin1')
    const clean = text.replace(/[^\x20-\x7E]/g, '').trim()
    if (clean) return clean
  }
  return undefined
}

/** Appends `cp` to sorted `[first, last, ...]` ranges, extending the last one when adjacent. */
export function addCodePoint(ranges: number[], cp: number): void {
  const n = ranges.length
  if (n > 0 && ranges[n - 1] === cp - 1) ranges[n - 1] = cp
  else if (n === 0 || ranges[n - 1] < cp) ranges.push(cp, cp)
}

function format4Ranges(t: Buffer, off: number): number[] {
  const ranges: number[] = []
  const segX2 = t.readUInt16BE(off + 6)
  const ends = off + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const rangeOffsets = deltas + segX2
  if (rangeOffsets + segX2 > t.length) return ranges
  for (let s = 0; s < segX2 / 2; s++) {
    const end = t.readUInt16BE(ends + 2 * s)
    const start = t.readUInt16BE(starts + 2 * s)
    const delta = t.readUInt16BE(deltas + 2 * s)
    const ro = t.readUInt16BE(rangeOffsets + 2 * s)
    for (let c = start; c <= Math.min(end, 0xfffe); c++) {
      let glyph: number
      if (ro === 0) {
        glyph = (c + delta) & 0xffff
      } else {
        const at = rangeOffsets + 2 * s + ro + 2 * (c - start)
        glyph = at + 2 <= t.length ? t.readUInt16BE(at) : 0
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff
      }
      if (glyph !== 0) addCodePoint(ranges, c)
    }
  }
  return ranges
}

function format12Ranges(t: Buffer, off: number): number[] {
  const groups: Array<[number, number]> = []
  const count = t.readUInt32BE(off + 12)
  for (let g = 0; g < count; g++) {
    const at = off + 16 + g * 12
    if (at + 12 > t.length) break
    const first = t.readUInt32BE(at)
    const last = t.readUInt32BE(at + 4)
    // A group starting at glyph 0 maps its first code point to .notdef.
    const from = t.readUInt32BE(at + 8) === 0 ? first + 1 : first
    if (from <= last) groups.push([from, last])
  }
  groups.sort((a, b) => a[0] - b[0])
  const ranges: number[] = []
  for (const [first, last] of groups) {
    const n = ranges.length
    if (n > 0 && first <= ranges[n - 1] + 1) ranges[n - 1] = Math.max(ranges[n - 1], last)
    else ranges.push(first, last)
  }
  return ranges
}

/** Unicode ranges the face's cmap maps to a glyph, from its widest Unicode subtable. */
function cmapRanges(read: ByteReader, tables: Map<string, TableEntry>): number[] {
  const entry = tables.get('cmap')
  const t = entry && read(entry.offset, entry.length)
  if (!t || t.length < 4) return []
  let best: { off: number; format: number } | undefined
  for (let i = 0; i < t.readUInt16BE(2); i++) {
    const rec = 4 + i * 8
    if (rec + 8 > t.length) break
    const platform = t.readUInt16BE(rec)
    const encoding = t.readUInt16BE(rec + 2)
    const off = t.readUInt32BE(rec + 4)
    if (off + 16 > t.length) continue
    const format = t.readUInt16BE(off)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode || (format !== 4 && format !== 12)) continue
    if (!best || (format === 12 && best.format !== 12)) best = { off, format }
  }
  if (!best) return []
  return best.format === 12 ? format12Ranges(t, best.off) : format4Ranges(t, best.off)
}

export interface FaceInfo {
  /** Sorted `[first, last, ...]` code point ranges the face has glyphs for. */
  ranges: number[]
  /** Vertical metrics as pdfkit reads them, or undefined when the face has none. */
  metrics?: FaceMetrics
  /** Carries OpenType or AAT layout tables, so fontkit shapes and orders a right-to-left run itself. */
  shapes: boolean
  /** Has outlines pdfkit can embed; colour-bitmap emoji faces have none. */
  outlines: boolean
}

/** From `hhea` and `head`, the tables fontkit reads ascent and descent from. */
function faceMetrics(read: ByteReader, tables: Map<string, TableEntry>): FaceMetrics | undefined {
  const hhea = tables.get('hhea')
  const head = tables.get('head')
  const vertical = hhea && read(hhea.offset + 4, 4)
  const units = head && read(head.offset + 18, 2)
  const em = units?.readUInt16BE(0)
  if (!vertical || !em) return undefined
  const ascent = vertical.readInt16BE(0) / em
  return { ascent, lineHeight: ascent - vertical.readInt16BE(2) / em }
}

function faceInfoAt(read: ByteReader, dirOffset: number): FaceInfo {
  const tables = tableDirectory(read, dirOffset)
  return {
    ranges: cmapRanges(read, tables),
    metrics: faceMetrics(read, tables),
    shapes: tables.has('GSUB') || tables.has('GPOS') || tables.has('morx'),
    outlines:
      (tables.has('glyf') || tables.has('CFF ')) && !tables.has('CBDT') && !tables.has('sbix'),
  }
}

export function readFaceInfo(face: PdfFace): FaceInfo | undefined {
  if (Buffer.isBuffer(face)) {
    const read = bufferReader(face)
    return faceInfoAt(read, collectionOffsets(read)?.[0] ?? 0)
  }
  const [file, wanted] = Array.isArray(face) ? face : [face, undefined]
  return withFileReader(file, read => {
    const offsets = collectionOffsets(read)
    if (!offsets) return faceInfoAt(read, 0)
    const at = wanted
      ? offsets.find(o => postScriptName(read, tableDirectory(read, o)) === wanted)
      : offsets[0]
    return at === undefined ? undefined : faceInfoAt(read, at)
  })
}

/** The first letter `ranges` cover, to try a face with; "A" when they cover none. */
export function firstLetter(ranges: number[]): string {
  for (let i = 0; i < ranges.length; i += 2) {
    for (let cp = ranges[i]; cp <= ranges[i + 1] && cp - ranges[i] < 256; cp++) {
      const ch = String.fromCodePoint(cp)
      if (/\p{L}/u.test(ch)) return ch
    }
  }
  return 'A'
}

export function coversCodePoint(ranges: number[], cp: number): boolean {
  let lo = 0
  let hi = ranges.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < ranges[mid * 2]) hi = mid - 1
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1
    else return true
  }
  return false
}

/** Vertical metrics of a face in ems, as pdfkit uses them to lay out a line. */
export interface FaceMetrics {
  /** Height above the baseline. */
  ascent: number
  /** Ascent less descent: the height of one line before pdfmake's lineHeight factor. */
  lineHeight: number
}
