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
import { logger } from '../logger'
import { SUBSTITUTIONS } from './fontSubstitutions'
import {
  type FaceInfo,
  type FaceMetrics,
  type PdfFace,
  addCodePoint,
  collectionFaceNames,
  coversCodePoint,
  firstLetter,
  readFaceInfo,
} from './fontTables'
import { own } from './ownEntry'

export { asciiStandIn } from './fontSubstitutions'
export type { FaceMetrics } from './fontTables'

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

/**
 * When the bundled faces are tried again after a failed load. A failure can
 * pass (a read under memory or descriptor pressure), but a damaged package
 * fails every time, so the tries are few and spaced; after the last one the
 * system faces are used for the life of the process.
 */
const BUNDLED_RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000]

const bundled = {
  /** Faces registered so far, so a retry registers only the ones still missing. */
  registered: new Set<string>(),
  failures: 0,
  nextAttemptAt: 0,
  settled: false,
}
let systemFontsRegistered = false

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
        if (!GlobalFonts.registerFromPath(file)) throw new Error('the renderer refused the face')
      } catch (err) {
        // A face the renderer cannot parse is not available; the image's package may be damaged.
        logger.warn({ file, err: errorText(err) }, 'Font face could not be registered')
      }
    }
  }
}

/**
 * Register the bundled faces and the system faces. Safe to call from every
 * render path: once the bundled faces are in, or their retries are spent,
 * later calls are free.
 */
export function ensureFontsReady(): void {
  if (!bundled.settled && Date.now() >= bundled.nextAttemptAt) loadBundledFaces()
  if (!systemFontsRegistered) {
    systemFontsRegistered = true
    // Also the fallback: charts draw in these while the bundled faces are missing.
    registerSystemFonts()
  }
}

function loadBundledFaces(): void {
  try {
    const f = loadRobotoFaces()
    const refused: string[] = []
    for (const [label, data, alias] of [
      ['regular', f.normal, CHART_FONT_FAMILY],
      ['bold', f.bold, `${CHART_FONT_FAMILY} Bold`],
    ] as const) {
      if (bundled.registered.has(label)) continue
      // register answers null, without throwing, for a face it cannot use.
      if (GlobalFonts.register(data, alias)) bundled.registered.add(label)
      else refused.push(label)
    }
    if (refused.length > 0) {
      throw new Error(`the renderer refused the ${refused.join(' and ')} face`)
    }
    bundled.settled = true
    if (bundled.failures > 0) {
      logger.info(
        { attempts: bundled.failures + 1 },
        'Bundled Roboto faces loaded after a failed try'
      )
    }
  } catch (err) {
    const delay = BUNDLED_RETRY_DELAYS_MS[bundled.failures]
    bundled.failures++
    if (delay === undefined) {
      bundled.settled = true
      logger.error(
        { err: errorText(err), attempts: bundled.failures },
        'Bundled Roboto faces could not be loaded; system faces are used from now on'
      )
    } else {
      bundled.nextAttemptAt = Date.now() + delay
      logger.error(
        { err: errorText(err), attempts: bundled.failures, retryInMs: delay },
        'Bundled Roboto faces could not be loaded'
      )
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * CJK characters, which every CJK face sets one em wide. Text measures count
 * them so rather than measure them, since the image may have no CJK face.
 */
export const CJK_WIDE_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u

let measuring: SKRSContext2D | undefined

/**
 * Width of `text` in ems of the bundled body face (CHART_FONT_FAMILY), as the
 * canvas sets it. Each document format scales it to the face it is shown in.
 */
export function bodyFaceEm(text: string, bold: boolean): number {
  if (!measuring) {
    ensureFontsReady()
    measuring = createCanvas(4, 4).getContext('2d')
  }
  measuring.font = `100px "${bold ? `${CHART_FONT_FAMILY} Bold` : CHART_FONT_FAMILY}"`
  return measuring.measureText(text).width / 100
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
    // A refused face would leave the alias on the face probed before it.
    if (!GlobalFonts.registerFromPath(file, alias)) return -1
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

/** The CJK collection variant whose glyph forms the readers of a language expect. */
const CJK_VARIANTS: Record<string, string> = {
  'ja-JP': 'jp',
  'ko-KR': 'kr',
  'zh-TW': 'tc',
  'zh-HK': 'hk',
}

/**
 * `faces` with each face addressed inside a CJK collection swapped for the
 * collection's `variant` face of the same weight ("CJKsc-Bold" for
 * "CJKjp-Bold"), when the collection holds one. The variants share their
 * characters and widths and differ in glyph forms.
 */
function inVariant(faces: PdfFaces, variant: string): PdfFaces {
  const swap = (face: PdfFace): PdfFace => {
    if (!Array.isArray(face) || !/CJK(?:sc|jp|kr|tc|hk)-/i.test(face[1])) return face
    const name = face[1].replace(/CJK(?:sc|jp|kr|tc|hk)-/i, `CJK${variant}-`)
    return collectionFaceNames(face[0]).includes(name) ? [face[0], name] : face
  }
  return {
    normal: swap(faces.normal),
    bold: swap(faces.bold),
    italics: swap(faces.italics),
    bolditalics: swap(faces.bolditalics),
  }
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
      if (typeof file === 'string' && !GlobalFonts.registerFromPath(file, PDF_FONT_FAMILY)) {
        throw new Error('the renderer refused the face')
      }
      pdfFaces = chosen
      return pdfFaces
    } catch (err) {
      // Unparseable or refused face: fall through to the bundled one, which covers less.
      logger.warn(
        { file, err: errorText(err) },
        'PDF body face could not be registered; the bundled Roboto face is used'
      )
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
const MORE_SCRIPTS: ReadonlyArray<readonly [prefix: string, letter: number]> = [
  ['NotoSansDevanagari', 0x0915],
  ['NotoSansBengali', 0x0995],
  ['NotoSansGurmukhi', 0x0a15],
  ['NotoSansGujarati', 0x0a95],
  ['NotoSansOriya', 0x0b15],
  ['NotoSansTamil', 0x0b95],
  ['NotoSansTelugu', 0x0c15],
  ['NotoSansKannada', 0x0c95],
  ['NotoSansMalayalam', 0x0d15],
  ['NotoSansThai', 0x0e01],
  ['NotoSansLao', 0x0e81],
  ['NotoSansKhmer', 0x1780],
  ['NotoSansMyanmar', 0x1000],
  ['NotoSansArmenian', 0x0531],
  ['NotoSansGeorgian', 0x10d0],
  ['NotoSansEthiopic', 0x1200],
]
const MORE_SCRIPT_PREFIXES = MORE_SCRIPTS.map(([prefix]) => prefix)

/** The scripts the fallback faces are there for: a letter of each, and the faces named for it. */
const SCRIPT_FACES: ReadonlyArray<
  readonly [script: string, letter: number, prefixes: readonly string[]]
> = [
  ['Arabic', 0x0627, SCRIPT_FALLBACK_PREFIXES.filter(prefix => prefix.includes('Arabic'))],
  ['Hebrew', 0x05d0, SCRIPT_FALLBACK_PREFIXES.filter(prefix => prefix.includes('Hebrew'))],
  ...MORE_SCRIPTS.map(
    ([prefix, letter]) => [prefix.slice('NotoSans'.length), letter, [prefix]] as const
  ),
]

/** A Han character, drawn by the CJK collections. */
const CJK_LETTER = 0x4e2d

/**
 * The scripts no installed face draws. A script with a face named for it is
 * not missing, even without the preferred one (Debian has no Noto Sans Arabic
 * UI); one without is missing only when no other face draws its letter
 * (DejaVu Sans draws Armenian and Georgian). `draws` is asked only for those.
 */
export function missingScripts(
  hasFace: (prefix: string) => boolean,
  hasCjk: boolean,
  draws: (cp: number) => boolean
): string[] {
  const missing = SCRIPT_FACES.filter(
    ([, letter, prefixes]) => !prefixes.some(hasFace) && !draws(letter)
  ).map(([script]) => script)
  return hasCjk || draws(CJK_LETTER) ? missing : ['CJK', ...missing]
}

interface FallbackFamily {
  family: string
  faces: PdfFaces
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
  /**
   * pdfmake descriptors for `families`, always including the body and mono
   * ones. With `language` 'ja-JP', 'ko-KR', 'zh-TW' or 'zh-HK', a face from a
   * CJK collection is taken in that language's variant, whose glyph forms its
   * readers expect; Simplified Chinese is the collections' first variant.
   */
  descriptors(families: Iterable<string>, language?: string): Record<string, PdfFaces>
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

const CJK_FALLBACK = 'Fallback-CJK'

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
    out.push({ family: CJK_FALLBACK, faces: cjk })
  }
  FALLBACK_PREFIXES.forEach(add)
  MORE_SCRIPT_PREFIXES.forEach(add)
  return out
}

/** Longest text whose measured width is kept, and how many widths are kept at once. */
const MEASURED_TEXT_CACHED = 64
const MEASURED_WIDTHS_KEPT = 50_000
/** Face choices kept at once, by family and code point. */
const CHOSEN_KEPT = 50_000

class GlyphSource implements PdfGlyphSource {
  private readonly info = new Map<string, FaceInfo | undefined>()
  private readonly chosen = new Map<string, string | undefined>()
  private readonly embeddable = new Map<string, boolean>()
  // resolvePdfFaces registers the body family with the canvas itself.
  private readonly registered = new Set<string>([PDF_FONT_FAMILY])
  private fallbacks?: FallbackFamily[]
  private ctx?: SKRSContext2D
  /** The canvas font last set, so an unchanged one is not parsed again. */
  private ctxFont?: string
  /** Widths of short texts already measured, by face alias, size and text. */
  private readonly widths = new Map<string, number>()

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
      this.reportMissingScripts(this.fallbacks)
    }
    return this.fallbacks
  }

  /** Logged once per process, since the faces are looked up once (glyphSource). */
  private reportMissingScripts(fallbacks: FallbackFamily[]): void {
    const missing = missingScripts(
      prefix => facesForPrefix(prefix) !== undefined,
      fallbacks.some(f => f.family === CJK_FALLBACK),
      cp => this.familyFor(cp, PDF_FONT_FAMILY) !== undefined
    )
    if (missing.length > 0) {
      logger.warn(
        { component: 'fonts', scripts: missing },
        'No installed face draws these scripts, so PDFs leave their characters out'
      )
    }
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
    // One entry per family and code point a document uses; a text of many
    // distinct ones (a dictionary of Han characters) starts it over.
    if (this.chosen.size >= CHOSEN_KEPT) this.chosen.clear()
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
        const key = Buffer.isBuffer(face)
          ? GlobalFonts.register(face, alias)
          : GlobalFonts.registerFromPath(faceFile(face)!, alias)
        if (!key) throw new Error('the renderer refused the face')
      } catch (err) {
        // Measured with the canvas default instead; only line breaking is approximate.
        logger.warn(
          { alias, err: errorText(err) },
          'Font face could not be registered for measuring'
        )
      }
    }
    // Words repeat, and a width never changes for a face, size and text.
    const key = text.length <= MEASURED_TEXT_CACHED ? `${alias}\u0000${size}\u0000${text}` : ''
    const known = key ? this.widths.get(key) : undefined
    if (known !== undefined) return known
    this.ctx ??= createCanvas(8, 8).getContext('2d')
    const font = `${size}px "${alias}"`
    if (this.ctxFont !== font) {
      this.ctx.font = font
      this.ctxFont = font
    }
    const width = this.ctx.measureText(text).width
    if (key) {
      if (this.widths.size >= MEASURED_WIDTHS_KEPT) this.widths.clear()
      this.widths.set(key, width)
    }
    return width
  }

  descriptors(families: Iterable<string>, language?: string): Record<string, PdfFaces> {
    const out = pdfFontDescriptors()
    for (const family of families) {
      const faces = this.facesOf(family)
      if (faces) out[family] = faces
    }
    const variant = language ? own(CJK_VARIANTS, language) : undefined
    if (variant) {
      for (const [family, faces] of Object.entries(out)) out[family] = inVariant(faces, variant)
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
  } catch (err) {
    // Not remembered: a failed render says nothing about the character.
    logger.warn({ codePoint: cp, err: errorText(err) }, 'Glyph coverage could not be checked')
    return false
  }
  coverage.set(cp, ok)
  return ok
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
