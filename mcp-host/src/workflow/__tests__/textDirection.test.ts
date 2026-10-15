// One answer to "which way does this paragraph read" for the PDF, Word and
// PowerPoint, and the PDF's mirror of fontkit's right-to-left scripts kept
// equal to fontkit's own table.
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import { docxDirection } from '../docxScript'
import { resolveParagraph } from '../pdfBidi'
import { FONTKIT_RTL_SCRIPTS } from '../pdfText'
import { bidiClass, isRtlText } from '../textDirection'

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
    ['mathematical bold digits before Arabic', '\u{1D7D0}\u{1D7CE}\u{1D7D0}\u{1D7D4} مرحبا', true],
    ['segmented digits before Hebrew', '\u{1FBF2} שלום', true],
    ['Hanifi Rohingya digits before Latin', '\u{10D31}\u{10D32} abc', false],
    ['ornate parentheses around Latin', '﴾Al-Fatiha﴿ is the first surah.', false],
    ['the rub el hizb sign before Latin', '۞ Chapter 1', false],
    ['the Arabic per mille sign before Latin', '؉ rate', false],
  ])('%s is the same in the PDF, Word and PowerPoint', (_label, text, rtl) => {
    expect(isRtlText(text)).toBe(rtl)
    expect(pdfReadsRtl(text)).toBe(rtl)
    expect(docxDirection(text)).toEqual(rtl ? { bidirectional: true } : {})
  })
})

describe('the class of a character', () => {
  // Unicode 16 DerivedBidiClass for characters a block or category would class otherwise.
  it.each(
    [
      [0x0606, 'ON'],
      [0x0608, 'AL'],
      [0x0609, 'ET'],
      [0x06dd, 'AN'],
      [0x06de, 'ON'],
      [0x07f6, 'ON'],
      [0x0890, 'AN'],
      [0x0cbf, 'L'],
      [0x2071, 'L'],
      [0x2070, 'EN'],
      [0xfd3e, 'ON'],
      [0xfdfd, 'ON'],
      [0xfdfc, 'AL'],
      [0x10d30, 'AN'],
      [0x10e60, 'AN'],
      [0x1d7ce, 'EN'],
      [0x1fbf9, 'EN'],
      [0x1eef0, 'ON'],
      [0x02b9, 'ON'],
      [0x10140, 'ON'],
    ].map(
      ([cp, cls]) =>
        [(cp as number).toString(16).toUpperCase().padStart(4, '0'), cls, cp as number] as const
    )
  )('U+%s is %s', (_hex, cls, cp) => {
    expect(bidiClass(cp)).toBe(cls)
  })
})
