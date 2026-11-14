/**
 * One in-memory background retry per workflow approval for Slack and Teams
 * decisions that the MCP Host refused with its admission limit (429 with a
 * matching `Retry-After`). The webhook was already acknowledged, so the
 * provider does not present the click again; the retry is sent once, after
 * the Host's wait. Pending retries live only in this process: a restart drops
 * them, and the approval stays pending.
 */

export const DECISION_ADMISSION_RETRY_MAX_PENDING = 64

/** Error code of the MCP Host's direct service admission refusal (429). */
export const HOST_ADMISSION_LIMITED_ERROR = 'runtime_service_admission_limited'

/**
 * The Host's wait in seconds when a decision or enrollment result is its
 * admission refusal, as recognised by mcpHostClient.ts; undefined otherwise.
 */
export function hostAdmissionRetryAfter(result: {
  status?: number
  error?: string
  retryAfterSeconds?: number
}): number | undefined {
  return result.status === 429 && result.error === HOST_ADMISSION_LIMITED_ERROR
    ? result.retryAfterSeconds
    : undefined
}

export type DecisionRetryHolder = {
  providerUserId: string
  decision: 'approve' | 'deny'
}

export type DecisionRetryScheduleResult = 'scheduled' | 'already_pending' | 'full' | 'closed'

type PendingDecisionRetry = {
  holder: DecisionRetryHolder
  timer: ReturnType<typeof setTimeout>
}

function retryKey(approvalRequestId: string): string {
  return approvalRequestId.trim().toLowerCase()
}

export class DecisionAdmissionRetryQueue {
  private readonly pendingRetries = new Map<string, PendingDecisionRetry>()
  private closed = false

  constructor(private readonly maxPending = DECISION_ADMISSION_RETRY_MAX_PENDING) {}

  get size(): number {
    return this.pendingRetries.size
  }

  /** Who armed the retry for this approval, or undefined when none is armed. */
  pending(approvalRequestId: string): DecisionRetryHolder | undefined {
    const entry = this.pendingRetries.get(retryKey(approvalRequestId))
    return entry ? { ...entry.holder } : undefined
  }

  /**
   * Arms one timer that runs `run` once after `retryAfterSeconds`. The entry
   * is removed before `run` is called, so the runner's own result can never
   * find its approval still armed.
   */
  schedule(
    approvalRequestId: string,
    holder: DecisionRetryHolder,
    retryAfterSeconds: number,
    run: () => void
  ): DecisionRetryScheduleResult {
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 60) {
      throw new RangeError('retryAfterSeconds must be an integer from 1 to 60')
    }
    if (this.closed) return 'closed'
    const key = retryKey(approvalRequestId)
    if (this.pendingRetries.has(key)) return 'already_pending'
    if (this.pendingRetries.size >= this.maxPending) return 'full'
    const timer = setTimeout(() => {
      this.pendingRetries.delete(key)
      run()
    }, retryAfterSeconds * 1000)
    this.pendingRetries.set(key, { holder: { ...holder }, timer })
    return 'scheduled'
  }

  /** Clears every armed timer; returns how many were cleared. */
  cancelAll(): number {
    const cancelled = this.pendingRetries.size
    for (const entry of this.pendingRetries.values()) clearTimeout(entry.timer)
    this.pendingRetries.clear()
    return cancelled
  }

  /** Clears every armed timer and refuses later schedules (shutdown). */
  close(): number {
    this.closed = true
    return this.cancelAll()
  }
}

export const decisionAdmissionRetries = new DecisionAdmissionRetryQueue()
