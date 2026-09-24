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

  it('only flags text a right-to-left paragraph would reorder', () => {
    expect(hasRtl('Revenue 2026 ≥ 5')).toBe(false)
    expect(hasRtl('Revenue \u0645\u0631\u062D\u0628\u0627')).toBe(true)
  })
})

describe('display order', () => {
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
