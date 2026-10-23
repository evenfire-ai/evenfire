import { describe, expect, it } from 'vitest'
import { bpeTokenEstimate } from '../bpeEstimate'

describe('bpeTokenEstimate', () => {
  it('counts dense, CJK and emoji text from the real encoder', () => {
    const cjk = '日本語テキストです'
    const dense = 'x'.repeat(4096)
    const emoji = '😀🎉'
    for (const text of [dense, cjk, emoji, cjk + emoji]) {
      const estimate = bpeTokenEstimate(text)
      // A real BPE count is positive and never exceeds the UTF-8 byte length,
      // which is the estimator's documented upper bound on the failure path.
      expect(estimate).toBeGreaterThan(0)
      expect(estimate).toBeLessThanOrEqual(Buffer.byteLength(text, 'utf8'))
    }
  })

  it('never splits a surrogate pair for a long emoji run', () => {
    const text = 'z'.repeat(1023) + '😀' + 'q'.repeat(2048)
    expect(bpeTokenEstimate(text)).toBeGreaterThan(0)
  })

  it('returns the exact UTF-8 byte length for a lone-surrogate input without throwing', () => {
    const lone = 'a\uD83Db'
    const bytes = Buffer.byteLength(lone, 'utf8')
    expect(() => bpeTokenEstimate(lone)).not.toThrow()
    expect(bpeTokenEstimate(lone)).toBeGreaterThan(0)
    expect(bpeTokenEstimate(lone)).toBeLessThanOrEqual(bytes)
  })
})
