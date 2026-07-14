import { describe, expect, it } from 'vitest'
import { formatTokenBreakdown, formatTokenCount } from '../format'

describe('formatTokenCount', () => {
  it('passes through small counts and guards non-positive/non-finite', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(-10)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatTokenCount(7)).toBe('7')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('formats thousands with one decimal, dropping trailing .0', () => {
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(1050)).toBe('1.1k')
    expect(formatTokenCount(12_400)).toBe('12.4k')
    expect(formatTokenCount(100_000)).toBe('100k')
    expect(formatTokenCount(100_500)).toBe('101k')
  })

  it('formats millions', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_200_000)).toBe('1.2M')
  })

  it('promotes a rounding-induced carry to the next unit (no "1000k"/"1000M")', () => {
    // regression: 999_500..999_999 must read as ~1M, never "1000k"
    expect(formatTokenCount(999_500)).toBe('1M')
    expect(formatTokenCount(999_999)).toBe('1M')
    // and the billions boundary must not read "1000M"
    expect(formatTokenCount(999_999_999)).toBe('1B')
    expect(formatTokenCount(1_000_000_000)).toBe('1B')
  })
})

describe('formatTokenBreakdown', () => {
  it('lists input/output only when the model does not report cache', () => {
    expect(formatTokenBreakdown({ input: 100, output: 40 })).toBe('Input 100 · Output 40')
  })

  it('appends the cache breakdown when cache is reported (even at 0)', () => {
    expect(formatTokenBreakdown({ input: 200, output: 80, cacheRead: 13, cacheWrite: 0 })).toBe(
      'Input 200 · Output 80 · Cache read 13 · Cache write 0'
    )
  })
})
