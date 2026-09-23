import { describe, expect, it } from 'vitest'
import {
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
  VISUAL_STREAM_LIMITS,
} from '../src/requestLimits.js'

describe('StreamGate', () => {
  it('admits a queued waiter once a running stream releases', async () => {
    const gate = new StreamGate(1, 1)
    const release = await gate.acquire()
    let admitted = false
    const queued = gate.acquire().then(next => {
      admitted = true
      return next
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(admitted).toBe(false)
    release()
    const releaseQueued = await queued
    expect(admitted).toBe(true)
    releaseQueued()
  })

  it('rejects immediately without taking a slot when the signal is already aborted', async () => {
    const gate = new StreamGate(1, 1)
    const abort = new AbortController()
    abort.abort()
    await expect(gate.acquire(abort.signal)).rejects.toBeInstanceOf(RequestLimitError)
    // The running slot was not consumed: a fresh caller is admitted at once.
    const release = await Promise.race([
      gate.acquire(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('slot leaked by aborted caller')), 100)
      ),
    ])
    release()
  })

  it('rejects a queued waiter when its client aborts and frees the queue slot', async () => {
    const gate = new StreamGate(1, 1)
    const release = await gate.acquire()
    const abort = new AbortController()
    const queued = gate.acquire(abort.signal)
    abort.abort()
    await expect(
      Promise.race([
        queued,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('queued waiter ignored abort')), 200)
        ),
      ])
    ).rejects.toBeInstanceOf(RequestLimitError)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })

  it('pins the visual 2/8 sibling against the ordinary 8/16 stream gate', () => {
    expect(VISUAL_STREAM_LIMITS).toEqual({ maxConcurrentStreams: 2, maxQueuedRequests: 8 })
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)
    expect(STREAM_LIMITS.maxQueuedRequests).toBe(16)
  })

  it('rejects the 11th visual waiter once 2 are running and 8 are queued', async () => {
    const gate = new StreamGate(
      VISUAL_STREAM_LIMITS.maxConcurrentStreams,
      VISUAL_STREAM_LIMITS.maxQueuedRequests
    )
    const held = [await gate.acquire(), await gate.acquire()]
    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, () =>
      gate.acquire()
    )
    await expect(gate.acquire()).rejects.toBeInstanceOf(RequestLimitError)
    for (const release of held) release()
    for (const waiter of queued) (await waiter)()
  })
})
