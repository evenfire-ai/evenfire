import {
  ENVELOPE_ALLOWANCE_BYTES as CONTRACT_ENVELOPE_ALLOWANCE_BYTES,
  LIMITS as CONTRACT_LIMITS,
} from '@clerum/grok-provider-attempt-contract'

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
 * Several copies of a body are alive while it is parsed and hashed (the raw
 * buffer, the decoded string, the parsed object, the contract copy and the
 * canonical serialization). Without this bound the stream gate would let 24
 * bodies in.
 * Bodies over the ordinary cap never take this budget: they are V2 visual
 * envelopes, bounded by `visualStreamGate` instead. With eight 8 MiB streams
 * and three queued 8 MiB bodies (#739 D5) the process peaked at 511 MiB of
 * RSS with `--max-old-space-size=384` (#739 measured 509.8) and at 480-511
 * MiB with an uncapped heap. That is past the former 256Mi limit, which is why the deployment sets
 * that cap. The full load the gates admit adds one visual stream; see
 * `VISUAL_STREAM_LIMITS` for that peak and the memory limit it sets.
 */
export const IN_FLIGHT_BODY_BUDGET_BODIES = 3

/**
 * R9-M-B — how long a body that holds a budget reservation may take to be
 * read and parsed. The clock starts when the reservation is granted, so time
 * spent queued does not count, and stops when the parser finishes. Measured on
 * the Codex twin over loopback, an 8 MiB body is read in 7.6-22.6 ms alone and
 * in under 60 ms with three at once, so 10 s only cuts a body that has
 * stalled. Without it a stalled body keeps its reservation until Node's 300 s
 * `requestTimeout`. The wait before the grant is bounded separately, by the
 * request's admission clock (`STREAM_LIMITS.maxQueueWaitMs` from arrival,
 * #739 D1). Not env-tunable.
 */
export const BODY_READ_DEADLINE_MS = 10_000

export const STREAM_LIMITS = {
  maxConcurrentStreams: 8,
  maxQueuedRequests: 16,
  maxStreamDurationMs: 1_800_000,
  // Longest total time a request may spend queued in this proxy: one
  // admission clock from arrival bounds the body budget, the visual gate and
  // the stream gate together (#739 D1), so a visual request that waits at both
  // gates still waits at most this long in total. Bounded so that queue wait +
  // redeem + the first keepalive stays below the Host HTTP client's 300 s
  // header timeout.
  maxQueueWaitMs: 60_000,
  // Longest silence tolerated while waiting on the upstream (response headers
  // or the next SSE chunk). Same value as the Grok Build CLI default,
  // `inference_idle_timeout_secs = 600` in the default config embedded in the
  // grok-build 1.0.41 macOS binary (read with `strings`, 2026-09-23). The CLI
  // source is not public, so no file and line can be cited.
  upstreamIdleTimeoutMs: 600_000,
} as const

/**
 * Admission for a body whose Content-Length exceeds the ordinary cap. A V2
 * request keeps its image bytes resident until the upstream stream ends, and
 * a 35 MiB envelope is more than four ordinary bodies, so those requests take
 * a 1-wide sibling of the 8-wide stream gate and keep the slot for the
 * stream. Small bodies, including every valid V1, must not enter this gate.
 * Measured with the full load the gates admit (the D5 load above plus one
 * ~36 MB V2 stream: a 20 MiB PNG and 8 MiB of text; tsc build, one process,
 * `--max-old-space-size=384`, upstream request through undici), the process
 * peaked at 775 MiB of RSS, against 511 MiB for D5 alone. The deployment's
 * 1Gi memory limit is that peak plus 25 %, rounded up; widening this gate or
 * the ordinary body budget needs a new memory measurement first.
 */
export const VISUAL_STREAM_LIMITS = {
  maxConcurrentStreams: 1,
  maxQueuedRequests: 4,
} as const

/**
 * Fair share of the visual gate's entries — running plus queued — that one
 * platform principal (`sub` plus sorted `hostRefs`) may hold at once. Above the
 * share, further visual requests from that principal are refused 503
 * `provider_unavailable` with log reason `visual_host_share`, so one principal
 * cannot fill a gate that every other host still needs. The gate widths above
 * are unchanged; the share only bounds how much of them one principal occupies.
 */
export const VISUAL_PER_HOST_MAX_ADMITTED = 2

// Largest delay setTimeout honors; Node fires anything above it after 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Why a wait was refused. `deadline` means the caller's own deadline ended
 * the wait, so a caller that passed the ticket's expiry as that deadline can
 * tell a dead ticket from a full queue without reading the clock again: the
 * deadline timer can fire a millisecond before `Date.now()` reaches it.
 */
export type RequestLimitKind =
  | 'aborted'
  | 'deadline'
  | 'invalid'
  | 'queue_full'
  | 'queue_wait'
  | 'ticket_life'

export class RequestLimitError extends Error {
  readonly code = 'provider_unavailable'
  constructor(
    message: string,
    readonly kind: RequestLimitKind
  ) {
    super(message)
    this.name = 'RequestLimitError'
  }
}

/**
 * #739 D1-bis — the execution ticket expired while its request still waited
 * for a stream slot. Redeeming it could only end in `ticket_expired`, so the
 * request is refused as a capacity limit instead, before any redeem. It is a
 * RequestLimitError on the wire (503 `provider_unavailable`); the attempt
 * failure metric counts it as `provider_unavailable`, not `request_limit`.
 */
export class TicketLifeError extends RequestLimitError {
  constructor() {
    super('execution ticket expired while queued', 'ticket_life')
    this.name = 'TicketLifeError'
  }
}

export function assertBoundedDeadline(
  deadlineMs: number | undefined,
  maxDeadlineMs: number
): number {
  // Without a valid maximum, Math.min below would return NaN for a valid
  // request deadline instead of refusing it.
  if (!Number.isInteger(maxDeadlineMs) || maxDeadlineMs <= 0) {
    throw new RequestLimitError('deadline is invalid', 'invalid')
  }
  const requested = deadlineMs ?? Math.min(maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs)
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('deadline is invalid', 'invalid')
  }
  return Math.min(
    requested,
    maxDeadlineMs,
    STREAM_LIMITS.maxStreamDurationMs,
    CONTRACT_LIMITS.maxDeadlineMs
  )
}

export function assertBoundedIdleTimeout(idleTimeoutMs: number | undefined): number {
  const requested = idleTimeoutMs ?? STREAM_LIMITS.upstreamIdleTimeoutMs
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('upstream idle timeout is invalid', 'invalid')
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
  ) {
    // A NaN or fractional size would let every caller through or queue
    // without bound, because the comparisons below would never hold.
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer')
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError('maxQueued must be a non-negative integer')
    }
    // setTimeout turns NaN, 0, a negative delay or one above 2^31 - 1 into a
    // 1 ms timer, which would refuse every queued waiter at once instead of
    // after the configured wait. Fractions are refused so the bound stays a
    // whole number of milliseconds.
    if (
      !Number.isInteger(maxQueueWaitMs) ||
      maxQueueWaitMs <= 0 ||
      maxQueueWaitMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(`maxQueueWaitMs must be an integer in 1..${MAX_TIMER_DELAY_MS}`)
    }
  }

  /**
   * Take a stream slot. When `signal` aborts (client disconnected) while the
   * caller is still queued, the waiter is rejected and its queue slot freed, so
   * a dropped client never proceeds to redeem an attempt. A waiter still
   * queued after `maxQueueWaitMs`, or at `deadlineAt` (epoch ms) when that
   * comes first, is rejected the same way (#739 D1). The bound is fixed when
   * the caller queues, as the smaller of the two, and measured on the
   * monotonic clock from then on. A deadline timer settles the waiter at the
   * bound, and a poll that runs after the bound checks the elapsed wait before
   * the slot count, so a slot that frees after the bound does not admit it
   * even when the event loop stalled across the bound. A free slot is granted
   * at once whatever the deadline; the caller checks a deadline already past.
   */
  async acquire(signal?: AbortSignal, deadlineAt?: number): Promise<() => void> {
    if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
      throw new RangeError(`a stream gate deadline must be a finite epoch time, got ${deadlineAt}`)
    }
    if (signal?.aborted) throw new RequestLimitError('stream request was aborted', 'aborted')
    if (this.running >= this.maxConcurrent) {
      if (this.queued >= this.maxQueued)
        throw new RequestLimitError('stream queue is full', 'queue_full')
      this.queued += 1
      try {
        await new Promise<void>((resolve, reject) => {
          let poll: ReturnType<typeof setTimeout> | undefined
          const settle = () => {
            if (poll !== undefined) clearTimeout(poll)
            clearTimeout(deadline)
            signal?.removeEventListener('abort', onAbort)
          }
          const onAbort = () => {
            settle()
            reject(new RequestLimitError('stream request was aborted', 'aborted'))
          }
          const queuedAt = performance.now()
          const waitBoundMs =
            deadlineAt === undefined
              ? this.maxQueueWaitMs
              : Math.min(this.maxQueueWaitMs, deadlineAt - Date.now())
          // The caller's deadline governs only when it is the nearer bound.
          const deadlineGoverns = deadlineAt !== undefined && waitBoundMs < this.maxQueueWaitMs
          const expire = () => {
            settle()
            reject(
              new RequestLimitError(
                'stream queue wait exceeded',
                deadlineGoverns ? 'deadline' : 'queue_wait'
              )
            )
          }
          const deadline = setTimeout(expire, Math.max(0, waitBoundMs))
          const wait = () => {
            // After the event loop stalls, a poll and the deadline can both be
            // overdue, and Node runs the poll first because it was due first.
            if (performance.now() - queuedAt >= waitBoundMs) {
              expire()
              return
            }
            if (this.running < this.maxConcurrent) {
              settle()
              resolve()
              return
            }
            poll = setTimeout(wait, 10)
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
  ) {
    // The same standard as StreamGate: a NaN capacity would queue every body
    // until the queue is full, and an infinite one would admit every body.
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError('capacityBytes must be a positive integer')
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError('maxQueued must be a non-negative integer')
    }
  }

  get inFlightBytes(): number {
    return this.inFlight
  }

  get queued(): number {
    return this.waiters.length
  }

  /**
   * Reserve `bytes` of the budget. The returned release is idempotent. When
   * `signal` aborts while the caller is queued, the waiter is rejected and
   * removed, and the waiters behind it are reconsidered. A waiter still queued
   * at `deadlineAt` (epoch ms, the request's admission deadline, #739 D1) is
   * rejected and removed the same way, so a large body at the head of the
   * queue cannot hold back the smaller ones behind it past that instant.
   */
  async acquire(bytes: number, signal?: AbortSignal, deadlineAt?: number): Promise<() => void> {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.capacityBytes) {
      throw new RangeError(`a body of ${bytes} bytes cannot fit a budget of ${this.capacityBytes}`)
    }
    if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
      throw new RangeError(
        `a body admission deadline must be a finite epoch time, got ${deadlineAt}`
      )
    }
    if (signal?.aborted) throw new RequestLimitError('body admission was aborted', 'aborted')
    if (this.waiters.length === 0 && this.inFlight + bytes <= this.capacityBytes) {
      return this.take(bytes)
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new RequestLimitError('body admission queue is full', 'queue_full')
    }
    return new Promise<() => void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      const leave = (reason: string, kind: RequestLimitKind) => {
        const index = this.waiters.indexOf(waiter)
        if (index === -1) return
        this.waiters.splice(index, 1)
        clearTimeout(deadline)
        signal?.removeEventListener('abort', onAbort)
        reject(new RequestLimitError(reason, kind))
        this.drain()
      }
      const onAbort = () => leave('body admission was aborted', 'aborted')
      const waiter: BodyWaiter = {
        bytes,
        grant: release => {
          clearTimeout(deadline)
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
      if (deadlineAt !== undefined) {
        deadline = setTimeout(
          () => leave('body admission wait exceeded', 'deadline'),
          Math.max(0, deadlineAt - Date.now())
        )
      }
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
    while (
      this.waiters.length > 0 &&
      this.inFlight + this.waiters[0]!.bytes <= this.capacityBytes
    ) {
      const waiter = this.waiters.shift()!
      waiter.grant(this.take(waiter.bytes))
    }
  }
}
