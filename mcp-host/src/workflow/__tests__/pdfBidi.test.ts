import { describe, expect, it } from 'vitest'
import { bidiClass, hasRtl, mirrored, resolveParagraph, visualOrder } from '../pdfBidi'

/** `text` in display order, left to right, as characters. */
function display(text: string): string {
  const chars = [...text]
  const paragraph = resolveParagraph(chars.map(c => c.codePointAt(0)!))
  return visualOrder(paragraph, 0, chars.length)
    .map(i => mirrored(chars[i], paragraph.levels[i]))
    .join('')
}

describe('bidi classes', () => {
  it('classifies the characters documents mix', () => {
    expect(bidiClass('A'.codePointAt(0)!)).toBe('L')
    expect(bidiClass('\u05E9'.codePointAt(0)!)).toBe('R')
    expect(bidiClass('\u0639'.codePointAt(0)!)).toBe('AL')
    expect(bidiClass('7'.codePointAt(0)!)).toBe('EN')
    expect(bidiClass('\u0663'.codePointAt(0)!)).toBe('AN')
    expect(bidiClass('\u064E'.codePointAt(0)!)).toBe('NSM')
    expect(bidiClass('\u066A'.codePointAt(0)!)).toBe('ET')
    expect(bidiClass('\u060C'.codePointAt(0)!)).toBe('CS')
    expect(bidiClass(' '.codePointAt(0)!)).toBe('WS')
  })

  it('classes number signs and zero-width joiners as the Unicode data does', () => {
    expect(bidiClass(0x2212)).toBe('ES')
    expect(bidiClass(0xfb29)).toBe('ES')
    expect(bidiClass(0xff0d)).toBe('ES')
    expect(bidiClass(0x2213)).toBe('ET')
    for (const cp of [0x200c, 0x200d, 0x200b, 0x2060, 0xfeff, 0xad])
      expect(bidiClass(cp)).toBe('BN')
  })

  it('only flags text a right-to-left paragraph would reorder', () => {
    expect(hasRtl('Revenue 2026 ≥ 5')).toBe(false)
    expect(hasRtl('Revenue \u0645\u0631\u062D\u0628\u0627')).toBe(true)
  })
})

describe('display order', () => {
  it('sets a minus sign as it sets a hyphen-minus', () => {
    expect(display('\u05D0 \u22125')).toBe(display('\u05D0 -5').replace('-', '\u2212'))
    expect(display('\u05D0 3\u22125')).toBe(display('\u05D0 3-5').replace('-', '\u2212'))
  })

  it('resolves the text around a zero-width joiner as if it were not there', () => {
    const texts = [
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 12%',
      '\u05D0 1\u200D% b',
      'a \u0628\u200D1, 2',
      '\u05D0\u200C(a)\u200D \u0661',
      '1\u200B+2 \u05D0',
    ]
    const joiner = (cp: number) => cp >= 0x200b && cp <= 0x200d
    for (const text of texts) {
      const cps = [...text].map(c => c.codePointAt(0)!)
      const joined = resolveParagraph(cps)
      const bare = resolveParagraph(cps.filter(cp => !joiner(cp)))
      const kept = joined.levels.filter((_, i) => !joiner(cps[i]))
      expect(kept, JSON.stringify(text)).toEqual(bare.levels)
      expect(joined.base).toBe(bare.base)
    }
  })

  it('keeps a zero-width joiner beside the letter before it', () => {
    const text = '\u05D0 \u0628\u200D 12'
    const order = display(text)
    expect(order.indexOf('\u200D')).toBe(order.indexOf('\u0628') - 1)
  })

  it('reverses a Hebrew paragraph word by word and keeps numbers left to right', () => {
    // "price 100" in Hebrew reads right to left, so the number ends up at the left.
    expect(display('\u05DE\u05D7\u05D9\u05E8 100')).toBe('100 \u05E8\u05D9\u05D7\u05DE')
  })

  it('keeps Latin text in order inside a right-to-left paragraph', () => {
    const para = resolveParagraph([...'\u05D0 PDF \u05D1'].map(c => c.codePointAt(0)!))
    expect(para.base).toBe(1)
    expect(display('\u05D0 PDF \u05D1')).toBe('\u05D1 PDF \u05D0')
  })

  it('puts an Arabic phrase inside an English paragraph in right-to-left order', () => {
    expect(display('A \u0628\u062C C')).toBe('A \u062C\u0628 C')
  })

  it('treats digits after Arabic letters as Arabic numbers', () => {
    const chars = [...'\u0628 12']
    const para = resolveParagraph(chars.map(c => c.codePointAt(0)!))
    expect(para.levels).toEqual([1, 1, 2, 2])
    expect(display('\u0628 12')).toBe('12 \u0628')
  })

  it('mirrors brackets at a right-to-left level', () => {
    expect(display('\u05D0 (\u05D1)')).toBe('(\u05D1) \u05D0')
  })

  it('keeps a bracket pair with the right-to-left text it encloses', () => {
    // An Arabic phrase ending in "(increase 15%)" inside an English paragraph.
    expect(display('Mixed: \u0628 (\u062C 15%)')).toBe('Mixed: (%15 \u062C) \u0628')
  })

  it('leaves left-to-right text untouched', () => {
    expect(display('Plain text (100%)')).toBe('Plain text (100%)')
  })
})
