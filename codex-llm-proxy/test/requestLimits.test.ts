import { describe, expect, it } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import {
  assertBoundedDeadline,
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
  VISUAL_STREAM_LIMITS,
} from '../src/requestLimits.js'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS } from '../src/sseHeartbeat.js'

// undici's default headersTimeout and bodyTimeout in the Node 24.16.0 image the
// Host runs; the Host sets neither for its proxy calls.
const HOST_UNDICI_TIMEOUT_MS = 300_000

describe('stream timing invariant', () => {
  it('reaches the first keepalive before the Host HTTP client times out', () => {
    expect(STREAM_LIMITS.maxStreamDurationMs).toBe(1_800_000)
    expect(STREAM_LIMITS.maxQueueWaitMs).toBe(60_000)
    // Nothing is written while a request waits for a slot or for the redeem,
    // so both must end, and one heartbeat interval pass, inside the timeout.
    // A visual request can wait twice: on visualStreamGate before the body is
    // parsed, then on streamGate when the parsed body no longer needs the
    // visual slot. Both gates share the maxQueueWaitMs default. The interval
    // is configurable, so the largest one config accepts is the one pinned.
    expect(MAX_HEARTBEAT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS)
    expect(
      2 * STREAM_LIMITS.maxQueueWaitMs +
        CONTROL_API_REQUEST_TIMEOUT_MS +
        MAX_HEARTBEAT_INTERVAL_MS
    ).toBeLessThan(HOST_UNDICI_TIMEOUT_MS)
  })
})

describe('assertBoundedDeadline', () => {
  it('refuses a missing or invalid proxy maximum even when the request carries a deadline', () => {
    // Liveness witness: the same request deadline passes with a valid maximum.
    expect(assertBoundedDeadline(1_000, 1_800_000)).toBe(1_000)
    for (const maxDeadlineMs of [undefined, Number.NaN, 0, -1, 1.5]) {
      let caught: unknown
      try {
        assertBoundedDeadline(1_000, maxDeadlineMs as unknown as number)
      } catch (err) {
        caught = err
      }
      expect(caught, `maxDeadlineMs=${String(maxDeadlineMs)}`).toBeInstanceOf(RequestLimitError)
      expect((caught as Error).message).toBe('deadline is invalid')
    }
  })
})

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

  it('rejects a waiter queued longer than maxQueueWaitMs and frees its queue slot', async () => {
    const gate = new StreamGate(1, 1, 50)
    const release = await gate.acquire()
    const started = Date.now()
    await expect(gate.acquire()).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'stream queue wait exceeded',
    })
    // Witness: the waiter was queued for the whole wait, not refused at once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
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
