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
