/**
 * Language and direction tags for slide text, and the width measure that
 * lays it out.
 */
import { describe, expect, it } from 'vitest'
import { scriptOptions, textWidth } from '../pptxText'

describe('scriptOptions', () => {
  it('tags each script with its language', () => {
    expect(scriptOptions('ひらがな')).toEqual({ lang: 'ja-JP' })
    expect(scriptOptions('한국어')).toEqual({ lang: 'ko-KR' })
    expect(scriptOptions('营收')).toEqual({ lang: 'zh-CN' })
    expect(scriptOptions('營收', 'zh-TW')).toEqual({ lang: 'zh-TW' })
    expect(scriptOptions('Revenue')).toEqual({})
  })

  it('sets right to left from the first letter, in every right-to-left script', () => {
    expect(scriptOptions('مرحبا world')).toEqual({ lang: 'ar-SA', rtlMode: true })
    expect(scriptOptions('world مرحبا').rtlMode).toBeUndefined()
    // Syriac and Thaana read right to left too.
    expect(scriptOptions('ܫܠܡܐ').rtlMode).toBe(true)
    expect(scriptOptions('ދިވެހި').rtlMode).toBe(true)
  })
})

describe('textWidth', () => {
  it('grows with the size, and sets CJK one em wide', () => {
    const at10 = textWidth('Revenue', 10)
    expect(at10).toBeGreaterThan(0)
    expect(textWidth('Revenue', 20)).toBeCloseTo(at10 * 2, 5)
    expect(textWidth('売上', 72)).toBeCloseTo(2, 5)
  })
})
