import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DECISION_ADMISSION_RETRY_MAX_PENDING,
  DecisionAdmissionRetryQueue,
} from '../src/decisionAdmissionRetry.js'

const APPROVAL_ID = '99999999-8888-7777-6666-555555555555'
const HOLDER = { providerUserId: 'U123', decision: 'approve' as const }

function approvalId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

describe('decision admission retry queue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the retry once, exactly after the wait', async () => {
    const queue = new DecisionAdmissionRetryQueue()
    const run = vi.fn()

    expect(queue.schedule(APPROVAL_ID, HOLDER, 7, run)).toBe('scheduled')
    expect(queue.size).toBe(1)
    expect(queue.pending(APPROVAL_ID)).toEqual(HOLDER)

    await vi.advanceTimersByTimeAsync(6_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledOnce()
    expect(queue.size).toBe(0)
    expect(queue.pending(APPROVAL_ID)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledOnce()
  })

  it('removes the entry before the runner is called', async () => {
    const queue = new DecisionAdmissionRetryQueue()
    let pendingSeenByRunner: unknown = 'not called'
    queue.schedule(APPROVAL_ID, HOLDER, 1, () => {
      pendingSeenByRunner = queue.pending(APPROVAL_ID)
    })

    await vi.advanceTimersByTimeAsync(1_000)

    expect(pendingSeenByRunner).toBeUndefined()
  })

  it.each([0, 61, 1.5, Number.NaN])('rejects a wait of %s seconds', seconds => {
    const queue = new DecisionAdmissionRetryQueue()
    const run = vi.fn()

    expect(() => queue.schedule(APPROVAL_ID, HOLDER, seconds, run)).toThrow(RangeError)
    expect(queue.size).toBe(0)
  })

  it('keeps one retry per approval and runs the first runner', async () => {
    const queue = new DecisionAdmissionRetryQueue()
    const first = vi.fn()
    const second = vi.fn()

    expect(queue.schedule(APPROVAL_ID, HOLDER, 5, first)).toBe('scheduled')
    expect(
      queue.schedule(
        `  ${APPROVAL_ID.toUpperCase()} `,
        { providerUserId: 'U999', decision: 'deny' },
        5,
        second
      )
    ).toBe('already_pending')
    expect(queue.size).toBe(1)
    expect(queue.pending(APPROVAL_ID)).toEqual(HOLDER)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
  })

  it('refuses a retry beyond the bound and accepts one again after a retry fires', async () => {
    const queue = new DecisionAdmissionRetryQueue()
    const runners = Array.from({ length: DECISION_ADMISSION_RETRY_MAX_PENDING }, () => vi.fn())
    runners.forEach((run, index) => {
      expect(queue.schedule(approvalId(index), HOLDER, index === 0 ? 1 : 30, run)).toBe('scheduled')
    })
    expect(queue.size).toBe(64)

    const overflow = vi.fn()
    expect(queue.schedule(approvalId(64), HOLDER, 1, overflow)).toBe('full')
    expect(queue.size).toBe(64)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(runners[0]).toHaveBeenCalledOnce()
    expect(queue.schedule(approvalId(64), HOLDER, 1, overflow)).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(overflow).toHaveBeenCalledOnce()
  })

  it('cancels every armed retry and returns the count', async () => {
    const cancelled = new DecisionAdmissionRetryQueue()
    const witness = new DecisionAdmissionRetryQueue()
    const cancelledRuns = [vi.fn(), vi.fn()]
    const witnessRun = vi.fn()
    cancelled.schedule(approvalId(1), HOLDER, 10, cancelledRuns[0]!)
    cancelled.schedule(approvalId(2), HOLDER, 20, cancelledRuns[1]!)
    witness.schedule(approvalId(1), HOLDER, 10, witnessRun)

    expect(cancelled.cancelAll()).toBe(2)
    expect(cancelled.size).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)

    // Liveness witness: the same schedule without cancellation runs.
    expect(witnessRun).toHaveBeenCalledOnce()
    expect(cancelledRuns[0]).not.toHaveBeenCalled()
    expect(cancelledRuns[1]).not.toHaveBeenCalled()
  })

  it('refuses every schedule after close', async () => {
    const queue = new DecisionAdmissionRetryQueue()
    const armed = vi.fn()
    const late = vi.fn()
    queue.schedule(approvalId(1), HOLDER, 5, armed)

    expect(queue.close()).toBe(1)
    expect(queue.schedule(approvalId(2), HOLDER, 5, late)).toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(queue.size).toBe(0)
    expect(armed).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
  })
})
