import { describe, expect, it } from 'vitest'
import { withBusyRetry } from '../busyRetry'

describe('withBusyRetry', () => {
  it('returns the result on the first attempt when no error', async () => {
    let calls = 0
    const result = await withBusyRetry(() => {
      calls += 1
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries SQLITE_BUSY and eventually succeeds', async () => {
    let attempts = 0
    const result = await withBusyRetry(() => {
      attempts += 1
      if (attempts < 3) {
        const err: Error & { code?: string } = new Error('database is locked')
        err.code = 'SQLITE_BUSY'
        throw err
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('rethrows after exhausting all retries', async () => {
    await expect(
      withBusyRetry(() => {
        const err: Error & { code?: string } = new Error('locked')
        err.code = 'SQLITE_BUSY'
        throw err
      })
    ).rejects.toThrow(/locked/)
  })

  it('rethrows non-busy errors immediately', async () => {
    let attempts = 0
    await expect(
      withBusyRetry(() => {
        attempts += 1
        const err: Error & { code?: string } = new Error('boom')
        err.code = 'SQLITE_CONSTRAINT'
        throw err
      })
    ).rejects.toThrow(/boom/)
    expect(attempts).toBe(1)
  })

  it('B4 regression — yields the worker thread between retries (no busy-spin)', async () => {
    // Schedule a timer-bound side effect during the wait. Pre-B4 the
    // synchronous busy-spin would NOT let the timer callback run; the
    // async sleep does. We assert the timer fired before the retry
    // resolved by toggling a flag.
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 10)
    let attempts = 0
    const result = await withBusyRetry(() => {
      attempts += 1
      if (attempts < 2) {
        const err: Error & { code?: string } = new Error('locked')
        err.code = 'SQLITE_BUSY'
        throw err
      }
      // By the time the second attempt runs (after the first retry's
      // sleep), the 10ms timer above must have already fired.
      return timerFired
    })
    expect(result).toBe(true)
    expect(timerFired).toBe(true)
  })
})
