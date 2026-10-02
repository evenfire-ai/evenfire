/**
 * Reads the text pdfkit writes, with its position, so tests can check what a
 * generated PDF actually shows rather than only that the call succeeded.
 *
 * Only the operators pdfkit emits are handled: `Tm` to place a fragment, `Tf`
 * to pick a font, `TJ` to draw it, and the `cm` before an image's `Do`.
 */
import * as fs from 'fs'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib'

export interface TextFragment {
  text: string
  /** Left and right edges in points from the page's left side. */
  x0: number
  x1: number
  /** Baseline in points from the page's top. */
  y: number
  /** BaseFont of the font the fragment is set in. */
  font: string
}

export interface PdfPage {
  width: number
  height: number
  fragments: TextFragment[]
  /** Every fragment's text, in drawing order, separated by spaces. */
  text: string
  /** Drawn image boxes, in points from the page's top-left corner. */
  images: Array<{ x0: number; y0: number; x1: number; y1: number }>
}

interface FontInfo {
  name: string
  toUnicode: Map<number, string>
  widths: Map<number, number>
  defaultWidth: number
  /** A standard-14 font, which pdfkit encodes one byte per character. */
  simple: boolean
}

function streamText(doc: PDFDocument, ref: unknown): string {
  const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref
  if (!(obj instanceof PDFRawStream)) return ''
  return Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1')
}

function hexToUnicode(hex: string): string {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return out
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToUnicode(m[2]))
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g
    )) {
      const from = parseInt(m[1], 16)
      const to = parseInt(m[2], 16)
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => hexToUnicode(x[1]))
        items.forEach((u, i) => map.set(from + i, u))
      } else {
        const start = hexToUnicode(m[3].slice(1, -1))
        const base = start.charCodeAt(start.length - 1)
        for (let c = from; c <= to; c++) {
          map.set(c, start.slice(0, -1) + String.fromCharCode(base + c - from))
        }
      }
    }
  }
  return map
}

function fontInfo(doc: PDFDocument, dict: PDFDict): FontInfo {
  const name = String(dict.lookup(PDFName.of('BaseFont'))).replace(/^\//, '')
  const toUnicodeRef = dict.get(PDFName.of('ToUnicode'))
  const info: FontInfo = {
    name,
    toUnicode: toUnicodeRef ? parseToUnicode(streamText(doc, toUnicodeRef)) : new Map(),
    widths: new Map(),
    defaultWidth: 1000,
    simple: String(dict.lookup(PDFName.of('Subtype'))) !== '/Type0',
  }
  if (info.simple) {
    // pdfkit only writes Courier as a standard font here; every glyph is 600 units.
    info.defaultWidth = 600
    return info
  }
  const descendants = dict.lookup(PDFName.of('DescendantFonts'), PDFArray)
  const cid = descendants.lookup(0, PDFDict)
  const w = cid.lookup(PDFName.of('W'))
  if (w instanceof PDFArray) {
    let i = 0
    while (i < w.size()) {
      const first = (w.lookup(i) as PDFNumber).asNumber()
      const next = w.lookup(i + 1)
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k++) {
          info.widths.set(first + k, (next.lookup(k) as PDFNumber).asNumber())
        }
        i += 2
      } else {
        const last = (next as PDFNumber).asNumber()
        const width = (w.lookup(i + 2) as PDFNumber).asNumber()
        for (let c = first; c <= last; c++) info.widths.set(c, width)
        i += 3
      }
    }
  }
  return info
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e
  })
}

/** Text fragments of every page of the PDF at `file`. */
export async function readPdf(file: string): Promise<PdfPage[]> {
  const doc = await PDFDocument.load(fs.readFileSync(file))
  const pages: PdfPage[] = []
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    const fonts = new Map<string, FontInfo>()
    const fontDict = page.node.Resources()?.lookup(PDFName.of('Font'))
    if (fontDict instanceof PDFDict) {
      for (const [key, ref] of fontDict.entries()) {
        const dict = doc.context.lookup(ref)
        if (dict instanceof PDFDict)
          fonts.set(key.asString().replace(/^\//, ''), fontInfo(doc, dict))
      }
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents]
    const source = streams.map(s => streamText(doc, s)).join('\n')
    // pdfkit draws an image with a negative height from its bottom edge, in
    // coordinates already flipped to run down from the top of the page.
    const images = [
      ...source.matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/\w+ Do/g),
    ].map(m => {
      const [w, h, x, bottom] = [Number(m[1]), Math.abs(Number(m[2])), Number(m[3]), Number(m[4])]
      return { x0: x, y0: bottom - h, x1: x + w, y1: bottom }
    })

    const fragments: TextFragment[] = []
    let x = 0
    let y = 0
    let size = 0
    let font: FontInfo | undefined
    const ops =
      /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm|\/(\S+) ([-\d.]+) Tf|\[((?:[^\]\\]|\\.)*)\] TJ/g
    for (const m of source.matchAll(ops)) {
      if (m[1] !== undefined) {
        x = Number(m[5])
        y = height - Number(m[6])
      } else if (m[7] !== undefined) {
        font = fonts.get(m[7])
        size = Number(m[8])
      } else if (m[9] !== undefined && font) {
        let text = ''
        let advance = 0
        const parts = /<([0-9a-fA-F]*)>|\(((?:[^()\\]|\\.)*)\)|([-\d.]+)/g
        for (const part of m[9].matchAll(parts)) {
          if (part[1] !== undefined) {
            // Embedded fonts use two-byte glyph ids; standard-14 fonts one byte per character.
            const step = font.simple ? 2 : 4
            for (let i = 0; i + step <= part[1].length; i += step) {
              const code = parseInt(part[1].slice(i, i + step), 16)
              text += font.simple ? String.fromCharCode(code) : (font.toUnicode.get(code) ?? '')
              advance += ((font.widths.get(code) ?? font.defaultWidth) / 1000) * size
            }
          } else if (part[2] !== undefined) {
            const literal = unescapeLiteral(part[2])
            text += literal
            advance += ((literal.length * font.defaultWidth) / 1000) * size
          } else if (part[3] !== undefined) {
            advance -= (Number(part[3]) / 1000) * size
          }
        }
        fragments.push({ text, x0: x, x1: x + advance, y, font: font.name })
      }
    }
    pages.push({ width, height, fragments, text: fragments.map(f => f.text).join(' '), images })
  }
  return pages
}

/** All pages' text, for presence checks. */
export function allText(pages: PdfPage[]): string {
  return pages.map(p => p.text).join(' ')
}
