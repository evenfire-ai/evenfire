import { describe, expect, it } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import {
  assertBoundedDeadline,
  RequestLimitError,
  STREAM_LIMITS,
  StreamGate,
} from '../src/requestLimits.js'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS } from '../src/sseHeartbeat.js'

// undici's default headersTimeout and bodyTimeout in the Node 24.16.0 image the
// Host runs; the Host sets neither for its proxy calls.
const HOST_UNDICI_TIMEOUT_MS = 300_000

describe('stream timing invariant', () => {
  it('T-KI-1-grok reaches the first keepalive before the Host HTTP client times out', () => {
    expect(STREAM_LIMITS.maxStreamDurationMs).toBe(1_800_000)
    expect(STREAM_LIMITS.maxQueueWaitMs).toBe(60_000)
    expect(CONTROL_API_REQUEST_TIMEOUT_MS).toBe(15_000)
    // Nothing is written while a request waits for a slot or for the redeem,
    // so both must end, and one heartbeat interval pass, inside the timeout.
    // Every wait a request performs (the body budget, the stream gate) is
    // bounded by one admission clock of maxQueueWaitMs from arrival (#739 D1),
    // so the queue time counts once. The interval is configurable, so the
    // largest one config accepts is the one pinned.
    expect(MAX_HEARTBEAT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_MS)
    const firstKeepaliveBy =
      STREAM_LIMITS.maxQueueWaitMs + CONTROL_API_REQUEST_TIMEOUT_MS + MAX_HEARTBEAT_INTERVAL_MS
    expect(firstKeepaliveBy).toBe(135_000)
    expect(HOST_UNDICI_TIMEOUT_MS).toBe(300_000)
    expect(firstKeepaliveBy).toBeLessThan(HOST_UNDICI_TIMEOUT_MS)
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

  it('T-AC-3-grok rejects a waiter at its admission deadline when that comes before maxQueueWaitMs', async () => {
    const gate = new StreamGate(1, 1, 60_000)
    const release = await gate.acquire()
    const started = Date.now()
    const queued = gate.acquire(undefined, started + 50)
    // Witness: the waiter really queued, so the one queue slot is taken.
    await expect(gate.acquire()).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'stream queue is full',
    })
    await expect(
      Promise.race([
        queued,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the admission deadline did not end the wait')), 1_000)
        ),
      ])
    ).rejects.toMatchObject({ name: 'RequestLimitError', message: 'stream queue wait exceeded' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    // The queue slot is free again, so a new waiter queues instead of "queue is full".
    const next = gate.acquire()
    release()
    const releaseNext = await next
    releaseNext()
  })
})
