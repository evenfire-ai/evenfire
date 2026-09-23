import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '@clerum/llm-provider-attempt-contract'
import {
  BodyBudget,
  DEFAULT_MAX_BODY_BYTES,
  IN_FLIGHT_BODY_BUDGET_BODIES,
  RequestLimitError,
} from '../src/requestLimits.js'

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending')
  const first = await Promise.race([promise, new Promise(resolve => setTimeout(resolve, 20, marker))])
  return first === marker
}

describe('BodyBudget (#731 R3-2)', () => {
  it('T-R3-2d grants up to capacity at once, queues the next body, and grants it on release', async () => {
    const budget = new BodyBudget(30, 4)
    const first = await budget.acquire(10)
    await budget.acquire(10)
    await budget.acquire(10)
    expect(budget.inFlightBytes).toBe(30)

    const fourth = budget.acquire(10)
    expect(await isPending(fourth)).toBe(true)
    expect(budget.queued).toBe(1)

    first()
    const release = await fourth
    expect(budget.inFlightBytes).toBe(30)
    expect(budget.queued).toBe(0)
    // A release is counted once, however often it is called.
    release()
    release()
    expect(budget.inFlightBytes).toBe(20)
  })

  it('T-R3-2e refuses a body with RequestLimitError when the queue is full', async () => {
    const budget = new BodyBudget(10, 2)
    await budget.acquire(10)
    void budget.acquire(10).catch(() => undefined)
    void budget.acquire(10).catch(() => undefined)
    // Witness: the queue really holds its maximum before the refusal.
    expect(budget.queued).toBe(2)
    await expect(budget.acquire(1)).rejects.toBeInstanceOf(RequestLimitError)
    await expect(budget.acquire(1)).rejects.toThrow('body admission queue is full')
  })

  it('T-R3-2f frees the queue slot of an aborted waiter without blocking the ones behind it', async () => {
    const budget = new BodyBudget(10, 4)
    const holder = await budget.acquire(6)
    const abort = new AbortController()
    const large = budget.acquire(10, abort.signal)
    const small = budget.acquire(4)
    expect(budget.queued).toBe(2)
    // FIFO: the small body waits behind the large one although it would fit.
    expect(await isPending(small)).toBe(true)

    abort.abort()
    await expect(large).rejects.toThrow('body admission was aborted')
    const smallRelease = await small
    expect(budget.queued).toBe(0)
    expect(budget.inFlightBytes).toBe(10)
    smallRelease()
    holder()
    expect(budget.inFlightBytes).toBe(0)
  })

  it('T-R3-2g refuses, as a programming error, a body larger than the whole budget', async () => {
    const budget = new BodyBudget(10, 4)
    await expect(budget.acquire(11)).rejects.toBeInstanceOf(RangeError)
    // Witness: a body that fits is still granted by the same budget.
    await budget.acquire(10)
    expect(budget.inFlightBytes).toBe(10)
  })
})

/**
 * #739 D1 — a queued body waits only until the request's admission deadline,
 * the same instant every later wait of that request is bounded by.
 */
describe('BodyBudget admission deadline (#739 D1)', () => {
  it('T-AC-1 rejects a waiter blocked behind three full grants at its deadline and frees its queue slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const budget = new BodyBudget(30, 4)
      await budget.acquire(10)
      await budget.acquire(10)
      await budget.acquire(10)
      const deadlineAt = Date.now() + 1_000
      let outcome: unknown
      budget.acquire(10, undefined, deadlineAt).then(
        () => {
          outcome = 'granted'
        },
        (err: unknown) => {
          outcome = err
        }
      )
      // Witness: the body really queued behind the full budget.
      expect(budget.queued).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(outcome).toBeUndefined()
      expect(budget.queued).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toBeInstanceOf(RequestLimitError)
      expect((outcome as Error).message).toBe('body admission wait exceeded')
      expect(budget.queued).toBe(0)
      expect(budget.inFlightBytes).toBe(30)
    } finally {
      vi.useRealTimers()
    }
  })

  it('T-AC-2 ends head-of-line blocking: at the head waiter deadline the smaller body behind it is granted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const budget = new BodyBudget(IN_FLIGHT_BODY_BUDGET_BODIES * DEFAULT_MAX_BODY_BYTES)
      for (let i = 0; i < IN_FLIGHT_BODY_BUDGET_BODIES; i += 1) {
        await budget.acquire(LIMITS.maxRequestBodyBytes)
      }
      const full = IN_FLIGHT_BODY_BUDGET_BODIES * LIMITS.maxRequestBodyBytes
      // Fixture check: 48 KiB are left, so 64 KiB waits and 16 KiB would fit.
      expect(IN_FLIGHT_BODY_BUDGET_BODIES * DEFAULT_MAX_BODY_BYTES - full).toBe(48 * 1024)
      let headOutcome: unknown
      budget.acquire(64 * 1024, undefined, Date.now() + 1_000).then(
        () => {
          headOutcome = 'granted'
        },
        (err: unknown) => {
          headOutcome = err
        }
      )
      let grantedWith: number | undefined
      void budget.acquire(16 * 1024, undefined, Date.now() + 60_000).then(() => {
        grantedWith = budget.inFlightBytes
      })
      expect(budget.queued).toBe(2)
      await vi.advanceTimersByTimeAsync(999)
      // FIFO: the 16 KiB body still waits behind the head although it fits.
      expect(grantedWith).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(headOutcome).toBeInstanceOf(RequestLimitError)
      expect((headOutcome as Error).message).toBe('body admission wait exceeded')
      expect(grantedWith).toBe(full + 16 * 1024)
      expect(budget.queued).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
