import { describe, expect, it } from 'vitest'
import { CircuitBreaker } from './circuitBreaker'

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, minSamples: 4 })
    breaker.record(true)
    breaker.record(true)
    breaker.record(true)
    breaker.record(false)
    expect(breaker.allow()).toBe(true)
  })

  it('opens when failures exceed 50% over the window', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, minSamples: 4 })
    breaker.record(false)
    breaker.record(false)
    breaker.record(false)
    breaker.record(true)
    expect(breaker.allow()).toBe(false)
  })

  it('does not trip below minSamples', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, minSamples: 4 })
    breaker.record(false)
    breaker.record(false)
    expect(breaker.allow()).toBe(true)
  })

  it('resets after the quiet period', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, minSamples: 2, resetMs: 60_000 })
    breaker.record(false)
    breaker.record(false)
    expect(breaker.allow()).toBe(false)
    t = 59_000
    expect(breaker.allow()).toBe(false)
    t = 61_000
    expect(breaker.allow()).toBe(true)
  })

  it('only counts events inside the sliding window', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, windowMs: 30_000, minSamples: 2 })
    breaker.record(false)
    breaker.record(false)
    t = 31_000
    // Old failures aged out; fresh successes keep it closed after reset.
    expect(breaker.allow()).toBe(false) // still open until resetMs elapses
    t = 61_000
    expect(breaker.allow()).toBe(true)
    breaker.record(true)
    breaker.record(true)
    expect(breaker.allow()).toBe(true)
  })
})
