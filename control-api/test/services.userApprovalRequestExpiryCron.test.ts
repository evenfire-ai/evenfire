import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startExpiryCron, stopExpiryCron } from '../src/services/userApprovalRequestExpiryCron.js'
import { expirePendingRequests } from '../src/services/userApprovalRequestService.js'

vi.mock('../src/services/userApprovalRequestService.js', () => ({
  expirePendingRequests: vi.fn(),
}))

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

describe('userApprovalRequestExpiryCron', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    stopExpiryCron()
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  afterEach(() => {
    stopExpiryCron()
    vi.useRealTimers()
  })

  it('calls expirePendingRequests on interval', () => {
    vi.mocked(expirePendingRequests).mockResolvedValue(0)
    startExpiryCron(60_000)

    vi.advanceTimersByTime(60_000)
    expect(expirePendingRequests).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    expect(expirePendingRequests).toHaveBeenCalledTimes(2)
  })

  it('logs when requests are expired', async () => {
    vi.mocked(expirePendingRequests).mockResolvedValue(3)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    startExpiryCron(60_000)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Expired 3 pending approval request')
    )
    consoleSpy.mockRestore()
  })

  it('logs a heartbeat even when no approvals expire', async () => {
    vi.mocked(expirePendingRequests).mockResolvedValue(0)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    startExpiryCron(60_000)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Sweep complete'))
    consoleSpy.mockRestore()
  })

  it('does not stack intervals on double start', () => {
    vi.mocked(expirePendingRequests).mockResolvedValue(0)
    startExpiryCron(60_000)
    startExpiryCron(60_000)

    vi.advanceTimersByTime(60_000)
    expect(expirePendingRequests).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly', async () => {
    vi.mocked(expirePendingRequests).mockResolvedValue(0)
    startExpiryCron(60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    const callsBeforeStop = vi.mocked(expirePendingRequests).mock.calls.length
    stopExpiryCron()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.mocked(expirePendingRequests).mock.calls.length).toBe(callsBeforeStop)
  })
})
