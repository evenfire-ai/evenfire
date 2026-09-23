import {
  ENVELOPE_ALLOWANCE_BYTES as CONTRACT_ENVELOPE_ALLOWANCE_BYTES,
  LIMITS as CONTRACT_LIMITS,
} from '@clerum/llm-provider-attempt-contract'

/**
 * #731 — room for the runtime envelope around the contract-capped `request`.
 * The contract owns the value, shared with control-api and mcp-host.
 */
export const ENVELOPE_ALLOWANCE_BYTES = CONTRACT_ENVELOPE_ALLOWANCE_BYTES

/**
 * The default body limit, derived from the contract so the proxy never refuses,
 * as a 413, a request the contract accepts.
 */
export const DEFAULT_MAX_BODY_BYTES = CONTRACT_LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES

/**
 * #731 R3-2 — how many maximum-size bodies may be read and parsed at once.
 * Several copies of a body are alive while it is parsed, hashed and forwarded
 * (the raw buffer, the decoded string, the parsed object, the contract copy and
 * more than one serialization of it). Without this bound the stream gate would
 * let 24 bodies in.
 * Bodies over the ordinary cap never take this budget: they are V2 visual
 * envelopes, bounded by `visualStreamGate` instead, so the declared bodies a pod
 * can hold at once are 3 x 8 MiB here plus 2 x 24 MiB there. Measured with all
 * five in flight, the process peaked at 714 MiB of RSS with an uncapped heap
 * and at 574 MiB with `--max-old-space-size=384`, which is why the deployment
 * sets that cap and a 768Mi memory limit.
 */
export const IN_FLIGHT_BODY_BUDGET_BODIES = 3

/**
 * R9-M-B — how long a body that holds a budget reservation may take to be
 * read and parsed. The clock starts when the reservation is granted, so time
 * spent queued does not count, and stops when the parser finishes. Measured on
 * loopback, an 8 MiB body is read in 7.6-22.6 ms alone and in under 60 ms with
 * three at once, so 10 s only cuts a body that has stalled. Without it a
 * stalled body keeps its reservation until Node's 300 s `requestTimeout`.
 * Not env-tunable.
 */
export const BODY_READ_DEADLINE_MS = 10_000

export const STREAM_LIMITS = {
  maxConcurrentStreams: 8,
  maxQueuedRequests: 16,
  maxStreamDurationMs: 1_800_000,
  // Longest time a request may wait for a stream slot. Bounded so that queue
  // wait + redeem + the first keepalive stays below the Host HTTP client's
  // 300 s header timeout.
  maxQueueWaitMs: 60_000,
  // Longest silence tolerated while waiting on the upstream (response headers
  // or the next SSE chunk). Matches the Codex CLI stream idle timeout.
  upstreamIdleTimeoutMs: 300_000,
} as const

/**
 * Admission for a body whose Content-Length exceeds the ordinary cap.
 * The pod cannot hold the ordinary 8-stream gate across a 24 MiB image, so
 * those requests are a tighter sibling and a V2 request keeps the slot until
 * the stream ends. Small bodies, including every valid V1, must not enter this
 * gate. The 768Mi limit is sized for these two slots plus the ordinary body
 * budget; widening either one needs a new memory measurement first.
 */
export const VISUAL_STREAM_LIMITS = {
  maxConcurrentStreams: 2,
  maxQueuedRequests: 8,
} as const

export class RequestLimitError extends Error {
  readonly code = 'provider_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'RequestLimitError'
  }
}

export function assertBoundedDeadline(deadlineMs: number | undefined, maxDeadlineMs: number): number {
  // Without a valid maximum, Math.min below would return NaN for a valid
  // request deadline instead of refusing it.
  if (!Number.isInteger(maxDeadlineMs) || maxDeadlineMs <= 0) {
    throw new RequestLimitError('deadline is invalid')
  }
  const requested = deadlineMs ?? Math.min(maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs)
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('deadline is invalid')
  }
  return Math.min(requested, maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs, CONTRACT_LIMITS.maxDeadlineMs)
}

export function assertBoundedIdleTimeout(idleTimeoutMs: number | undefined): number {
  const requested = idleTimeoutMs ?? STREAM_LIMITS.upstreamIdleTimeoutMs
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('upstream idle timeout is invalid')
  }
  return Math.min(requested, STREAM_LIMITS.upstreamIdleTimeoutMs)
}

export class StreamGate {
  private running = 0
  private queued = 0

  constructor(
    private readonly maxConcurrent: number = STREAM_LIMITS.maxConcurrentStreams,
    private readonly maxQueued: number = STREAM_LIMITS.maxQueuedRequests,
    private readonly maxQueueWaitMs: number = STREAM_LIMITS.maxQueueWaitMs
  ) {}

  /**
   * Take a stream slot. When `signal` aborts (client disconnected) while the
   * caller is still queued, the waiter is rejected and its queue slot freed, so
   * a dropped client never proceeds to redeem an attempt. A waiter still
   * queued after `maxQueueWaitMs` is rejected the same way.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RequestLimitError('stream request was aborted')
    if (this.running >= this.maxConcurrent) {
      if (this.queued >= this.maxQueued) throw new RequestLimitError('stream queue is full')
      this.queued += 1
      try {
        const queuedAt = Date.now()
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const onAbort = () => {
            if (timer !== undefined) clearTimeout(timer)
            reject(new RequestLimitError('stream request was aborted'))
          }
          const wait = () => {
            if (this.running < this.maxConcurrent) {
              signal?.removeEventListener('abort', onAbort)
              resolve()
              return
            }
            if (Date.now() - queuedAt >= this.maxQueueWaitMs) {
              signal?.removeEventListener('abort', onAbort)
              reject(new RequestLimitError('stream queue wait exceeded'))
              return
            }
            timer = setTimeout(wait, 10)
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          wait()
        })
      } finally {
        this.queued -= 1
      }
    }
    this.running += 1
    return () => {
      this.running = Math.max(0, this.running - 1)
    }
  }

  /** Observable occupancy for tests. Production callers must not branch on this. */
  snapshot(): { running: number; queued: number } {
    return { running: this.running, queued: this.queued }
  }
}

export const streamGate = new StreamGate()

export const visualStreamGate = new StreamGate(
  VISUAL_STREAM_LIMITS.maxConcurrentStreams,
  VISUAL_STREAM_LIMITS.maxQueuedRequests
)

type BodyWaiter = { bytes: number; grant: (release: () => void) => void }

/**
 * #731 R3-2 — a byte budget for request bodies, taken from the declared
 * `Content-Length` before the body is read. Bodies that do not fit wait in a
 * bounded FIFO queue; a full queue is refused with the same RequestLimitError
 * the stream gate raises, so the client sees the existing overload response.
 */
export class BodyBudget {
  private inFlight = 0
  private readonly waiters: BodyWaiter[] = []

  constructor(
    private readonly capacityBytes: number,
    private readonly maxQueued: number = STREAM_LIMITS.maxQueuedRequests
  ) {}

  get inFlightBytes(): number {
    return this.inFlight
  }

  get queued(): number {
    return this.waiters.length
  }

  /**
   * Reserve `bytes` of the budget. The returned release is idempotent. When
   * `signal` aborts while the caller is queued, the waiter is rejected and
   * removed, and the waiters behind it are reconsidered.
   */
  async acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.capacityBytes) {
      throw new RangeError(`a body of ${bytes} bytes cannot fit a budget of ${this.capacityBytes}`)
    }
    if (signal?.aborted) throw new RequestLimitError('body admission was aborted')
    if (this.waiters.length === 0 && this.inFlight + bytes <= this.capacityBytes) {
      return this.take(bytes)
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new RequestLimitError('body admission queue is full')
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index === -1) return
        this.waiters.splice(index, 1)
        reject(new RequestLimitError('body admission was aborted'))
        this.drain()
      }
      const waiter: BodyWaiter = {
        bytes,
        grant: release => {
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private take(bytes: number): () => void {
    this.inFlight += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= bytes
      this.drain()
    }
  }

  /** Grant queued bodies in arrival order while the head of the queue fits. */
  private drain(): void {
    while (this.waiters.length > 0 && this.inFlight + this.waiters[0]!.bytes <= this.capacityBytes) {
      const waiter = this.waiters.shift()!
      waiter.grant(this.take(waiter.bytes))
    }
  }
}
