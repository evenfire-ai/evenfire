import { describe, expect, it, vi } from 'vitest'
import { runChatSwitchRequest } from '../chatSwitchRequest'

// Admission, cancellation and navigation precedence belong to the controller:
// switchFeedbackDecision.r12, switchExecutionLifecycle.r12 and switchJoinRevision.r12.
// This helper owns only execution feedback and the raw rejection contract.
describe('switch feedback executor contract', () => {
  it('does not consult error ownership after success', async () => {
    const current = vi.fn(() => true)
    const report = vi.fn()
    const execute = vi.fn(async () => undefined)
    await expect(runChatSwitchRequest(execute, current, report)).resolves.toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(current).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves the rejection with current=%s', async current => {
    const error = new Error('original failure')
    const report = vi.fn()
    const isCurrent = vi.fn(() => current)
    const execute = vi.fn(async () => {
      throw error
    })
    const request = runChatSwitchRequest(execute, isCurrent, report)
    const observers = await Promise.allSettled([request, request])
    expect(observers).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(isCurrent).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(current ? 1 : 0)
    if (current) expect(report).toHaveBeenCalledWith(error)
  })
})
