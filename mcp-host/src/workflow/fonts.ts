/**
 * Font provisioning for the artifact renderers.
 *
 * Both renderers start from the Roboto faces pdfmake vendors as base64,
 * registered from memory, so text renders even on an image without system
 * fonts (where @napi-rs/canvas would measure every string at zero width) and a
 * PDF never falls back to the Latin-1-only standard-14 Helvetica.
 *
 * Roboto carries no arrows, check marks or CJK. Where the image ships fonts
 * that do, the canvas fallback stack reaches them and a PDF run switches to a
 * face that has the character; where it ships none, the text is rewritten or
 * reported. Chart coverage is measured by rendering, PDF coverage read from
 * each face's cmap, so neither is assumed.
 */
import { GlobalFonts, type SKRSContext2D, createCanvas } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as path from 'path'

/** Family the bundled Roboto is registered under. */
export const CHART_FONT_FAMILY = 'Clerum Sans'

/** Family name registered with pdfmake. */
export const PDF_FONT_FAMILY = 'ClerumSans'

/** Family pdfmake uses for code blocks and inline code. */
export const PDF_MONO_FAMILY = 'ClerumMono'

/**
 * Family list handed to the canvas. Roboto first so output is identical across
 * images; the rest are picked up only when the image ships them, which is what
 * makes arrows, check marks and CJK render natively where they exist.
 */
export const CHART_FONT_STACK =
  `"${CHART_FONT_FAMILY}", "DejaVu Sans", "Noto Sans", "Liberation Sans", ` +
  '"Noto Sans CJK SC", "Noto Sans CJK JP", "Arial Unicode MS", sans-serif'

interface RobotoFaces {
  normal: Buffer
  bold: Buffer
  italics: Buffer
  bolditalics: Buffer
}

/**
 * Directories scanned for extra faces. Registering them is what puts the
 * fallback families above within the canvas's reach. Absent dirs are skipped.
 */
const SYSTEM_FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/opt/fonts',
  '/System/Library/Fonts',
]

/** Private Use codepoint — no real font claims it, so it renders as "missing". */
const MISSING_PROBE = '\uE000'

let faces: RobotoFaces | undefined
let ready = false

function loadRobotoFaces(): RobotoFaces {
  if (faces) return faces
  // pdfmake's vfs export shape differs across builds (`pdfMake.vfs`, `vfs`, or
  // the table itself), so probe rather than pin to one of them.
  const mod = require('pdfmake/build/vfs_fonts.js')
  const table: Record<string, string> = mod?.pdfMake?.vfs ?? mod?.vfs ?? mod
  const decode = (name: string): Buffer => {
    const b64 = table[name]
    if (typeof b64 !== 'string') throw new Error(`pdfmake vfs is missing ${name}`)
    return Buffer.from(b64, 'base64')
  }
  faces = {
    normal: decode('Roboto-Regular.ttf'),
    bold: decode('Roboto-Medium.ttf'),
    italics: decode('Roboto-Italic.ttf'),
    bolditalics: decode('Roboto-MediumItalic.ttf'),
  }
  return faces
}

function walk(dir: string, depth: number): string[] {
  if (depth > 3) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, depth + 1))
    else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) out.push(full)
  }
  return out
}

function registerSystemFonts(): void {
  for (const dir of SYSTEM_FONT_DIRS) {
    let files: string[]
    try {
      if (!fs.existsSync(dir)) continue
      files = walk(dir, 0)
    } catch {
      continue
    }
    for (const file of files) {
      try {
        GlobalFonts.registerFromPath(file)
      } catch {
        // A face the renderer cannot parse is simply not available.
      }
    }
  }
}

/**
 * Register the bundled faces (and any system faces) exactly once. Safe to call
 * from every render path; later calls are free.
 */
export function ensureFontsReady(): void {
  if (ready) return
  ready = true
  const f = loadRobotoFaces()
  GlobalFonts.register(f.normal, CHART_FONT_FAMILY)
  GlobalFonts.register(f.bold, `${CHART_FONT_FAMILY} Bold`)
  registerSystemFonts()
}

/**
 * Families a PDF can be built from, widest coverage first.
 *
 * The body family is the widest one present, since every run starts in it:
 * DejaVu and Noto carry the arrows and check marks Roboto lacks; anything
 * the body face still lacks falls back per run.
 * Matching is by family prefix rather than exact filename because the same
 * family is packaged under different names — `DejaVuSans.ttf` on one image,
 * `NotoSans-Regular.ttf` on another — and a missed guess would silently drop
 * back to the narrower face.
 */
const PDF_FAMILY_PREFIXES = [
  'NotoSans',
  'DejaVuSans',
  'LiberationSans',
  'NotoSansSC',
  'NotoSerifSC',
]

/** Fixed-width families, for code blocks. */
const MONO_FAMILY_PREFIXES = ['DejaVuSansMono', 'NotoSansMono', 'LiberationMono', 'DejaVuSerifMono']

/**
 * One face for pdfmake: an embedded buffer, a path to a standalone file, or a
 * `[path, postScriptName]` pair addressing a face inside a collection.
 * pdfmake spreads an array descriptor into `pdfKitDoc.font(...)`, which is the
 * only way to open one face of a `.ttc`.
 */
type PdfFace = Buffer | string | [string, string]

interface PdfFaces {
  normal: PdfFace
  bold: PdfFace
  italics: PdfFace
  bolditalics: PdfFace
}

let pdfFaces: PdfFaces | undefined
let monoFaces: PdfFaces | undefined
let faceIndex: Map<string, string> | undefined

/**
 * Every embeddable face on this image, keyed by lowercased basename.
 *
 * TrueType Collections are left out on purpose: pdfkit subsets a single face
 * and cannot open a `.ttc` without being told which face inside it to use, so
 * handing it one fails the whole document with "createSubset is not a
 * function". The canvas has no such limit and keeps using them.
 */
function embeddableFaces(): Map<string, string> {
  if (faceIndex) return faceIndex
  const index = new Map<string, string>()
  for (const dir of SYSTEM_FONT_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue
      for (const file of walk(dir, 0)) {
        if (!/\.(ttf|otf)$/i.test(file)) continue
        const stem = path
          .basename(file)
          .replace(/\.(ttf|otf)$/i, '')
          .toLowerCase()
        if (!index.has(stem)) index.set(stem, file)
      }
    } catch {
      continue
    }
  }
  faceIndex = index
  return index
}

/** First face matching any of `stems`, in order. */
function pickFace(stems: string[]): string | undefined {
  const index = embeddableFaces()
  for (const stem of stems) {
    const hit = index.get(stem.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

/**
 * Resolve one family's four faces from a prefix, accepting both the bare and
 * the `-Regular` spelling, and falling back to the regular face for styles the
 * image does not ship.
 */
function facesForPrefix(prefix: string): PdfFaces | undefined {
  const normal = pickFace([prefix, `${prefix}-Regular`, `${prefix}-Book`])
  if (!normal) return undefined
  const bold = pickFace([`${prefix}-Bold`, `${prefix}Bold`]) ?? normal
  const italics = pickFace([`${prefix}-Italic`, `${prefix}-Oblique`, `${prefix}Oblique`]) ?? normal
  const bolditalics =
    pickFace([`${prefix}-BoldItalic`, `${prefix}-BoldOblique`, `${prefix}BoldOblique`]) ?? bold
  return { normal, bold, italics, bolditalics }
}

/**
 * Probes for a broad face: an arrow, a check mark and a Han character, which
 * Roboto lacks, and ≥, α and я, which a broad face also draws. A face scores
 * by how many it can draw.
 */
const COVERAGE_PROBES = ['\u2192', '\u2713', '\u4E2D', '\u2265', '\u03B1', '\u044F']

/**
 * A usable body face has to draw ordinary letters and digits. Checked because
 * an image can ship fonts whose name suggests broad coverage but which hold
 * only symbols — macOS packages one called `CJKSymbolsFallback` — and taking
 * one of those would leave a document with no readable text at all.
 */
const LATIN_PROBES = ['A', 'g', '0']

/**
 * How many probe characters `file` can draw, measured by rendering them.
 * Returns -1 for a face that cannot set plain Latin, which disqualifies it.
 */
function coverageScore(file: string): number {
  const alias = '__ClerumProbeFace'
  try {
    GlobalFonts.registerFromPath(file, alias)
  } catch {
    return -1
  }
  const font = `"${alias}"`
  const missing = renderSignature(MISSING_PROBE, font)
  const blank = renderSignature(' ', font)
  for (const ch of LATIN_PROBES) {
    const sig = renderSignature(ch, font)
    if (sig === missing || sig === blank) return -1
  }
  let score = 0
  for (const ch of COVERAGE_PROBES) {
    if (renderSignature(ch, font) !== missing) score++
  }
  return score
}

/**
 * PostScript names of the faces inside a TrueType Collection.
 *
 * Debian packages Noto CJK only as collections, and a collection cannot be
 * embedded in a PDF without naming which face to take — so without this, a
 * Chinese, Japanese or Korean document loses its text entirely. Parsed here
 * rather than through a font library because the only consumer of one is
 * pdfkit, reached through pdfmake.
 */
function collectionFaceNames(file: string): string[] {
  return (
    withFileReader(file, read => {
      const names: string[] = []
      for (const dirOffset of (collectionOffsets(read) ?? []).slice(0, 64)) {
        const name = postScriptName(read, tableDirectory(read, dirOffset))
        if (name && !names.includes(name)) names.push(name)
      }
      return names
    }) ?? []
  )
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
function addCodePoint(ranges: number[], cp: number): void {
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

interface FaceInfo {
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

function readFaceInfo(face: PdfFace): FaceInfo | undefined {
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
function firstLetter(ranges: number[]): string {
  for (let i = 0; i < ranges.length; i += 2) {
    for (let cp = ranges[i]; cp <= ranges[i + 1] && cp - ranges[i] < 256; cp++) {
      const ch = String.fromCodePoint(cp)
      if (/\p{L}/u.test(ch)) return ch
    }
  }
  return 'A'
}

function coversCodePoint(ranges: number[], cp: number): boolean {
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

/** Collections worth embedding, and the script variants to prefer within them. */
const COLLECTION_PREFERENCE = [/CJKsc-/i, /CJKjp-/i, /CJKtc-/i, /CJKkr-/i, /CJKhk-/i]

/**
 * Faces from a collection on disk, preferring a proportional script variant
 * over the monospaced ones. Returns undefined when the file names no usable
 * face, so the caller can move on to the next candidate.
 */
function facesFromCollection(file: string, boldFile?: string): PdfFaces | undefined {
  const names = collectionFaceNames(file).filter(n => !/Mono/i.test(n))
  if (names.length === 0) return undefined
  const pick =
    COLLECTION_PREFERENCE.map(re => names.find(n => re.test(n))).find(Boolean) ?? names[0]
  const boldNames = boldFile ? collectionFaceNames(boldFile).filter(n => !/Mono/i.test(n)) : []
  const boldPick =
    COLLECTION_PREFERENCE.map(re => boldNames.find(n => re.test(n))).find(Boolean) ?? boldNames[0]
  const normal: PdfFace = [file, pick]
  const bold: PdfFace = boldFile && boldPick ? [boldFile, boldPick] : normal
  return { normal, bold, italics: normal, bolditalics: bold }
}

/** Collections on this image, keyed by lowercased basename. */
function embeddableCollections(): Map<string, string> {
  if (collectionIndex) return collectionIndex
  const index = new Map<string, string>()
  for (const dir of SYSTEM_FONT_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue
      for (const file of walk(dir, 0)) {
        if (!/\.ttc$/i.test(file)) continue
        const stem = path
          .basename(file)
          .replace(/\.ttc$/i, '')
          .toLowerCase()
        if (!index.has(stem)) index.set(stem, file)
      }
    } catch {
      continue
    }
  }
  collectionIndex = index
  return index
}

let collectionIndex: Map<string, string> | undefined

/**
 * The best CJK-capable collection the image ships, chosen by what it can
 * actually draw rather than by its filename.
 */
function cjkCollectionFaces(): PdfFaces | undefined {
  const collections = embeddableCollections()
  let best: { faces: PdfFaces; score: number } | undefined
  for (const [stem, file] of collections) {
    if (!/cjk/.test(stem) || /serif/.test(stem) || /bold/.test(stem)) continue
    const score = coverageScore(file)
    // Rejects a symbols-only fallback, which sets no Latin and would leave the
    // document unreadable.
    if (score <= 0) continue
    const boldFile = collections.get(stem.replace(/-regular$/, '-bold'))
    const faces = facesFromCollection(file, boldFile)
    if (faces && (!best || score > best.score)) best = { faces, score }
  }
  return best?.faces
}

function resolvePdfFaces(): PdfFaces {
  if (pdfFaces) return pdfFaces
  ensureFontsReady()
  // A family with a real italic face comes first, since *emphasis* is drawn
  // upright in one without; CJK falls back per character to the collection.
  // Only an image with no standalone family takes the collection as body.
  const named = PDF_FAMILY_PREFIXES.map(prefix => () => facesForPrefix(prefix))
  const withItalic = named.map(faces => () => {
    const found = faces()
    return found && found.italics !== found.normal ? found : undefined
  })
  const candidates: Array<() => PdfFaces | undefined> = [
    ...withItalic,
    ...named,
    cjkCollectionFaces,
  ]
  let chosen: PdfFaces | undefined
  for (const candidate of candidates) {
    const faces = candidate()
    if (faces && embeds(faces, 'Ag0')) {
      chosen = faces
      break
    }
  }
  if (chosen) {
    // Registering the chosen family under the PDF alias lets text be measured
    // in the face the PDF will embed.
    const file = Array.isArray(chosen.normal) ? chosen.normal[0] : chosen.normal
    try {
      if (typeof file === 'string') GlobalFonts.registerFromPath(file, PDF_FONT_FAMILY)
      pdfFaces = chosen
      return pdfFaces
    } catch {
      // Unparseable face: fall through to the bundled one.
    }
  }
  const roboto = loadRobotoFaces()
  GlobalFonts.register(roboto.normal, PDF_FONT_FAMILY)
  pdfFaces = roboto
  return pdfFaces
}

function resolveMonoFaces(): PdfFaces {
  if (monoFaces) return monoFaces
  ensureFontsReady()
  for (const prefix of MONO_FAMILY_PREFIXES) {
    const faces = facesForPrefix(prefix)
    if (faces && embeds(faces, 'Ag0')) {
      monoFaces = faces
      return monoFaces
    }
  }
  // No fixed-width face on this image. The body face would render the block
  // but lose its column alignment, so Western text goes to the PDF viewer's
  // built-in Courier and everything else falls back per character to embedded faces.
  monoFaces = COURIER_FACES
  return monoFaces
}

/** The standard-14 Courier. pdfkit encodes it as WinAnsi, so it can draw only that set. */
const COURIER_FACES: PdfFaces = {
  normal: 'Courier',
  bold: 'Courier-Bold',
  italics: 'Courier-Oblique',
  bolditalics: 'Courier-BoldOblique',
}

/** Courier's advance width, in ems, for every character it is given. */
const COURIER_ADVANCE = 0.6

/** What pdfkit knows of Courier: WinAnsi coverage, and the ascent (629) and descent (-157) of its AFM. */
const COURIER_INFO: FaceInfo = (() => {
  const ranges: number[] = []
  const winAnsi = [
    0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018,
    0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a,
    0x20ac, 0x2122,
  ]
  for (let cp = 0x20; cp <= 0x7e; cp++) addCodePoint(ranges, cp)
  for (let cp = 0xa0; cp <= 0xff; cp++) addCodePoint(ranges, cp)
  for (const cp of winAnsi) addCodePoint(ranges, cp)
  return { ranges, metrics: { ascent: 0.629, lineHeight: 0.786 }, shapes: false, outlines: true }
})()

/** Font descriptors for `new PdfPrinter(...)`, keyed by the families pdfmake uses. */
export function pdfFontDescriptors(): Record<string, PdfFaces> {
  return {
    [PDF_FONT_FAMILY]: resolvePdfFaces(),
    [PDF_MONO_FAMILY]: resolveMonoFaces(),
  }
}

// pdfmake embeds whatever family a run names, so a character the body face
// lacks is drawn by giving its run another family. Arabic and Hebrew come from
// here unless the body face draws them.

/**
 * Faces tried, in order, for a character the run's own face lacks. The script
 * faces lead so Arabic and Hebrew are set in faces drawn for them rather than
 * in a broad face that carries a few of their letters.
 */
const SCRIPT_FALLBACK_PREFIXES = [
  // Alpine's Noto Sans Arabic draws letters as a dotless base shared by several
  // letters plus dot marks, and pdfkit's ToUnicode map gives each glyph one
  // letter, so the text layer reads wrong letters; its UI build does not.
  'NotoSansArabicUI',
  'NotoSansArabic',
  'NotoNaskhArabic',
  'NotoKufiArabic',
  'NotoSansHebrew',
  'NotoSerifHebrew',
  'NotoRashiHebrew',
]

/** Tried after the script faces and the CJK collection. */
const FALLBACK_PREFIXES = [
  'DejaVuSans',
  'NotoSans',
  'LiberationSans',
  'NotoSansSymbols2',
  'NotoSansSymbols',
  'NotoSansMath',
]

/**
 * Faces for further scripts, tried last. Only faces that fontkit shaped
 * thousands of random sequences with, without hanging or running out of memory,
 * are listed; fontkit loops forever on some Meetei Mayek, Kaithi and Nastaliq
 * sequences, so no installed face is used unlisted.
 */
const MORE_SCRIPT_PREFIXES = [
  'NotoSansDevanagari',
  'NotoSansBengali',
  'NotoSansGurmukhi',
  'NotoSansGujarati',
  'NotoSansOriya',
  'NotoSansTamil',
  'NotoSansTelugu',
  'NotoSansKannada',
  'NotoSansMalayalam',
  'NotoSansThai',
  'NotoSansLao',
  'NotoSansKhmer',
  'NotoSansMyanmar',
  'NotoSansArmenian',
  'NotoSansGeorgian',
  'NotoSansEthiopic',
]

interface FallbackFamily {
  family: string
  faces: PdfFaces
}

/** Vertical metrics of a face in ems, as pdfkit uses them to lay out a line. */
export interface FaceMetrics {
  /** Height above the baseline. */
  ascent: number
  /** Ascent less descent: the height of one line before pdfmake's lineHeight factor. */
  lineHeight: number
}

/** Everything a PDF typesetter needs to know about the faces available to it. */
export interface PdfGlyphSource {
  /** Family that can draw `cp` in a run set in `base`, or undefined when no face can. */
  familyFor(cp: number, base: string): string | undefined
  /** Whether `family` is one familyFor falls back to, rather than a body or code face. */
  isFallback(family: string): boolean
  /** Whether pdfkit lays out every one of `texts` in `family` without failing. */
  shapes(family: string, texts: string[]): boolean
  /** Whether fontkit puts a right-to-left run set in `family` into display order itself. */
  reversesRtl(family: string): boolean
  /** Advance width of `text` set in `family` at `size` points. */
  measure(text: string, family: string, size: number, bold: boolean): number
  /** Vertical metrics of `family`, or undefined when unknown. */
  metrics(family: string): FaceMetrics | undefined
  /** pdfmake descriptors for `families`, always including the body and mono ones. */
  descriptors(families: Iterable<string>): Record<string, PdfFaces>
}

function faceFile(face: PdfFace): string | undefined {
  if (Buffer.isBuffer(face)) return undefined
  return Array.isArray(face) ? face[0] : face
}

/**
 * Whether pdfkit can lay out and embed each of `texts` in `faces`. Some faces
 * an image ships parse for their cmap yet fail inside pdfkit ("Not a fixed
 * size"), and fontkit throws on some sequences it cannot shape; either, in a
 * single run, fails the whole document.
 */
function embeds(faces: PdfFaces, texts: string | string[]): boolean {
  try {
    const PdfPrinter = require('pdfmake')
    const doc = new PdfPrinter({ Probe: faces }).createPdfKitDocument({
      content: (Array.isArray(texts) ? texts : [texts]).map(text => ({ text, font: 'Probe' })),
      defaultStyle: { font: 'Probe' },
    })
    doc.on('data', () => undefined)
    doc.end()
    return true
  } catch {
    return false
  }
}

function discoverFallbacks(exclude: Set<string>): FallbackFamily[] {
  const out: FallbackFamily[] = []
  const seen = new Set<string>()
  const add = (prefix: string): void => {
    const faces = facesForPrefix(prefix)
    const file = faces && faceFile(faces.normal)
    if (!faces || !file || seen.has(file) || exclude.has(file)) return
    seen.add(file)
    out.push({ family: `Fallback-${prefix}`, faces })
  }
  SCRIPT_FALLBACK_PREFIXES.forEach(add)
  const cjk = cjkCollectionFaces()
  const cjkFile = cjk && faceFile(cjk.normal)
  if (cjk && cjkFile && !exclude.has(cjkFile)) {
    seen.add(cjkFile)
    out.push({ family: 'Fallback-CJK', faces: cjk })
  }
  FALLBACK_PREFIXES.forEach(add)
  MORE_SCRIPT_PREFIXES.forEach(add)
  return out
}

class GlyphSource implements PdfGlyphSource {
  private readonly info = new Map<string, FaceInfo | undefined>()
  private readonly chosen = new Map<string, string | undefined>()
  private readonly embeddable = new Map<string, boolean>()
  // resolvePdfFaces registers the body family with the canvas itself.
  private readonly registered = new Set<string>([PDF_FONT_FAMILY])
  private fallbacks?: FallbackFamily[]
  private ctx?: SKRSContext2D

  private facesOf(family: string): PdfFaces | undefined {
    if (family === PDF_FONT_FAMILY) return resolvePdfFaces()
    if (family === PDF_MONO_FAMILY) return resolveMonoFaces()
    return this.fallbackList().find(f => f.family === family)?.faces
  }

  private fallbackList(): FallbackFamily[] {
    if (!this.fallbacks) {
      const exclude = new Set<string>()
      for (const faces of [resolvePdfFaces(), resolveMonoFaces()]) {
        const file = faceFile(faces.normal)
        if (file) exclude.add(file)
      }
      this.fallbacks = discoverFallbacks(exclude)
    }
    return this.fallbacks
  }

  private infoOf(family: string): FaceInfo | undefined {
    if (!this.info.has(family)) {
      const faces = this.facesOf(family)
      let info: FaceInfo | undefined
      if (faces === COURIER_FACES) info = COURIER_INFO
      else if (faces) info = readFaceInfo(faces.normal)
      this.info.set(family, info?.outlines ? info : undefined)
    }
    return this.info.get(family)
  }

  private covers(family: string, cp: number): boolean {
    const info = this.infoOf(family)
    return info !== undefined && coversCodePoint(info.ranges, cp)
  }

  /**
   * A fallback face is tried in pdfkit once, with a letter of its own: a
   * character a caller sent, such as a lone combining sign, can fail where the
   * face is sound, and the answer is kept for the whole process.
   */
  private usable(fallback: FallbackFamily): boolean {
    let ok = this.embeddable.get(fallback.family)
    if (ok === undefined) {
      ok = embeds(fallback.faces, firstLetter(this.infoOf(fallback.family)?.ranges ?? []))
      this.embeddable.set(fallback.family, ok)
    }
    return ok
  }

  isFallback(family: string): boolean {
    return this.fallbackList().some(f => f.family === family)
  }

  shapes(family: string, texts: string[]): boolean {
    const faces = this.facesOf(family)
    return !faces || embeds(faces, texts)
  }

  familyFor(cp: number, base: string): string | undefined {
    const key = `${base}\u0000${cp}`
    if (this.chosen.has(key)) return this.chosen.get(key)
    let hit: string | undefined
    if (this.covers(base, cp)) hit = base
    else if (base !== PDF_FONT_FAMILY && this.covers(PDF_FONT_FAMILY, cp)) hit = PDF_FONT_FAMILY
    else {
      hit = this.fallbackList().find(f => this.covers(f.family, cp) && this.usable(f))?.family
    }
    this.chosen.set(key, hit)
    return hit
  }

  reversesRtl(family: string): boolean {
    return this.infoOf(family)?.shapes ?? false
  }

  metrics(family: string): FaceMetrics | undefined {
    return this.infoOf(family)?.metrics
  }

  measure(text: string, family: string, size: number, bold: boolean): number {
    const faces = this.facesOf(family)
    if (!faces || faces === COURIER_FACES) return [...text].length * size * COURIER_ADVANCE
    // The bold face is registered on its own, because the canvas would
    // otherwise embolden the regular one, which is narrower than the face
    // pdfkit embeds.
    const face = bold ? faces.bold : faces.normal
    const alias = bold ? `${family} Bold` : family
    if (!this.registered.has(alias)) {
      this.registered.add(alias)
      ensureFontsReady()
      try {
        if (Buffer.isBuffer(face)) GlobalFonts.register(face, alias)
        else GlobalFonts.registerFromPath(faceFile(face)!, alias)
      } catch {
        // Measured with the canvas default instead; only line breaking is approximate.
      }
    }
    this.ctx ??= createCanvas(8, 8).getContext('2d')
    this.ctx.font = `${size}px "${alias}"`
    return this.ctx.measureText(text).width
  }

  descriptors(families: Iterable<string>): Record<string, PdfFaces> {
    const out = pdfFontDescriptors()
    for (const family of families) {
      const faces = this.facesOf(family)
      if (faces) out[family] = faces
    }
    return out
  }
}

let glyphSource: GlyphSource | undefined

/** The faces this image offers the PDF renderer, with per-character fallback between them. */
export function pdfGlyphSource(): PdfGlyphSource {
  glyphSource ??= new GlyphSource()
  return glyphSource
}

// ─── Glyph coverage ──────────────────────────────────────────────────
//
// Chart text is checked by rendering it through the canvas fallback stack.
// PDFs do not use this: pdfGlyphSource reads each face's cmap and falls back
// per character.

let missingSignature: string | undefined
const coverage = new Map<number, boolean>()

/**
 * Signature of the pixels a character leaves when drawn in `font`.
 *
 * A plain ink count is not enough to tell a real glyph from the missing-glyph
 * box: the two collide whenever they happen to darken the same number of
 * pixels, and the character is then rewritten even though the font could draw
 * it. Hashing the bitmap makes a collision effectively impossible.
 */
function renderSignature(ch: string, font: string): string {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#000000'
  ctx.font = `36px ${font}`
  ctx.fillText(ch, 6, 46)
  const data = ctx.getImageData(0, 0, 64, 64).data
  // FNV-1a over the thresholded (ink / no ink) bitmap, plus the ink count so an
  // all-blank render stands out when debugging.
  let hash = 0x811c9dc5
  let ink = 0
  for (let i = 0; i < data.length; i += 4) {
    const dark = data[i] < 128 ? 1 : 0
    if (dark) ink++
    hash ^= dark
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${ink}:${hash.toString(36)}`
}

/**
 * Whether the chart fonts can actually draw `ch`. Determined by rendering,
 * because a font reports a width for glyphs it substitutes.
 */
export function canRender(ch: string): boolean {
  const cp = ch.codePointAt(0)
  if (cp === undefined || cp < 0x80) return true
  const cached = coverage.get(cp)
  if (cached !== undefined) return cached
  let ok: boolean
  try {
    ensureFontsReady()
    missingSignature ??= renderSignature(MISSING_PROBE, CHART_FONT_STACK)
    ok = renderSignature(ch, CHART_FONT_STACK) !== missingSignature
  } catch {
    ok = false
  }
  coverage.set(cp, ok)
  return ok
}

/**
 * ASCII stand-ins for symbols models reach for constantly. Charts apply them
 * only when the character cannot be drawn; PDFs always apply them to emoji,
 * which no embedded face draws in color.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '\u2192': '->',
  '\u27F6': '->',
  '\u279C': '->',
  '\u2794': '->',
  '\u2190': '<-',
  '\u2194': '<->',
  '\u21D2': '=>',
  '\u21D0': '<=',
  '\u21D4': '<=>',
  '\u2191': '^',
  '\u2193': 'v',
  '\u2713': 'OK',
  '\u2714': 'OK',
  '\u2611': '[x]',
  '\u2717': 'X',
  '\u2718': 'X',
  '\u2612': '[x]',
  '\u2248': '~',
  '\u2265': '>=',
  '\u2264': '<=',
  '\u2260': '!=',
  '\u2261': '==',
  '\u221E': 'inf',
  '\u2022': '*',
  '\u2023': '-',
  '\u25AA': '-',
  '\u25AB': '-',
  '\u25E6': '-',
  '\u25CF': '*',
  '\u25CB': 'o',
  '\u2605': '*',
  '\u2606': '*',
  '\u26A0': '!',
  '\u2122': '(TM)',
  '\u2120': '(SM)',
  '\u2014': '-',
  '\u2013': '-',
  '\u2026': '...',
  '\u201C': '"',
  '\u201D': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u2010': '-',
  '\u2011': '-',
  '\u2212': '-',
  // Space variants: locale-formatted numbers and times carry U+202F and U+00A0.
  '\u00A0': ' ',
  '\u2000': ' ',
  '\u2001': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  // A figure space and a narrow no-break space keep a number or a time such as
  // '8:11 PM' on one line, so they stand in as a no-break space.
  '\u2007': '\u00A0',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200A': ' ',
  '\u202F': '\u00A0',
  '\u205F': ' ',
  '\u3000': ' ',
  // Status emoji, which models often put alone in a table cell. No embedded
  // face draws them in colour, and a coloured circle means only its colour,
  // so they become words.
  '\u2705': 'OK',
  '\u2716': 'X',
  '\u274c': 'X',
  '\u274e': 'X',
  '\u2757': '!',
  '\u2755': '!',
  '\u2753': '?',
  '\u2754': '?',
  '\u2b50': '*',
  '\u2b06': '^',
  '\u2b07': 'v',
  '\u27a1': '->',
  '\u2b05': '<-',
  '\u{1F7E2}': '(green)',
  '\u{1F7E1}': '(yellow)',
  '\u{1F7E0}': '(orange)',
  '\u{1F534}': '(red)',
  '\u{1F535}': '(blue)',
  '\u{1F7E3}': '(purple)',
  '\u{1F7E4}': '(brown)',
  '\u26ab': '(black)',
  '\u26aa': '(white)',
  '\u{1F7E9}': '(green)',
  '\u{1F7E8}': '(yellow)',
  '\u{1F7E7}': '(orange)',
  '\u{1F7E5}': '(red)',
  '\u{1F7E6}': '(blue)',
  '\u{1F7EA}': '(purple)',
  '\u{1F7EB}': '(brown)',
  '\u2b1b': '(black)',
  '\u2b1c': '(white)',
  '\u{1F4C8}': '(up)',
  '\u{1F4C9}': '(down)',
}

/** The ASCII stand-in for a symbol or status emoji, when one is defined. */
export function asciiStandIn(ch: string): string | undefined {
  return SUBSTITUTIONS[ch]
}

/** Zero-width joiners, variation selectors and byte-order marks — safe to drop. */
const INVISIBLE = /[\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF]/g

const NON_ASCII = /[^\x00-\x7F]/

/**
 * Rewrite chart text so every character survives rendering. Characters the
 * chart fonts cover are untouched; the rest become their ASCII stand-in, and
 * anything with no stand-in is dropped rather than drawn as a blank box.
 */
export function sanitizeForFont(text: string): string {
  if (!text || !NON_ASCII.test(text)) return text

  let out = ''
  for (const ch of text.replace(INVISIBLE, '')) {
    if (canRender(ch)) {
      out += ch
      continue
    }
    const sub = SUBSTITUTIONS[ch]
    if (sub !== undefined) out += sub
    // No stand-in and no glyph: dropped, which keeps the surrounding text
    // legible instead of drawing a blank box or a different character.
  }
  return out
}
