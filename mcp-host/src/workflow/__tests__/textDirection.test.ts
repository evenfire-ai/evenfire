// One answer to "which way does this paragraph read" for the PDF, Word and
// PowerPoint, and the PDF's mirror of fontkit's right-to-left scripts kept
// equal to fontkit's own table.
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import { docxDirection } from '../docxScript'
import { resolveParagraph } from '../pdfBidi'
import { FONTKIT_RTL_SCRIPTS } from '../pdfText'
import { isRtlText } from '../textDirection'

/** OpenType script tags fontkit lists as right to left, and their Unicode names. */
const TAG_SCRIPTS: Record<string, string> = {
  arab: 'Arabic',
  hebr: 'Hebrew',
  syrc: 'Syriac',
  thaa: 'Thaana',
  cprt: 'Cypriot',
  khar: 'Kharoshthi',
  phnx: 'Phoenician',
  'nko ': 'Nko',
  lydi: 'Lydian',
  avst: 'Avestan',
  armi: 'Imperial_Aramaic',
  phli: 'Inscriptional_Pahlavi',
  prti: 'Inscriptional_Parthian',
  sarb: 'Old_South_Arabian',
  orkh: 'Old_Turkic',
  samr: 'Samaritan',
  mand: 'Mandaic',
  merc: 'Meroitic_Cursive',
  mero: 'Meroitic_Hieroglyphs',
  mani: 'Manichaean',
  mend: 'Mende_Kikakui',
  nbat: 'Nabataean',
  narb: 'Old_North_Arabian',
  palm: 'Palmyrene',
  phlp: 'Psalter_Pahlavi',
}

describe('FONTKIT_RTL_SCRIPTS', () => {
  it("is fontkit's own table of right-to-left scripts", () => {
    const source = fs.readFileSync(require.resolve('@foliojs-fork/fontkit'), 'utf8')
    const table = /var RTL = \{([\s\S]*?)\};/.exec(source)
    expect(table, "fontkit's RTL table").not.toBeNull()
    const tags = [...table![1].matchAll(/^\s*(?:'([^']+)'|(\w+)):\s*true/gm)].map(m => m[1] ?? m[2])
    expect(tags.length).toBeGreaterThan(20)
    expect(tags.filter(tag => !(tag in TAG_SCRIPTS))).toEqual([])
    expect(new Set(tags.map(tag => TAG_SCRIPTS[tag]))).toEqual(new Set(FONTKIT_RTL_SCRIPTS))
  })
})

describe('the direction of a paragraph', () => {
  /** The direction the PDF lays a paragraph out in, which drops LRM and RLM as invisible. */
  const pdfReadsRtl = (text: string) =>
    resolveParagraph([...text.replace(/[\u200e\u200f]/g, '')].map(ch => ch.codePointAt(0)!))
      .base === 1

  it.each([
    ['a roman numeral before Hebrew', 'Ⅻ שלום', false],
    ['Devanagari digits before Arabic', '१२ مرحبا', false],
    ['European digits before Hebrew', '2026 שנה', true],
    ['punctuation before Arabic', '(«مرحبا»)', true],
    ['a historic right-to-left script', '𐤀𐤁 abc', true],
    ['a right-to-left mark before Latin', '\u200fhello', false],
    ['a left-to-right mark before Hebrew', '\u200eשלום', true],
    ['Latin', 'Quarterly report', false],
    ['nothing strong', '2026 — 42%', false],
  ])('%s is the same in the PDF, Word and PowerPoint', (_label, text, rtl) => {
    expect(isRtlText(text)).toBe(rtl)
    expect(pdfReadsRtl(text)).toBe(rtl)
    expect(docxDirection(text)).toEqual(rtl ? { bidirectional: true } : {})
  })
})
