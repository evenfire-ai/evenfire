import { LIMITS as CONTRACT_LIMITS } from '@clerum/grok-provider-attempt-contract'

export const STREAM_LIMITS = {
  maxConcurrentStreams: 8,
  maxQueuedRequests: 16,
  maxStreamDurationMs: 1_800_000,
  // Longest time a request may wait for a stream slot. Bounded so that queue
  // wait + redeem + the first keepalive stays below the Host HTTP client's
  // 300 s header timeout.
  maxQueueWaitMs: 60_000,
  // Longest silence tolerated while waiting on the upstream (response headers
  // or the next SSE chunk). Matches the Grok Build inference idle timeout.
  upstreamIdleTimeoutMs: 600_000,
} as const

// Largest delay setTimeout honors; Node fires anything above it after 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647

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
  // Without a valid maximum, Math.min below would return NaN for a valid
  // request deadline instead of refusing it.
  if (!Number.isInteger(maxDeadlineMs) || maxDeadlineMs <= 0) {
    throw new RequestLimitError('deadline is invalid')
  }
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
  ) {
    // setTimeout fires after 1 ms for any delay above 2^31 - 1, which would
    // refuse every queued waiter at once instead of after the configured wait.
    if (!Number.isInteger(maxQueueWaitMs) || maxQueueWaitMs <= 0 || maxQueueWaitMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`maxQueueWaitMs must be an integer in 1..${MAX_TIMER_DELAY_MS}`)
    }
  }

  /**
   * Take a stream slot. When `signal` aborts (client disconnected) while the
   * caller is still queued, the waiter is rejected and its queue slot freed, so
   * a dropped client never proceeds to redeem an attempt. A waiter still
   * queued after `maxQueueWaitMs` is rejected the same way, on its own timer:
   * a slot that frees after the bound and before the next poll does not admit it.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RequestLimitError('stream request was aborted')
    if (this.running >= this.maxConcurrent) {
      if (this.queued >= this.maxQueued) throw new RequestLimitError('stream queue is full')
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
            reject(new RequestLimitError('stream request was aborted'))
          }
          const deadline = setTimeout(() => {
            settle()
            reject(new RequestLimitError('stream queue wait exceeded'))
          }, this.maxQueueWaitMs)
          const wait = () => {
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
}

export const streamGate = new StreamGate()
