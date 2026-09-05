import { LIMITS as CONTRACT_LIMITS } from '@clerum/llm-provider-attempt-contract'

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

export function assertBoundedDeadline(deadlineMs: number | undefined, maxDeadlineMs: number): number {
  const requested = deadlineMs ?? Math.min(maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs)
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
    throw new RequestLimitError('deadline is invalid')
  }
  return Math.min(requested, maxDeadlineMs, STREAM_LIMITS.maxStreamDurationMs, CONTRACT_LIMITS.maxDeadlineMs)
}

export class StreamGate {
  private running = 0
  private queued = 0

  constructor(
    private readonly maxConcurrent = STREAM_LIMITS.maxConcurrentStreams,
    private readonly maxQueued = STREAM_LIMITS.maxQueuedRequests
  ) {}

  async acquire(): Promise<() => void> {
    if (this.running >= this.maxConcurrent) {
      if (this.queued >= this.maxQueued) throw new RequestLimitError('stream queue is full')
      this.queued += 1
      try {
        await new Promise<void>(resolve => {
          const wait = () => {
            if (this.running < this.maxConcurrent) {
              resolve()
              return
            }
            setTimeout(wait, 10)
          }
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
