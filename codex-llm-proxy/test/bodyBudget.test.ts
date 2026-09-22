import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BodyBudget,
  DEFAULT_MAX_BODY_BYTES,
  IN_FLIGHT_BODY_BUDGET_BYTES,
  RequestLimitError,
} from '../src/requestLimits.js'

const here = dirname(fileURLToPath(import.meta.url))

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

  it('T-R3-2h sizes the deployed budget at three bodies and keeps five copies of it under the pod limit', () => {
    expect(IN_FLIGHT_BODY_BUDGET_BYTES).toBe(3 * DEFAULT_MAX_BODY_BYTES)
    const manifest = readFileSync(
      join(here, '../../deploy/base/control-plane/codex-llm-proxy.yaml'),
      'utf8'
    )
    const limit = /limits:\s*\n\s*cpu:[^\n]*\n\s*memory:\s*(\d+)Mi/.exec(manifest)
    expect(limit, 'codex-llm-proxy.yaml must declare a memory limit in Mi').not.toBeNull()
    const podLimitBytes = Number(limit![1]) * 1024 * 1024
    // About five copies of each body are alive while it is parsed and hashed:
    // the raw buffer, the decoded string, the parsed object, the contract copy
    // and the canonical serialization used for the hash.
    expect(5 * IN_FLIGHT_BODY_BUDGET_BYTES).toBeLessThan(podLimitBytes)
  })
})
