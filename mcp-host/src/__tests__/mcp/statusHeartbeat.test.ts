import { describe, expect, it, vi } from 'vitest'
import type { McpStatusRefreshSummary } from '../../mcp/manager'
import { McpStatusHeartbeat } from '../../mcp/statusHeartbeat'

function metrics() {
  return {
    runStarted: vi.fn<() => void>(),
    runSkipped: vi.fn<() => void>(),
    runFinished: vi.fn<(summary: McpStatusRefreshSummary) => void>(),
    runErrored: vi.fn<(aborted: boolean) => void>(),
  }
}

const summary = {
  serverCount: 1,
  succeeded: 1,
  failed: 0,
  toolCount: 2,
  outputSchemaCount: 1,
  aborted: false,
}

describe('McpStatusHeartbeat', () => {
  it('defers its first tick and passes a bounded round signal to the current refresher', async () => {
    vi.useFakeTimers()
    const refreshAllServerStatus = vi
      .fn<(options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<typeof summary>>()
      .mockResolvedValue(summary)
    const observedMetrics = metrics()
    const heartbeat = new McpStatusHeartbeat({
      intervalMs: 30_000,
      timeoutMs: 25_000,
      getRefresher: () => ({ refreshAllServerStatus }),
      metrics: observedMetrics,
    })

    heartbeat.start()
    expect(refreshAllServerStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)

    expect(refreshAllServerStatus).toHaveBeenCalledWith({
      timeoutMs: 25_000,
      signal: expect.any(AbortSignal),
    })
    expect(observedMetrics.runStarted).toHaveBeenCalledTimes(1)
    expect(observedMetrics.runFinished).toHaveBeenCalledWith(summary)
    heartbeat.stop()
    vi.useRealTimers()
  })

  it('never overlaps rounds, aborts the active round on idempotent stop, and leaves transports untouched', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const refreshAllServerStatus = vi.fn<
      (options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<typeof summary>
    >(() => new Promise<typeof summary>(resolve => (release = () => resolve(summary))))
    const observedMetrics = metrics()
    const heartbeat = new McpStatusHeartbeat({
      intervalMs: 10,
      timeoutMs: 100,
      getRefresher: () => ({ refreshAllServerStatus }),
      metrics: observedMetrics,
    })

    heartbeat.start()
    await vi.advanceTimersByTimeAsync(0)
    const signal = refreshAllServerStatus.mock.calls[0]?.[0].signal as AbortSignal
    await vi.advanceTimersByTimeAsync(40)
    expect(refreshAllServerStatus).toHaveBeenCalledTimes(1)
    expect(observedMetrics.runSkipped).toHaveBeenCalled()

    heartbeat.stop()
    heartbeat.stop()
    expect(signal.aborted).toBe(true)
    release?.()
    await vi.runAllTimersAsync()
    expect(refreshAllServerStatus).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('classifies a thrown (non-aborted) round as errored, not completed', async () => {
    vi.useFakeTimers()
    const refreshAllServerStatus = vi
      .fn<(options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<typeof summary>>()
      .mockRejectedValue(new Error('tracker exploded'))
    const observedMetrics = metrics()
    const onError = vi.fn<(error: unknown) => void>()
    const heartbeat = new McpStatusHeartbeat({
      intervalMs: 30_000,
      timeoutMs: 25_000,
      getRefresher: () => ({ refreshAllServerStatus }),
      metrics: observedMetrics,
      onError,
    })

    heartbeat.start()
    await vi.advanceTimersByTimeAsync(0)

    // A genuine throw is a failed round, never a silent 'completed' — the
    // idle-memory gate (#148) relies on runs_total distinguishing the two.
    expect(observedMetrics.runErrored).toHaveBeenCalledWith(false)
    expect(observedMetrics.runFinished).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    heartbeat.stop()
    vi.useRealTimers()
  })
})
