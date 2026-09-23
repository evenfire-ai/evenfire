import { LIMITS as CONTRACT_LIMITS } from '@clerum/llm-provider-attempt-contract'

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
 * The 256Mi pod cannot hold the ordinary 8-stream gate across a 24 MiB image,
 * so those requests are a tighter sibling and a V2 request keeps the slot
 * until the stream ends. Small bodies, including every valid V1, must not
 * enter this gate. Do not raise proxy memory to widen it.
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
