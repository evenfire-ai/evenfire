import { LIMITS as CONTRACT_LIMITS } from '@clerum/grok-provider-attempt-contract'

/**
 * #731 — room for the runtime envelope around the contract-capped `request`:
 * the execution ticket (a few KB by its claim bounds), the request hash, the
 * deadline and the JSON keys. 16 KiB is several times that.
 */
export const ENVELOPE_ALLOWANCE_BYTES = 16 * 1024

/**
 * The default body limit, derived from the contract so the proxy never refuses,
 * as a 413, a request the contract accepts.
 */
export const DEFAULT_MAX_BODY_BYTES = CONTRACT_LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES

/**
 * #731 R3-2 — how many maximum-size bodies may be read and parsed at once.
 * Several copies of a body are alive while it is parsed and hashed (the raw
 * buffer, the decoded string, the parsed object, the contract copy and the
 * canonical serialization). Without this bound the stream gate would let 24
 * bodies in. Measured with three 8 MiB bodies in flight, the process peaked at
 * 230-252 MiB of RSS with an uncapped heap and at 249-292 MiB with
 * `--max-old-space-size=384` (one run per mode). The capped run went past the
 * former 256Mi limit and the uncapped one came within 4 MiB of it, which is
 * why the deployment sets that cap and a 768Mi memory limit.
 */
export const IN_FLIGHT_BODY_BUDGET_BODIES = 3

/** The deployed admission budget in bytes: about 24 MiB of declared bodies. */
export const IN_FLIGHT_BODY_BUDGET_BYTES = IN_FLIGHT_BODY_BUDGET_BODIES * DEFAULT_MAX_BODY_BYTES

export const STREAM_LIMITS = {
  maxConcurrentStreams: 8,
  maxQueuedRequests: 16,
  maxStreamDurationMs: 300_000,
} as const

export class RequestLimitError extends Error {
  readonly code = 'provider_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'RequestLimitError'
  }
}

export function assertBoundedDeadline(
  deadlineMs: number | undefined,
  maxDeadlineMs: number
): number {
  const requested = deadlineMs ?? Math.min(maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs)
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('deadline is invalid')
  }
  return Math.min(
    requested,
    maxDeadlineMs,
    STREAM_LIMITS.maxStreamDurationMs,
    CONTRACT_LIMITS.maxDeadlineMs
  )
}

export class StreamGate {
  private running = 0
  private queued = 0

  constructor(
    private readonly maxConcurrent: number = STREAM_LIMITS.maxConcurrentStreams,
    private readonly maxQueued: number = STREAM_LIMITS.maxQueuedRequests
  ) {}

  /**
   * Take a stream slot. When `signal` aborts (client disconnected) while the
   * caller is still queued, the waiter is rejected and its queue slot freed, so
   * a dropped client never proceeds to redeem an attempt.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RequestLimitError('stream request was aborted')
    if (this.running >= this.maxConcurrent) {
      if (this.queued >= this.maxQueued) throw new RequestLimitError('stream queue is full')
      this.queued += 1
      try {
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
}

export const streamGate = new StreamGate()

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
