import { describe, expect, it } from 'vitest'
import { formatBucketPercent, formatContextFill } from '../format'

describe('formatContextFill', () => {
  it('renders compact `N/M (P%)` with k/M scaling on both operands', () => {
    expect(formatContextFill(32_900, 100_000, 0.329)).toBe('32.9k/100k (33%)')
    expect(formatContextFill(1_200_000, 2_000_000, 0.6)).toBe('1.2M/2M (60%)')
  })

  it('rounds the percentage to a whole number from the authoritative fillRatio', () => {
    // 0.336 → 33.6% → rounds to 34%
    expect(formatContextFill(33_600, 100_000, 0.336)).toBe('33.6k/100k (34%)')
    expect(formatContextFill(0, 100_000, 0)).toBe('0/100k (0%)')
  })

  it('guards a non-finite fillRatio, falling back to 0%', () => {
    expect(formatContextFill(50_000, 100_000, Number.NaN)).toBe('50k/100k (0%)')
    expect(formatContextFill(50_000, 100_000, Number.POSITIVE_INFINITY)).toBe('50k/100k (0%)')
  })
})

describe('formatBucketPercent', () => {
  it('renders a one-decimal percentage from a 0..1 fraction', () => {
    expect(formatBucketPercent(0.537)).toBe('53.7%')
    expect(formatBucketPercent(0.5)).toBe('50.0%')
    expect(formatBucketPercent(1)).toBe('100.0%')
  })

  it('treats a zero fraction (e.g. Σ=0 → 0/Σ) as 0.0%', () => {
    expect(formatBucketPercent(0)).toBe('0.0%')
  })

  it('guards a non-finite fraction, falling back to 0.0%', () => {
    expect(formatBucketPercent(Number.NaN)).toBe('0.0%')
    expect(formatBucketPercent(Number.POSITIVE_INFINITY)).toBe('0.0%')
  })
})
