/**
 * The text an Office package (DOCX, XLSX, PPTX) holds, read from the bytes
 * that are delivered rather than predicted from the arguments that produced
 * them: a generator may write a value in a form its arguments never spelled,
 * as a sheet stores the text "3,141,592,653" as the number 3141592653. Numbers
 * are also read as they are shown: a cell's number format or a chart's label
 * format turns a stored 46024 into "2026-01-02", and 3141592653 into
 * "3,141,592,653" (shownNumbers.ts).
 */
import * as zlib from 'zlib'
import {
  builtinFormatCode,
  isModelledFormatCode,
  isShortDateId,
  renderCount,
  shownForms,
  showsIntegerAsStored,
} from './shownNumbers'

/** Bounds on one inspection; a package past them is reported as unreadable. */
export const OFFICE_PACKAGE_LIMITS = {
  /** Entries in one package; an embedded package counts its own. */
  maxEntries: 4096,
  /** Bytes inflated across the package and every package inside it. */
  maxInflatedBytes: 64 * 1024 * 1024,
  /** Packages inside packages, such as the workbook behind a deck's chart. */
  maxDepth: 2,
  /**
   * Numbers rendered through their format across the package and every
   * package inside it; a larger package is not attached.
   */
  maxShownValues: 250_000,
  /**
   * Renderings those numbers take (shownNumbers.renderCount): a built-in
   * short date is rendered in dozens of patterns. About 0.6 s at this bound.
   */
  maxShownRenders: 500_000,
}

export type OfficePackageLimits = typeof OFFICE_PACKAGE_LIMITS

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const TEXT_PART = /\.(?:xml|rels|vml)$/i
const EMBEDDED_PACKAGE = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm)$/i
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
 * each attribute value on its own, with character references decoded; then
 * each number a sheet cell or a chart holds, in every form it may be shown,
 * passed to `matchesShown` as shown (match numbers with shownNumbers.showsNumber);
 * null skips them.
 * Embedded packages are read too. Null when the bytes are not a package this
 * reader can read within `limits`, or show a number in a way it does not model
 * (a formula, a system date format, the 1904 date system); the caller then
 * treats the file as unsafe.
 */
export function officePackageHasText(
  buffer: Buffer,
  matches: (text: string) => boolean,
  limits: OfficePackageLimits = OFFICE_PACKAGE_LIMITS,
  matchesShown: ((shown: string) => boolean) | null = matches
): boolean | null {
  return searchPackage(
    buffer,
    matches,
    limits,
    { inflated: 0, shownValues: 0, shownRenders: 0 },
    0,
    matchesShown ?? undefined
  )
}

/**
 * Every text the scan above reads in the package, numbers as stored: per XML
 * part, its text nodes run together, and each attribute value. Null when the
 * package cannot be read within the limits.
 */
export function officePackageTexts(
  buffer: Buffer,
  limits: OfficePackageLimits = OFFICE_PACKAGE_LIMITS
): string[] | null {
  const texts: string[] = []
  const read = searchPackage(
    buffer,
    text => {
      texts.push(text)
      return false
    },
    { ...limits, maxShownValues: 0 },
    { inflated: 0, shownValues: 0, shownRenders: 0 },
    0,
    undefined
  )
  return read === null ? null : texts
}

interface ScanBudget {
  inflated: number
  shownValues: number
  shownRenders: number
}

function searchPackage(
  buffer: Buffer,
  matches: (text: string) => boolean,
  limits: OfficePackageLimits,
  budget: ScanBudget,
  depth: number,
  matchesShown: ((shown: string) => boolean) | undefined
): boolean | null {
  const entries = centralDirectory(buffer, limits.maxEntries)
  if (!entries) return null
  const parts = new Map<string, string>()
  for (const entry of entries) {
    const embedded = EMBEDDED_PACKAGE.test(entry.name)
    if (!embedded && !TEXT_PART.test(entry.name)) continue
    if (embedded && depth >= limits.maxDepth) return null
    const data = entryData(buffer, entry, limits.maxInflatedBytes - budget.inflated)
    if (!data) return null
    budget.inflated += data.length
    let found: boolean | null
    if (embedded) {
      found = searchPackage(data, matches, limits, budget, depth + 1, matchesShown)
    } else {
      const xml = data.toString('utf8')
      parts.set(entry.name, xml)
      found = xmlHasText(xml, matches)
    }
    if (found !== false) return found
  }
  return matchesShown ? numbersShow(parts, matchesShown, limits, budget) : false
}

/** Sections whose content is read as it stands, up to their end mark. */
const RAW_SECTIONS: ReadonlyArray<readonly [start: string, end: string]> = [
  ['<![CDATA[', ']]>'],
  ['<!--', '-->'],
]

/**
 * Whether one XML part's text satisfies `matches`, read in a single pass: its
 * text nodes, character data and comments run together, and each quoted
 * attribute value on its own, so a '>' a value holds does not end its tag. A
 * value or section left open runs to the end of the part, which is read too.
 */
function xmlHasText(xml: string, matches: (text: string) => boolean): boolean {
  const text: string[] = []
  let at = 0
  while (at < xml.length) {
    const open = xml.indexOf('<', at)
    if (open < 0) {
      text.push(xml.slice(at))
      break
    }
    text.push(xml.slice(at, open))
    const raw = RAW_SECTIONS.find(([start]) => xml.startsWith(start, open))
    if (raw) {
      const close = xml.indexOf(raw[1], open + raw[0].length)
      const end = close < 0 ? xml.length : close
      text.push(xml.slice(open + raw[0].length, end))
      at = end + raw[1].length
      continue
    }
    let i = open + 1
    while (i < xml.length && xml[i] !== '>') {
      const quote = xml[i]
      if (quote !== '"' && quote !== "'") {
        i++
        continue
      }
      const close = xml.indexOf(quote, i + 1)
      const end = close < 0 ? xml.length : close
      if (matches(decodeReferences(xml.slice(i + 1, end)))) return true
      i = end + 1
    }
    at = i + 1
  }
  return matches(decodeReferences(text.join('')))
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

// ─── Numbers as they are shown ───────────────────────────────────────

const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/
const CHART_PART = /(?:^|\/)charts\/chart[^/]*\.xml$/

/**
 * Whether a number a sheet or a chart of this package shows satisfies
 * `matches`. Null for a way of showing a number this reader does not model, or
 * when the package holds more numbers than the limits allow.
 */
function numbersShow(
  parts: Map<string, string>,
  matches: (text: string) => boolean,
  limits: OfficePackageLimits,
  budget: ScanBudget
): boolean | null {
  const render = (value: number, code: string, shortDate: boolean): boolean | null => {
    if (!shortDate && showsIntegerAsStored(code, value)) return false
    if (++budget.shownValues > limits.maxShownValues) return null
    budget.shownRenders += renderCount(code, shortDate)
    if (budget.shownRenders > limits.maxShownRenders) return null
    return shownForms(value, code, shortDate).some(matches)
  }
  const sheets = [...parts.keys()].filter(name => SHEET_PART.test(name))
  if (sheets.length > 0) {
    // A workbook in the 1904 date system shows every serial four years later.
    if (/\bdate1904\s*=\s*["'](?:1|true)["']/.test(parts.get('xl/workbook.xml') ?? '')) return null
    const styles = readStyles(parts.get('xl/styles.xml'))
    if (!styles) return null
    for (const name of sheets) {
      const found = sheetShows(parts.get(name)!, styles, render)
      if (found !== false) return found
    }
  }
  for (const name of [...parts.keys()].filter(part => CHART_PART.test(part))) {
    const found = chartShows(parts.get(name)!, render)
    if (found !== false) return found
  }
  return false
}

interface CellFormat {
  code: string
  /** A built-in short date, shown in the viewer's own date pattern. */
  shortDate: boolean
}

interface StyleFormats {
  /** The format of cell style `index`; null when it is not modelled. */
  format(index: number): CellFormat | null
}

/** The number format of each cell style; null when a conditional format sets one. */
function readStyles(xml: string | undefined): StyleFormats | null {
  const custom = new Map<number, string>()
  const xfFormats: number[] = []
  let inCellXfs = false
  let inDxf = false
  let dxfFormat = false
  if (xml) {
    walkXml(xml, {
      start(name, attrs, selfClosing) {
        const local = localName(name)
        if (local === 'cellXfs') inCellXfs = !selfClosing
        else if (local === 'dxf') inDxf = !selfClosing
        else if (local === 'numFmt') {
          if (inDxf) dxfFormat = true
          else if (attrs.numFmtId !== undefined && attrs.formatCode !== undefined) {
            custom.set(Number(attrs.numFmtId), attrs.formatCode)
          }
        } else if (local === 'xf' && inCellXfs) {
          xfFormats.push(Number(attrs.numFmtId ?? 0))
        }
      },
      end(name) {
        const local = localName(name)
        if (local === 'cellXfs') inCellXfs = false
        else if (local === 'dxf') inDxf = false
      },
    })
  }
  if (dxfFormat) return null
  const known = new Map<number, CellFormat | null>()
  return {
    format(index) {
      const cached = known.get(index)
      if (cached !== undefined) return cached
      const id = xfFormats[index] ?? (index === 0 ? 0 : undefined)
      const code = id === undefined ? undefined : (custom.get(id) ?? builtinFormatCode(id))
      const format =
        id !== undefined && code !== undefined && isModelledFormatCode(code)
          ? { code, shortDate: !custom.has(id) && isShortDateId(id) }
          : null
      known.set(index, format)
      return format
    },
  }
}

type Render = (value: number, code: string, shortDate: boolean) => boolean | null

/** Whether a number cell of the sheet shows text `render` matches; null for a formula. */
function sheetShows(xml: string, styles: StyleFormats, render: Render): boolean | null {
  let cell: { style: number; type?: string; value: string; inValue: boolean } | undefined
  let result: boolean | null = false
  walkXml(xml, {
    start(name, attrs, selfClosing) {
      const local = localName(name)
      if (local === 'c') {
        cell = selfClosing
          ? undefined
          : { style: Number(attrs.s ?? 0), type: attrs.t, value: '', inValue: false }
      } else if (cell && local === 'v') {
        cell.inValue = !selfClosing
      } else if (cell && local === 'f') {
        // A formula shows a result the package does not hold.
        result = null
        return true
      }
      return false
    },
    text(text) {
      if (cell?.inValue) cell.value += text
      return false
    },
    end(name) {
      const local = localName(name)
      if (local === 'v' && cell) cell.inValue = false
      else if (local === 'c' && cell) {
        const shown = cellShows(cell, styles, render)
        cell = undefined
        if (shown !== false) {
          result = shown
          return true
        }
      }
      return false
    },
  })
  return result
}

function cellShows(
  cell: { style: number; type?: string; value: string },
  styles: StyleFormats,
  render: Render
): boolean | null {
  // An ISO date cell is shown through a format this reader does not apply.
  if (cell.type === 'd') return null
  // Text, booleans and errors are read as text.
  if (cell.type !== undefined && cell.type !== 'n') return false
  const stored = cell.value.trim()
  const value = Number(stored)
  if (!stored || !Number.isFinite(value)) return false
  const format = styles.format(cell.style)
  if (!format) return null
  return render(value, format.code, format.shortDate)
}

/**
 * Whether a number a chart caches shows text `render` matches. Each value is
 * rendered with every format code of the chart part (series caches, data and
 * axis labels), so the check covers what a label may show.
 */
function chartShows(xml: string, render: Render): boolean | null {
  const codes = new Set<string>(['General'])
  const values: number[] = []
  let cacheDepth = 0
  let value: string | undefined
  let formatCode: string | undefined
  walkXml(xml, {
    start(name, attrs, selfClosing) {
      const local = localName(name)
      if (local === 'numCache' || local === 'numLit') {
        if (!selfClosing) cacheDepth++
      } else if ((local === 'numFmt' || local === 'pt') && attrs.formatCode !== undefined) {
        codes.add(attrs.formatCode)
      } else if (local === 'formatCode' && !selfClosing) {
        formatCode = ''
      } else if (local === 'v' && cacheDepth > 0 && !selfClosing) {
        value = ''
      }
      return false
    },
    text(text) {
      if (value !== undefined) value += text
      if (formatCode !== undefined) formatCode += text
      return false
    },
    end(name) {
      const local = localName(name)
      if (local === 'numCache' || local === 'numLit') cacheDepth = Math.max(0, cacheDepth - 1)
      else if (local === 'formatCode' && formatCode !== undefined) {
        codes.add(formatCode)
        formatCode = undefined
      } else if (local === 'v' && value !== undefined) {
        const number = Number(value.trim())
        if (value.trim() && Number.isFinite(number)) values.push(number)
        value = undefined
      }
      return false
    },
  })
  for (const code of codes) if (!isModelledFormatCode(code)) return null
  for (const number of values) {
    for (const code of codes) {
      const found = render(number, code, false)
      if (found !== false) return found
    }
  }
  return false
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

interface XmlVisitor {
  /** Each returns true to stop the walk. */
  start?(name: string, attrs: Record<string, string>, selfClosing: boolean): boolean | void
  end?(name: string): boolean | void
  text?(text: string): boolean | void
}

/** Space, tab, newline and carriage return, the whitespace XML allows between attributes. */
function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

/** Text with its character references decoded; most text has none. */
function decodedText(text: string): string {
  return text.includes('&') ? decodeReferences(text) : text
}

/**
 * Walks the elements of one XML part in a single pass, tolerating malformed
 * input: text and character data go to `text` with references decoded,
 * comments, declarations and processing instructions are skipped, and each
 * quoted attribute value is read whole, so a '>' it holds does not end its tag.
 */
function walkXml(xml: string, visit: XmlVisitor): void {
  const LT = 60 // <
  const GT = 62 // >
  const SLASH = 47 // /
  const EQ = 61 // =
  let at = 0
  while (at < xml.length) {
    const open = xml.indexOf('<', at)
    if (open < 0) {
      visit.text?.(decodedText(xml.slice(at)))
      return
    }
    if (open > at && visit.text?.(decodedText(xml.slice(at, open)))) return
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open + 9)
      const end = close < 0 ? xml.length : close
      if (visit.text?.(xml.slice(open + 9, end))) return
      at = end + 3
      continue
    }
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4)
      at = close < 0 ? xml.length : close + 3
      continue
    }
    const second = xml.charCodeAt(open + 1)
    if (second === 63 || second === 33) {
      // <? ... ?> and <! ... >
      const close = xml.indexOf('>', open)
      at = close < 0 ? xml.length : close + 1
      continue
    }
    const closing = second === SLASH
    let i = open + (closing ? 2 : 1)
    const nameStart = i
    for (let c = xml.charCodeAt(i); i < xml.length; c = xml.charCodeAt(++i)) {
      if (isSpace(c) || c === SLASH || c === GT || c === LT) break
    }
    const name = xml.slice(nameStart, i)
    // No prototype: an attribute named "__proto__" stays a plain key.
    const attrs: Record<string, string> = Object.create(null)
    let selfClosing = false
    while (i < xml.length) {
      const c = xml.charCodeAt(i)
      if (c === GT) break
      if (c === SLASH) {
        selfClosing = true
        i++
        continue
      }
      if (isSpace(c)) {
        i++
        continue
      }
      const attrStart = i
      for (let d = xml.charCodeAt(i); i < xml.length; d = xml.charCodeAt(++i)) {
        if (isSpace(d) || d === EQ || d === SLASH || d === GT) break
      }
      const attrName = xml.slice(attrStart, i)
      while (i < xml.length && isSpace(xml.charCodeAt(i))) i++
      if (xml.charCodeAt(i) !== EQ) continue
      i++
      while (i < xml.length && isSpace(xml.charCodeAt(i))) i++
      const quote = xml[i]
      if (quote !== '"' && quote !== "'") continue
      const close = xml.indexOf(quote, i + 1)
      const end = close < 0 ? xml.length : close
      attrs[attrName] = decodedText(xml.slice(i + 1, end))
      selfClosing = false
      i = end + 1
    }
    at = i + 1
    if (closing) {
      if (visit.end?.(name)) return
    } else {
      if (visit.start?.(name, attrs, selfClosing)) return
      if (selfClosing && visit.end?.(name)) return
    }
  }
}
