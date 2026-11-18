import { describe, expect, it } from 'vitest'
import type { Rid32 } from '../src/services/gfsWatch/keys.js'
import { createRecentDirty } from '../src/services/gfsWatch/recentDirty.js'
import { createVirtualWatchClock } from './helpers/gfsWatchClock.js'

const r = (n: number) => n.toString(16).padStart(32, '0') as Rid32

describe('recentDirty ring', () => {
  it('keeps rids for 6 s and snapshot returns a copy', () => {
    const clock = createVirtualWatchClock()
    const dirty = createRecentDirty(clock.now)
    dirty.push(r(1), clock.now())
    clock.advance(3_000)
    dirty.push(r(2), clock.now())
    const snap = dirty.snapshot()
    expect(snap).toEqual(new Set([r(1), r(2)]))
    snap.clear()
    expect(dirty.snapshot().size).toBe(2)
    clock.advance(3_001)
    expect(dirty.snapshot()).toEqual(new Set([r(2)]))
    clock.advance(3_000)
    expect(dirty.snapshot().size).toBe(0)
    expect(dirty.overflowed()).toBe(false)
  })

  it('caps at 1,024 entries; overflowing marks every decision suspect for the next 6 s', () => {
    const clock = createVirtualWatchClock()
    const dirty = createRecentDirty(clock.now)
    for (let i = 0; i < 1_024; i += 1) dirty.push(r(i), clock.now())
    expect(dirty.overflowed()).toBe(false)
    dirty.push(r(5_000), clock.now())
    expect(dirty.size).toBe(1_024)
    expect(dirty.snapshot().has(r(0))).toBe(false)
    expect(dirty.snapshot().has(r(5_000))).toBe(true)
    expect(dirty.overflowed()).toBe(true)
    clock.advance(5_999)
    expect(dirty.overflowed()).toBe(true)
    clock.advance(1)
    expect(dirty.overflowed()).toBe(false)
  })

  it('markOverflow opens a 6 s window without touching the ring', () => {
    const clock = createVirtualWatchClock()
    const dirty = createRecentDirty(clock.now)
    dirty.push(r(1), clock.now())
    dirty.markOverflow()
    expect(dirty.overflowed()).toBe(true)
    expect(dirty.size).toBe(1)
    clock.advance(6_000)
    expect(dirty.overflowed()).toBe(false)
  })
})
