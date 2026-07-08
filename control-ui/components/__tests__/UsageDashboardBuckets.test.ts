import { describe, expect, it } from 'vitest'
import {
  TRAILING_LAG_MS,
  floorToBucket,
  generateBuckets,
  rangeToBounds,
} from '../UsageDashboard/types'

describe('floorToBucket', () => {
  it('floors to the day boundary in UTC for day interval', () => {
    const d = new Date('2026-05-06T17:34:21.500Z')
    expect(floorToBucket(d, 'day').toISOString()).toBe('2026-05-06T00:00:00.000Z')
  })

  it('floors to the hour boundary in UTC for hour interval', () => {
    const d = new Date('2026-05-06T17:34:21.500Z')
    expect(floorToBucket(d, 'hour').toISOString()).toBe('2026-05-06T17:00:00.000Z')
  })

  it('floors to the nearest 5-minute boundary inside the hour for 5min interval', () => {
    expect(floorToBucket(new Date('2026-05-06T17:34:21.500Z'), '5min').toISOString()).toBe(
      '2026-05-06T17:30:00.000Z'
    )
    expect(floorToBucket(new Date('2026-05-06T17:35:00.000Z'), '5min').toISOString()).toBe(
      '2026-05-06T17:35:00.000Z'
    )
    expect(floorToBucket(new Date('2026-05-06T17:01:59.999Z'), '5min').toISOString()).toBe(
      '2026-05-06T17:00:00.000Z'
    )
  })

  it('does not mutate the input date', () => {
    const d = new Date('2026-05-06T17:34:21.500Z')
    const original = d.toISOString()
    floorToBucket(d, 'day')
    expect(d.toISOString()).toBe(original)
  })
})

describe('generateBuckets', () => {
  it('emits one ISO string per 5-minute slot across the range', () => {
    const from = new Date('2026-05-06T17:30:00.000Z')
    const to = new Date('2026-05-06T18:00:00.000Z')
    const out = generateBuckets(from, to, '5min')
    expect(out).toEqual([
      '2026-05-06T17:30:00.000Z',
      '2026-05-06T17:35:00.000Z',
      '2026-05-06T17:40:00.000Z',
      '2026-05-06T17:45:00.000Z',
      '2026-05-06T17:50:00.000Z',
      '2026-05-06T17:55:00.000Z',
      '2026-05-06T18:00:00.000Z',
    ])
  })

  it('floors `from` onto the bucket boundary before iterating', () => {
    const from = new Date('2026-05-06T17:34:21.500Z')
    const to = new Date('2026-05-06T17:50:00.000Z')
    const out = generateBuckets(from, to, '5min')
    expect(out[0]).toBe('2026-05-06T17:30:00.000Z')
    expect(out.at(-1)).toBe('2026-05-06T17:50:00.000Z')
  })

  it('produces 24 hourly buckets across a 24-hour window', () => {
    const from = new Date('2026-05-05T17:00:00.000Z')
    const to = new Date('2026-05-06T16:00:00.000Z')
    const out = generateBuckets(from, to, 'hour')
    expect(out.length).toBe(24)
    expect(out[0]).toBe('2026-05-05T17:00:00.000Z')
    expect(out.at(-1)).toBe('2026-05-06T16:00:00.000Z')
  })

  it('produces day-aligned buckets for the day interval', () => {
    const from = new Date('2026-04-30T13:00:00.000Z')
    const to = new Date('2026-05-03T05:00:00.000Z')
    const out = generateBuckets(from, to, 'day')
    expect(out).toEqual([
      '2026-04-30T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-05-02T00:00:00.000Z',
      '2026-05-03T00:00:00.000Z',
    ])
  })
})

describe('rangeToBounds', () => {
  it('clips the right edge by TRAILING_LAG_MS so the in-flight bucket is hidden', () => {
    const now = new Date('2026-05-07T17:00:00.000Z')
    const { to } = rangeToBounds('24h', now)
    expect(to.toISOString()).toBe(new Date(now.getTime() - TRAILING_LAG_MS).toISOString())
  })

  it('keeps the requested window width relative to the clipped right edge', () => {
    const now = new Date('2026-05-07T17:00:00.000Z')
    const { from, to } = rangeToBounds('24h', now)
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000)
  })
})
